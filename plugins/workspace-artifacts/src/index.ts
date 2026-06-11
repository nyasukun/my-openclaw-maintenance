import { definePluginEntry, type OpenClawPluginApi, type OpenClawPluginDefinition } from "openclaw/plugin-sdk/core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const PLUGIN_ID = "workspace-artifacts";
const ROUTE_PREFIX = "/plugins/workspace-artifacts";
const MAX_LIST_ENTRIES = 500;
const MAX_TEXT_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 3_000_000;
const MAX_WRITE_BYTES = 1_500_000;

type WorkspaceEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size?: number;
  mtimeMs?: number;
};

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "request_failed",
  ) {
    super(message);
  }
}

function resolveWorkspaceRoot(api: OpenClawPluginApi): string {
  const configured = readPathLike((api.pluginConfig ?? {})["rootPath"])
    ?? readPathLike((api.config as { agents?: { defaults?: { workspace?: unknown; workspaceDir?: unknown } } }).agents?.defaults?.workspace)
    ?? readPathLike((api.config as { agents?: { defaults?: { workspaceDir?: unknown } } }).agents?.defaults?.workspaceDir)
    ?? process.env.OPENCLAW_WORKSPACE
    ?? path.join(os.homedir(), ".openclaw", "workspace");
  return path.resolve(expandHome(configured));
}

function readPathLike(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeRelativePath(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || raw === "." || raw === "/") return "";
  if (path.isAbsolute(raw)) throw new HttpError(400, "Absolute paths are not allowed.", "absolute_path");
  const normalized = path.normalize(raw).replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new HttpError(400, "Path escapes the workspace.", "path_escape");
  }
  return normalized === "." ? "" : normalized;
}

async function resolveExistingPath(root: string, relInput: unknown): Promise<{ rel: string; full: string }> {
  const rel = normalizeRelativePath(relInput);
  assertNotDenied(rel);
  const realRoot = await fs.realpath(root);
  const full = path.resolve(realRoot, rel);
  ensureWithinRoot(realRoot, full);
  const stat = await fs.lstat(full);
  if (stat.isSymbolicLink()) throw new HttpError(403, "Symbolic links are not exposed.", "symlink_blocked");
  const realFull = await fs.realpath(full);
  ensureWithinRoot(realRoot, realFull);
  return { rel, full: realFull };
}

async function resolveWritablePath(root: string, relInput: unknown): Promise<{ rel: string; full: string }> {
  const rel = normalizeRelativePath(relInput);
  if (!rel) throw new HttpError(400, "Choose a file path inside the workspace.", "missing_path");
  assertNotDenied(rel);
  const realRoot = await fs.realpath(root);
  const full = path.resolve(realRoot, rel);
  ensureWithinRoot(realRoot, full);
  const parent = path.dirname(full);
  const realParent = await fs.realpath(parent);
  ensureWithinRoot(realRoot, realParent);
  const existing = await fs.lstat(full).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw new HttpError(403, "Symbolic links are not editable.", "symlink_blocked");
  return { rel, full };
}

function ensureWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new HttpError(403, "Path escapes the workspace.", "path_escape");
}

function assertNotDenied(rel: string): void {
  const segments = rel.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";
  const blockedSegments = new Set([".git", ".config", "node_modules", ".pnpm", ".cache", "dist", "logs"]);
  if (segments.some((segment) => blockedSegments.has(segment))) {
    throw new HttpError(403, "This path is hidden by the workspace policy.", "path_denied");
  }
  if (
    basename === ".git-credentials"
    || basename === ".openclaw-github-env"
    || basename.endsWith(".pem")
    || basename.endsWith(".key")
    || basename === ".env"
    || basename.startsWith(".env.")
    || basename.toLowerCase().includes("secret")
  ) {
    throw new HttpError(403, "This file is hidden by the workspace policy.", "path_denied");
  }
}

async function listDirectory(root: string, relInput: unknown): Promise<{ path: string; entries: WorkspaceEntry[] }> {
  const { rel, full } = await resolveExistingPath(root, relInput);
  const stat = await fs.stat(full);
  if (!stat.isDirectory()) throw new HttpError(400, "Path is not a directory.", "not_directory");
  const dirents = await fs.readdir(full, { withFileTypes: true });
  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents.slice(0, MAX_LIST_ENTRIES)) {
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    try {
      assertNotDenied(childRel);
    } catch {
      continue;
    }
    if (dirent.isSymbolicLink()) continue;
    if (!dirent.isDirectory() && !dirent.isFile()) continue;
    const childFull = path.join(full, dirent.name);
    const childStat = await fs.stat(childFull).catch(() => undefined);
    entries.push({
      name: dirent.name,
      path: childRel,
      type: dirent.isDirectory() ? "directory" : "file",
      size: childStat?.size,
      mtimeMs: childStat?.mtimeMs,
    });
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { path: rel, entries };
}

