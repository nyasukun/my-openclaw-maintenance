#!/usr/bin/env node
// Workspace Artifacts runtime supervisor.
//
// Runs inside the long-lived `openclaw-artifacts-runtime` container. It is the
// single upstream the gateway plugin proxies to. For each request under
// `${BASE_PREFIX}/<id>/…` it lazily starts the dynamic artifact living in
// `${ARTIFACTS_ROOT}/<id>`, allocates it a private port, injects PORT/BASE_PATH,
// waits for it to listen, then proxies HTTP and WebSocket traffic to it. Idle
// children are reaped. Zero runtime dependencies — Node core only.
//
// Contract for a dynamic artifact in `artifacts/<id>/`:
//   - if `package.json` exists: `npm ci` (or `npm install`) on first run, then
//     `npm start`. The start script MUST listen on `process.env.PORT`.
//   - else if `server.js` exists: `node server.js`, listening on `PORT`.
// The full original path (including BASE_PATH) is forwarded unchanged, so the
// app is responsible for serving under BASE_PATH (e.g. framework `basePath`).

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SUPERVISOR_PORT = Number(process.env.SUPERVISOR_PORT ?? 7000);
const ARTIFACTS_ROOT = path.resolve(process.env.ARTIFACTS_ROOT ?? "/workspace/artifacts");
const BASE_PREFIX = (process.env.BASE_PREFIX ?? "/plugins/workspace-artifacts/run").replace(/\/+$/, "");
const IDLE_MS = Number(process.env.IDLE_MS ?? 10 * 60 * 1000);
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 180 * 1000);
const LOG_LINES = 200;
const WORKSPACE_ROOT = path.dirname(ARTIFACTS_ROOT);
const VERIFY_POLL_MS = Number(process.env.VERIFY_POLL_MS ?? 1000);

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** @type {Map<string, {proc: import("node:child_process").ChildProcess, port: number, status: "starting"|"ready"|"failed", lastAccess: number, logs: string[], ready: Promise<void>}>} */
const children = new Map();

function log(...args) {
  console.log(`[supervisor] ${args.join(" ")}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function tcpAlive(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse `<id>` from a `${BASE_PREFIX}/<id>/…` pathname. Returns null if absent/invalid. */
export function parseArtifactId(pathname, basePrefix = BASE_PREFIX) {
  if (!pathname.startsWith(basePrefix + "/")) return null;
  const rest = pathname.slice(basePrefix.length + 1);
  const id = rest.split("/")[0].split("?")[0];
  if (!id || !ID_RE.test(id)) return null;
  return id;
}

/** Resolve the artifact directory, guarding against path escapes. */
function resolveArtifactDir(id) {
  const dir = path.resolve(ARTIFACTS_ROOT, id);
  const rel = path.relative(ARTIFACTS_ROOT, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path_escape");
  return dir;
}

function startChild(id) {
  const dir = resolveArtifactDir(id);
  const stat = fs.existsSync(dir) ? fs.statSync(dir) : undefined;
  if (!stat || !stat.isDirectory()) throw new Error(`artifact "${id}" not found`);
  const hasPackageJson = fs.existsSync(path.join(dir, "package.json"));
  const hasServer = fs.existsSync(path.join(dir, "server.js"));
  if (!hasPackageJson && !hasServer) {
    throw new Error(`artifact "${id}" has neither package.json nor server.js`);
  }

  const logs = [];
  const pushLog = (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line) continue;
      logs.push(line);
      if (logs.length > LOG_LINES) logs.shift();
    }
  };

  const record = { proc: undefined, port: 0, status: "starting", lastAccess: Date.now(), logs, ready: undefined };
  record.ready = (async () => {
    const port = await getFreePort();
    record.port = port;
    const hasLock = fs.existsSync(path.join(dir, "package-lock.json"));
    const installCmd = hasLock ? "npm ci" : "npm install";
    const script = hasPackageJson
      ? `if [ ! -d node_modules ]; then ${installCmd}; fi; exec npm start`
      : "exec node server.js";
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: "0.0.0.0",
      HOSTNAME: "0.0.0.0",
      BASE_PATH: `${BASE_PREFIX}/${id}`,
      NODE_ENV: process.env.ARTIFACT_NODE_ENV ?? "development",
    };
    log(`starting "${id}" on :${port} (${hasPackageJson ? "package.json" : "server.js"})`);
    const proc = spawn("sh", ["-c", script], { cwd: dir, env });
    record.proc = proc;
    proc.stdout.on("data", pushLog);
    proc.stderr.on("data", pushLog);
    proc.on("exit", (code, signal) => {
      log(`"${id}" exited code=${code} signal=${signal}`);
      if (record.status !== "ready") record.status = "failed";
      children.delete(id);
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`process exited before listening:\n${logs.slice(-20).join("\n")}`);
      if (await tcpAlive(port)) {
        record.status = "ready";
        log(`"${id}" ready on :${port}`);
        return;
      }
      await sleep(300);
    }
    record.status = "failed";
    proc.kill("SIGTERM");
    throw new Error(`"${id}" did not start within ${READY_TIMEOUT_MS}ms`);
  })().catch((err) => {
    record.status = "failed";
    children.delete(id);
    throw err;
  });

  children.set(id, record);
  return record;
}

async function ensureChild(id) {
  const existing = children.get(id);
  if (existing && existing.status !== "failed") {
    existing.lastAccess = Date.now();
    await existing.ready;
    return existing;
  }
  const record = startChild(id);
  await record.ready;
  record.lastAccess = Date.now();
  return record;
}

function reapIdle() {
  const now = Date.now();
  for (const [id, record] of children) {
    if (now - record.lastAccess > IDLE_MS) {
      log(`reaping idle "${id}"`);
      record.proc?.kill("SIGTERM");
      children.delete(id);
    }
  }
}

// --- Verification (fs-mediated headless render) ---------------------------
//
// An agent (no browser, can't reach the gateway) drops a request file at
// `${ARTIFACTS_ROOT}/<id>/.verify/request.json`; we render the artifact in
// headless Chromium and write `screenshot.png` + `result.json` next to it. Both
// sides share the workspace bind mount, so this is the only reliable channel.

const verifyInFlight = new Set();

/** Resolve a workspace-relative entry to an absolute path, guarding escapes. */
export function resolveWorkspacePath(rel, workspaceRoot = WORKSPACE_ROOT) {
  const abs = path.resolve(workspaceRoot, rel);
  const r = path.relative(workspaceRoot, abs);
  if (r.startsWith("..") || path.isAbsolute(r)) throw new Error("entry escapes workspace");
  return abs;
}

/** Build the render URL for a verify request (pure; exported for tests). */
export function verifyTargetUrl(id, raw, child) {
  if (raw.target === "run") {
    const p = typeof raw.path === "string" && raw.path ? raw.path : "/";
    const suffix = p.startsWith("/") ? p : `/${p}`;
    return `http://127.0.0.1:${child.port}${BASE_PREFIX}/${id}${suffix}`;
  }
  const entry = typeof raw.entry === "string" && raw.entry ? raw.entry : `canvas/${id}/index.html`;
  return "file://" + resolveWorkspacePath(entry);
}

