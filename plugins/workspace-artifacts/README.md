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