async function readFile(root: string, relInput: unknown): Promise<Record<string, unknown>> {
  const { rel, full } = await resolveExistingPath(root, relInput);
  const stat = await fs.stat(full);
  if (!stat.isFile()) throw new HttpError(400, "Path is not a file.", "not_file");
  const mime = guessMime(full);
  const textLike = isTextLike(full, mime);
  if (textLike && stat.size <= MAX_TEXT_BYTES) {
    return {
      path: rel,
      name: path.basename(full),
      type: "text",
      mime,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      content: await fs.readFile(full, "utf8"),
    };
  }
  if (mime.startsWith("image/") && stat.size <= MAX_IMAGE_BYTES) {
    const data = await fs.readFile(full);
    return {
      path: rel,
      name: path.basename(full),
      type: "image",
      mime,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dataUrl: `data:${mime};base64,${data.toString("base64")}`,
    };
  }
  return {
    path: rel,
    name: path.basename(full),
    type: "binary",
    mime,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

async function writeFile(root: string, payload: unknown): Promise<Record<string, unknown>> {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const content = typeof body.content === "string" ? body.content : undefined;
  if (content === undefined) throw new HttpError(400, "Missing file content.", "missing_content");
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new HttpError(413, "File is too large for browser editing.", "file_too_large");
  }
  const { rel, full } = await resolveWritablePath(root, body.path);
  await fs.writeFile(full, content, "utf8");
  const stat = await fs.stat(full);
  return { path: rel, size: stat.size, mtimeMs: stat.mtimeMs };
}

async function createDirectory(root: string, payload: unknown): Promise<Record<string, unknown>> {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const { rel, full } = await resolveWritablePath(root, body.path);
  await fs.mkdir(full, { recursive: true });
  return { path: rel };
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".css": "text/css",
    ".csv": "text/csv",
    ".gif": "image/gif",
    ".htm": "text/html",
    ".html": "text/html",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript",
    ".json": "application/json",
    ".md": "text/markdown",
    ".mjs": "text/javascript",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".txt": "text/plain",
    ".webp": "image/webp",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  };
  return map[ext] ?? "application/octet-stream";
}

function isTextLike(filePath: string, mime: string): boolean {
  if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json")) return true;
  return [".toml", ".lock", ".gitignore", ".dockerignore", ".npmrc"].includes(path.extname(filePath).toLowerCase());
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_WRITE_BYTES + 10_000) throw new HttpError(413, "Request body is too large.", "body_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be JSON.", "invalid_json");
  }
}

