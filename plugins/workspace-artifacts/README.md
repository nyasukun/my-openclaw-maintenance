# Workspace Artifacts

OpenClaw Gateway plugin for browsing, previewing, and editing files under the
configured OpenClaw workspace.

The plugin registers a Gateway HTTP route at:

```text
/plugins/workspace-artifacts/
```

It is intended to run behind the existing OpenClaw Gateway exposure, including a
local loopback Gateway or Tailscale Serve.

## Build

```bash
npm install
npm run build
npm test
```

## Install Locally

```bash
npm run build
openclaw plugins install --link "$PWD"
openclaw gateway restart
```

Open the UI at:

```text
http://127.0.0.1:<gateway-port>/plugins/workspace-artifacts/
```

If Tailscale Serve is enabled, replace the local origin with the configured
Tailscale Serve origin.

## Dynamic (Node server) artifacts

Static artifacts are previewed in an iframe. Artifacts that need a running Node
server (Express, Vite/Next dev servers, an API backend) are served through a
managed runtime container instead, at:

```text
/plugins/workspace-artifacts/run/<artifact-id>/
```

A request under that path is reverse-proxied (HTTP **and** WebSocket, so HMR
works) to a single long-lived `openclaw-artifacts-runtime` container. Inside it,
`runtime/supervisor.mjs` lazily starts the artifact in `artifacts/<id>/`:

- if `package.json` exists: `npm ci` (first run) then `npm start`;
- otherwise: `node server.js`.

The app must listen on `process.env.PORT`. The **full** request path (including
the proxy prefix) is forwarded unchanged, so the app must serve under
`process.env.BASE_PATH` (= `/plugins/workspace-artifacts/run/<id>`) — e.g. set a
framework `basePath`/`base` to `BASE_PATH`. Idle apps are stopped automatically.

The container image is built from [`runtime/`](runtime/) (Playwright base, so it
bundles Chromium — see "Visual verification" — making it large, ~1.5GB). It is
started **eagerly** when the plugin loads (so the verify watcher runs even for
static artifacts), and lazily on first `/run/` request as a fallback. The
container runs non-root, with `--cap-drop ALL`, resource limits, **no secret
snapshot**, and the supervisor port published to loopback only — the gateway's
`auth: "plugin"` is the access gate. The workspace `artifacts/` and `canvas/`
dirs are bind-mounted (rw); nothing else. Outbound network is allowed so
`npm ci` can fetch dependencies; set `runtime.egress: false` (and use
`server.js`-only artifacts) for a fully offline posture.

### Visual verification

The agent sandboxes have no browser and cannot reach the gateway, so artifacts
are rendered/verified in the runtime container's headless Chromium, driven over
the shared workspace bind mount:

1. Drop `artifacts/<id>/.verify/request.json` — `{ "target": "static", "entry":
   "canvas/<id>/index.html" }` for a static artifact, or `{ "target": "run",
   "path": "/" }` for a dynamic one.
2. The supervisor renders it (static via `file://`, dynamic via the running app)
   and writes `artifacts/<id>/.verify/screenshot.png` and `result.json`
   (`{ ok, status, title, consoleErrors, pageErrors, failedRequests, finalUrl }`),
   renaming the request to `request.handled.json`.

This is what the `workspace-artifact-builder` skill uses to verify artifacts.

### Config (plugin `runtime` block)

| key | default | meaning |
| --- | --- | --- |
| `runtime.enabled` | `true` | enable the dynamic runtime |
| `runtime.image` | `openclaw-artifacts-runtime:0.1.0` | image tag (built from `runtime/` if absent) |
| `runtime.hostPort` | `7080` | loopback host port the supervisor (`:7000`) is published to |
| `runtime.egress` | `true` | allow outbound network for `npm ci` |
| `runtime.dockerBin` | `docker` | container CLI binary |