async function processVerify(id, reqPath) {
  verifyInFlight.add(id);
  const verifyDir = path.join(ARTIFACTS_ROOT, id, ".verify");
  try {
    fs.mkdirSync(verifyDir, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(reqPath, "utf8"));
    const target = raw.target === "run" ? "run" : "static";
    const child = target === "run" ? await ensureChild(id) : undefined;
    const url = verifyTargetUrl(id, { ...raw, target }, child);
    log(`verify "${id}" target=${target} url=${url}`);
    const { renderArtifact } = await import("./render.mjs");
    const { screenshot, result } = await renderArtifact({
      url,
      viewport: raw.viewport && typeof raw.viewport === "object" ? raw.viewport : undefined,
      fullPage: raw.fullPage !== false,
      waitUntil: typeof raw.waitUntil === "string" ? raw.waitUntil : undefined,
    });
    fs.writeFileSync(path.join(verifyDir, "screenshot.png"), screenshot);
    fs.writeFileSync(
      path.join(verifyDir, "result.json"),
      JSON.stringify({ ...result, target, renderedAt: new Date().toISOString() }, null, 2),
    );
    log(`verify "${id}" done ok=${result.ok}`);
  } catch (err) {
    try {
      fs.mkdirSync(verifyDir, { recursive: true });
      fs.writeFileSync(
        path.join(verifyDir, "result.json"),
        JSON.stringify(
          { ok: false, error: err instanceof Error ? err.message : String(err), renderedAt: new Date().toISOString() },
          null,
          2,
        ),
      );
    } catch {
      /* best effort */
    }
    log(`verify "${id}" failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      fs.renameSync(reqPath, path.join(verifyDir, "request.handled.json"));
    } catch {
      /* ignore */
    }
    verifyInFlight.delete(id);
  }
}

function scanVerify() {
  let entries;
  try {
    entries = fs.readdirSync(ARTIFACTS_ROOT, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory()) continue;
    const id = dirent.name;
    if (!ID_RE.test(id) || verifyInFlight.has(id)) continue;
    const reqPath = path.join(ARTIFACTS_ROOT, id, ".verify", "request.json");
    if (fs.existsSync(reqPath)) processVerify(id, reqPath);
  }
}

function sendError(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(message);
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname === "/" || pathname === "/__health" || pathname === BASE_PREFIX) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("artifacts-runtime ok");
    return;
  }
  const id = parseArtifactId(pathname);
  if (!id) {
    sendError(res, 404, "No artifact id in path.");
    return;
  }
  let child;
  try {
    child = await ensureChild(id);
  } catch (err) {
    sendError(res, 502, `Failed to start artifact "${id}":\n${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  child.lastAccess = Date.now();
  const proxyReq = http.request(
    { host: "127.0.0.1", port: child.port, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    if (!res.headersSent) sendError(res, 502, `Upstream error for "${id}": ${err.message}`);
    else res.destroy();
  });
  req.pipe(proxyReq);
});

server.on("upgrade", async (req, socket, head) => {
  const pathname = (req.url ?? "/").split("?")[0];
  const id = parseArtifactId(pathname);
  if (!id) {
    socket.destroy();
    return;
  }
  let child;
  try {
    child = await ensureChild(id);
  } catch {
    socket.destroy();
    return;
  }
  child.lastAccess = Date.now();
  const upstream = net.connect(child.port, "127.0.0.1", () => {
    let handshake = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const v of value) handshake += `${key}: ${v}\r\n`;
      else if (value !== undefined) handshake += `${key}: ${value}\r\n`;
    }
    handshake += "\r\n";
    upstream.write(handshake);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

setInterval(reapIdle, Math.max(5_000, Math.min(30_000, IDLE_MS))).unref();
setInterval(scanVerify, VERIFY_POLL_MS).unref();

server.listen(SUPERVISOR_PORT, "0.0.0.0", () => {
  log(`listening on :${SUPERVISOR_PORT}, artifacts=${ARTIFACTS_ROOT}, prefix=${BASE_PREFIX}`);
});