async function handleRoute(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://openclaw.local");
  const pathname = requestUrl.pathname;
  const suffix = pathname.slice(ROUTE_PREFIX.length) || "/";

  if (req.method === "GET" && (suffix === "/" || suffix === "/index.html")) {
    sendHtml(res, renderAppHtml(root));
    return;
  }
  if (req.method === "GET" && suffix === "/api/tree") {
    sendJson(res, 200, await listDirectory(root, requestUrl.searchParams.get("path")));
    return;
  }
  if (req.method === "GET" && suffix === "/api/file") {
    sendJson(res, 200, await readFile(root, requestUrl.searchParams.get("path")));
    return;
  }
  if (req.method === "PUT" && suffix === "/api/file") {
    sendJson(res, 200, await writeFile(root, await readJsonBody(req)));
    return;
  }
  if (req.method === "POST" && suffix === "/api/directory") {
    sendJson(res, 200, await createDirectory(root, await readJsonBody(req)));
    return;
  }
  sendJson(res, 404, { ok: false, error: "Not found.", code: "not_found" });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

function handleError(res: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof HttpError ? error.code : "internal_error";
  sendJson(res, status, { ok: false, error: message, code });
}

function renderAppHtml(root: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Workspace Artifacts</title>
  <style>
    :root { color-scheme: light dark; --bg: #f7f8fa; --panel: #ffffff; --line: #d8dde5; --text: #20242b; --muted: #697180; --accent: #26715f; --danger: #a83d32; --code: #111827; }
    @media (prefers-color-scheme: dark) { :root { --bg: #16181d; --panel: #20242b; --line: #343b47; --text: #eef1f5; --muted: #a4adbb; --accent: #5fc7a9; --danger: #e07065; --code: #f4f6f8; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, input, textarea { font: inherit; }
    button { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 6px; padding: 7px 10px; cursor: pointer; }
    button:hover { border-color: var(--accent); }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    input { width: 100%; border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 6px; padding: 8px 10px; }
    .app { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
    header { display: grid; grid-template-columns: minmax(180px, 1fr) auto; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
    .title { display: grid; gap: 2px; min-width: 0; }
    .title strong { font-size: 15px; }
    .title span { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; justify-content: end; }
    main { display: grid; grid-template-columns: minmax(220px, 280px) minmax(320px, 1fr) minmax(280px, 38vw); min-height: 0; }
    aside, section { min-height: 0; border-right: 1px solid var(--line); }
    aside { display: grid; grid-template-rows: auto 1fr; background: color-mix(in srgb, var(--panel) 78%, var(--bg)); }
    .pathbar { display: grid; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); }
    .filelist { overflow: auto; padding: 8px; }
    .entry { width: 100%; display: grid; grid-template-columns: 20px 1fr; gap: 8px; align-items: center; border: 0; background: transparent; text-align: left; padding: 7px 8px; }
    .entry.active { background: color-mix(in srgb, var(--accent) 16%, transparent); }
    .entry span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .editor { display: grid; grid-template-rows: auto 1fr auto; background: var(--panel); }
    .filebar { display: grid; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); }
    textarea { width: 100%; height: 100%; resize: none; border: 0; outline: 0; padding: 14px 16px; background: var(--panel); color: var(--code); font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; tab-size: 2; }
    .status { min-height: 34px; padding: 8px 12px; color: var(--muted); border-top: 1px solid var(--line); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preview { display: grid; grid-template-rows: auto 1fr; background: var(--bg); }
    .preview h2 { margin: 0; padding: 12px; font-size: 14px; border-bottom: 1px solid var(--line); }
    .previewbody { overflow: auto; padding: 16px; }
    .previewbody img { max-width: 100%; height: auto; display: block; }
    .previewbody pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
    .previewbody iframe { width: 100%; min-height: calc(100vh - 118px); border: 1px solid var(--line); background: white; }
    .empty { color: var(--muted); display: grid; place-items: center; height: 100%; }
    .error { color: var(--danger); }
    .mobile-switcher { display: none; }
    @media (max-width: 900px) {
      body { height: 100vh; overflow: hidden; }
      .app { height: 100vh; min-height: 100vh; grid-template-rows: auto 1fr; }
      body[data-mobile-view="preview"] .app { grid-template-rows: 1fr; }
      body[data-mobile-view="preview"] header { display: none; }
      header { grid-template-columns: 1fr; gap: 8px; padding: 10px 12px; }
      .title strong { font-size: 14px; }
      .title span { font-size: 12px; }
      .toolbar { display: none; }
      main { position: relative; display: block; min-height: 0; overflow: hidden; }
      aside, section { position: absolute; inset: 0; z-index: 0; display: none !important; border: 0; min-height: 0; }
      aside.mobile-active,
      section.mobile-active { z-index: 1; display: grid !important; }
      aside { grid-template-rows: auto 1fr; }
      .editor { grid-template-rows: auto 1fr auto; }
      .preview { grid-template-rows: auto 1fr; }
      .pathbar, .filebar { padding: 10px; }
      textarea { padding: 12px; font-size: 12px; }
      .preview h2 { padding: 10px 12px; }
      body[data-mobile-view="preview"] .preview h2 { display: none; }
      .previewbody { padding: 0; }
      .previewbody iframe { width: 100%; height: 100%; min-height: 0; border: 0; display: block; }
      .previewbody img { width: 100%; min-height: 100%; object-fit: contain; background: var(--panel); }
      .previewbody pre { padding: 12px; }
      .mobile-switcher {
        position: fixed;
        right: 14px;
        bottom: calc(14px + env(safe-area-inset-bottom));
        z-index: 2147483647;
        display: grid;
        justify-items: end;
        gap: 8px;
      }
      .mobile-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        justify-content: end;
        opacity: 1;
        pointer-events: auto;
        padding: 6px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: color-mix(in srgb, var(--panel) 94%, transparent);
        box-shadow: 0 8px 24px rgba(0,0,0,.24);
        backdrop-filter: blur(10px);
      }
      .mobile-actions button {
        min-width: 42px;
        min-height: 42px;
        border-radius: 999px;
        touch-action: manipulation;
      }
      .mobile-actions button { padding: 0 12px; background: var(--panel); }
      .mobile-actions button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
      #mobileMenu { display: none; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="title"><strong>Workspace Artifacts</strong><span id="root">${escapeHtml(root)}</span></div>
      <div class="toolbar">
        <button id="refresh">Refresh</button>
        <button id="newFile">New file</button>
        <button id="newDir">New folder</button>
        <button id="save" class="primary">Save</button>
      </div>
    </header>
    <main>
      <aside id="filesPanel">
        <div class="pathbar"><input id="dirPath" value="" aria-label="Directory path"><button id="openDir">Open</button></div>
        <div id="filelist" class="filelist"></div>
      </aside>
      <section id="editorPanel" class="editor">
        <div class="filebar"><input id="filePath" value="" aria-label="File path"></div>
        <textarea id="editor" spellcheck="false"></textarea>
        <div id="status" class="status">Ready</div>
      </section>
      <section id="previewPanel" class="preview">
        <h2>Preview</h2>
        <div id="preview" class="previewbody"><div class="empty">Open a file</div></div>
      </section>
    </main>
    <div class="mobile-switcher" id="mobileSwitcher">
      <div class="mobile-actions" aria-label="Mobile view switcher">
        <button id="mobileFiles" type="button">Files</button>
        <button id="mobileEdit" type="button">Edit</button>
        <button id="mobilePreview" type="button">Preview</button>
        <button id="mobileSave" type="button" class="primary">Save</button>
      </div>
      <button id="mobileMenu" type="button" aria-label="Switch view">View</button>
    </div>
  </div>
  <script>
    const api = ${JSON.stringify(ROUTE_PREFIX)};
    const state = { dir: "", file: "", fileType: "text", dirty: false, mobileView: "files" };
    const initialFile = new URLSearchParams(window.location.search).get("file") || "";
    const qs = (id) => document.getElementById(id);
    const status = (text, error = false) => { const el = qs("status"); el.textContent = text; el.className = error ? "status error" : "status"; };

    function setMobileView(view) {
      state.mobileView = view;
      document.body.dataset.mobileView = view;
      const panels = {
        files: qs("filesPanel"),
        edit: qs("editorPanel"),
        preview: qs("previewPanel"),
      };
      for (const [name, panel] of Object.entries(panels)) {
        const active = name === view;
        panel.classList.toggle("mobile-active", active);
        panel.setAttribute("aria-hidden", active ? "false" : "true");
      }
      for (const id of ["mobileFiles", "mobileEdit", "mobilePreview"]) qs(id).classList.remove("active");
      if (view === "files") qs("mobileFiles").classList.add("active");
      if (view === "edit") qs("mobileEdit").classList.add("active");
      if (view === "preview") qs("mobilePreview").classList.add("active");
      qs("mobileSwitcher").classList.remove("open");
    }

    function bindMobileAction(id, action) {
      const button = qs(id);
      let lastPointerAt = 0;
      button.addEventListener("pointerup", (event) => {
        lastPointerAt = Date.now();
        event.preventDefault();
        event.stopPropagation();
        action();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (Date.now() - lastPointerAt < 700) return;
        action();
      });
    }

    async function requestJson(url, options) {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    function parentDir(file) {
      const idx = file.lastIndexOf("/");
      return idx === -1 ? "" : file.slice(0, idx);
    }

    async function loadTree(dir = state.dir) {
      state.dir = dir || "";
      qs("dirPath").value = state.dir;
      const data = await requestJson(api + "/api/tree?path=" + encodeURIComponent(state.dir));
      const list = qs("filelist");
      list.innerHTML = "";
      if (state.dir) {
        const up = document.createElement("button");
        up.className = "entry";
        up.innerHTML = "<span>..</span><span>Parent</span>";
        up.onclick = () => loadTree(parentDir(state.dir));
        list.appendChild(up);
      }
      for (const entry of data.entries) {
        const button = document.createElement("button");
        button.className = "entry" + (entry.path === state.file ? " active" : "");
        button.innerHTML = "<span>" + (entry.type === "directory" ? "D" : "F") + "</span><span></span>";
        button.lastChild.textContent = entry.name;
        button.onclick = () => entry.type === "directory" ? loadTree(entry.path) : openFile(entry.path);
        list.appendChild(button);
      }
    }

    async function openFile(file) {
      if (state.dirty && !confirm("Discard unsaved changes?")) return;
      const data = await requestJson(api + "/api/file?path=" + encodeURIComponent(file));
      state.file = data.path;
      state.fileType = data.type;
      state.dirty = false;
      qs("filePath").value = data.path;
      qs("editor").readOnly = data.type !== "text";
      qs("editor").value = data.type === "text" ? data.content : "";
      renderPreview(data);
      status(data.type === "text" ? "Opened " + data.path : "Preview only: " + data.path);
      await loadTree(parentDir(data.path));
      setMobileView(data.type !== "text" || data.path.endsWith(".html") || data.path.endsWith(".htm") ? "preview" : "edit");
    }

    function renderPreview(data) {
      const preview = qs("preview");
      preview.innerHTML = "";
      if (data.type === "image") {
        const img = document.createElement("img");
        img.src = data.dataUrl;
        preview.appendChild(img);
        return;
      }
      if (data.type === "binary") {
        preview.innerHTML = "<div class='empty'>Binary file</div>";
        return;
      }
      updateTextPreview();
    }

    function updateTextPreview() {
      const preview = qs("preview");
      const file = qs("filePath").value;
      const text = qs("editor").value;
      preview.innerHTML = "";
      if (file.endsWith(".html") || file.endsWith(".htm")) {
        const frame = document.createElement("iframe");
        frame.srcdoc = text;
        preview.appendChild(frame);
        return;
      }
      const pre = document.createElement("pre");
      pre.textContent = text;
      preview.appendChild(pre);
    }

    async function saveFile() {
      const file = qs("filePath").value.trim();
      if (!file) return status("Choose a file path", true);
      await requestJson(api + "/api/file", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: file, content: qs("editor").value }),
      });
      state.file = file;
      state.dirty = false;
      status("Saved " + file);
      await loadTree(parentDir(file));
    }

    qs("editor").addEventListener("input", () => {
      state.dirty = true;
      if (state.fileType === "text") updateTextPreview();
    });
    qs("openDir").onclick = () => loadTree(qs("dirPath").value);
    qs("refresh").onclick = () => loadTree(state.dir).catch((err) => status(err.message, true));
    qs("save").onclick = () => saveFile().catch((err) => status(err.message, true));
    bindMobileAction("mobileSave", () => saveFile().catch((err) => status(err.message, true)));
    bindMobileAction("mobileFiles", () => setMobileView("files"));
    bindMobileAction("mobileEdit", () => setMobileView("edit"));
    bindMobileAction("mobilePreview", () => setMobileView("preview"));
    qs("mobileSwitcher").addEventListener("click", (event) => {
      event.stopPropagation();
    });
    qs("newFile").onclick = () => {
      const name = prompt("Path");
      if (!name) return;
      state.file = name;
      state.fileType = "text";
      state.dirty = true;
      qs("filePath").value = name;
      qs("editor").readOnly = false;
      qs("editor").value = "";
      updateTextPreview();
      status("New file");
      setMobileView("edit");
    };
    qs("newDir").onclick = async () => {
      const name = prompt("Path");
      if (!name) return;
      await requestJson(api + "/api/directory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: name }),
      });
      status("Created " + name);
      await loadTree(parentDir(name));
    };
    window.addEventListener("beforeunload", (event) => {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
    setMobileView(initialFile ? "preview" : "files");
    (initialFile ? openFile(initialFile) : loadTree("")).catch((err) => status(err.message, true));
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: PLUGIN_ID,
  name: "Workspace Artifacts",
  description: "Browse, preview, and edit OpenClaw workspace files from the authenticated Gateway.",
  register(api) {
    const root = resolveWorkspaceRoot(api);
    api.registerHttpRoute({
      path: ROUTE_PREFIX,
      match: "prefix",
      auth: "plugin",
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          await handleRoute(root, req, res);
        } catch (error) {
          api.logger.warn(`Workspace Artifacts request failed: ${error instanceof Error ? error.message : String(error)}`);
          handleError(res, error);
        }
        return true;
      },
    });
    api.session.controls.registerControlUiDescriptor({
      id: "workspace-artifacts",
      surface: "settings",
      label: "Workspace",
      description: "Browse and edit workspace artifacts.",
      placement: "nav",
      requiredScopes: ["operator.read"],
      schema: { url: `${ROUTE_PREFIX}/` },
    });
    api.session.controls.registerSessionAction({
      id: "open-workspace-artifacts",
      description: "Open the Workspace Artifacts browser.",
      requiredScopes: ["operator.read"],
      handler: () => ({
        ok: true,
        result: { url: `${ROUTE_PREFIX}/` },
      }),
    });
  },
});

export default entry;
