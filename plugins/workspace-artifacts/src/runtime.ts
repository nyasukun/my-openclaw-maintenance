// Dynamic-artifact runtime: lifecycle + reverse proxy for the gateway plugin.
//
// The plugin proxies `${ROUTE_PREFIX}/run/<id>/…` (HTTP + WebSocket) to a single
// long-lived `openclaw-artifacts-runtime` container. The in-container supervisor
// (runtime/supervisor.mjs) parses `<id>` from the *full* original path and lazily
// starts the artifact, so the proxy here is path-transparent: we forward req.url
// unchanged to 127.0.0.1:<hostPort>.
//
// Security: the container is launched with no secret snapshot, non-root, all caps
// dropped, resource limits, and the supervisor port published to loopback only.

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export const RUN_SEGMENT = "run";
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CONTAINER_NAME = "openclaw-artifacts-runtime";

export type RuntimeConfig = {
  enabled: boolean;
  dockerBin: string;
  image: string;
  hostPort: number;
  egress: boolean;
};

const DEFAULTS: RuntimeConfig = {
  enabled: true,
  dockerBin: "docker",
  image: "openclaw-artifacts-runtime:0.1.0",
  hostPort: 7080,
  egress: true,
};

export function resolveRuntimeConfig(pluginConfig: Record<string, unknown> | undefined): RuntimeConfig {
  const raw = (pluginConfig?.["runtime"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v.trim() : d);
  return {
    enabled: bool(raw["enabled"], DEFAULTS.enabled),
    dockerBin: str(raw["dockerBin"], DEFAULTS.dockerBin),
    image: str(raw["image"], DEFAULTS.image),
    hostPort: num(raw["hostPort"], DEFAULTS.hostPort),
    egress: bool(raw["egress"], DEFAULTS.egress),
  };
}

/** Parse `<id>` out of a route suffix `/run/<id>/…`. Returns null when absent/invalid. */
export function parseRunId(suffix: string): string | null {
  const segments = suffix.split("/").filter(Boolean);
  if (segments[0] !== RUN_SEGMENT) return null;
  const id = segments[1];
  if (!id || !ID_RE.test(id)) return null;
  return id;
}

type Logger = { info: (m: string) => void; warn: (m: string) => void };

function runDocker(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    proc.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function runtimeDir(): string {
  // dist/runtime.js -> ../runtime (Dockerfile, supervisor.mjs, package.json)
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function healthOk(hostPort: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: hostPort, path: "/__health", method: "GET", timeout: 1500 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export type RuntimeMounts = { artifactsDir: string; canvasDir: string };

let ensurePromise: Promise<void> | null = null;

/** Idempotently build (if needed) and start the runtime container, then wait for health. */
export function ensureRuntimeContainer(
  cfg: RuntimeConfig,
  mounts: RuntimeMounts,
  logger: Logger,
): Promise<void> {
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    if (!cfg.enabled) throw new Error("Dynamic artifact runtime is disabled (runtime.enabled=false).");
    const docker = cfg.dockerBin;

    // Already running?
    const inspect = await runDocker(docker, ["inspect", "-f", "{{.State.Running}}", CONTAINER_NAME]);
    if (inspect.code === 0 && inspect.stdout.trim() === "true" && (await healthOk(cfg.hostPort))) return;

    // Remove any stale container (stopped, or unhealthy).
    if (inspect.code === 0) await runDocker(docker, ["rm", "-f", CONTAINER_NAME]);

    // Build the image if it is not present.
    const imageInspect = await runDocker(docker, ["image", "inspect", cfg.image]);
    if (imageInspect.code !== 0) {
      logger.info(`Building artifacts runtime image ${cfg.image}…`);
      const build = await runDocker(docker, ["build", "-t", cfg.image, runtimeDir()]);
      if (build.code !== 0) throw new Error(`docker build failed: ${build.stderr || build.stdout}`);
    }

    await fs.mkdir(mounts.artifactsDir, { recursive: true });
    await fs.mkdir(mounts.canvasDir, { recursive: true });

    const args = [
      "run", "-d",
      "--name", CONTAINER_NAME,
      "--restart", "unless-stopped",
      "--user", "1000:1000",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "512",
      "--memory", "2g",
      "--memory-swap", "2g",
      "--cpus", "2",
      "--tmpfs", "/tmp",
      "--network", cfg.egress ? "bridge" : "none",
      "-p", `127.0.0.1:${cfg.hostPort}:7000`,
      "-v", `${mounts.artifactsDir}:/workspace/artifacts:rw`,
      "-v", `${mounts.canvasDir}:/workspace/canvas:rw`,
      cfg.image,
    ];
    logger.info(`Starting artifacts runtime container on 127.0.0.1:${cfg.hostPort} (egress=${cfg.egress}).`);
    const run = await runDocker(docker, args);
    if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr || run.stdout}`);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await healthOk(cfg.hostPort)) return;
      await sleep(400);
    }
    throw new Error("artifacts runtime container did not become healthy in time");
  })().catch((err) => {
    ensurePromise = null; // allow retry on next request
    throw err;
  });
  return ensurePromise;
}

/** Forward an HTTP request to the runtime container, preserving the full path. */
export function proxyHttp(req: IncomingMessage, res: ServerResponse, hostPort: number): void {
  const proxyReq = http.request(
    { host: "127.0.0.1", port: hostPort, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(`Artifacts runtime unreachable: ${err.message}`);
    } else {
      res.destroy();
    }
  });
  req.pipe(proxyReq);
}

/** Forward a WebSocket upgrade to the runtime container. */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, hostPort: number): void {
  const upstream = net.connect(hostPort, "127.0.0.1", () => {
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
}
