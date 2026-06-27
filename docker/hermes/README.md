# docker/hermes — containerized Hermes

The managed deployment for [Hermes Agent](https://hermes-agent.org/): a hardened
container run in parallel with the OpenClaw gateway, with secrets supplied by
**host-side 1Password** — no `op` token and no secret value ever enters the
container. This is the one supported shape on this host (bare `~/.hermes` install is
a throwaway-experiment escape hatch only). Background and the hard coexistence
constraints: [`../../docs/hermes-agent.md`](../../docs/hermes-agent.md).

## Files

| File | Role |
|---|---|
| `Dockerfile` | bakes the Hermes install (code/venv) into `hermes:local`; **no secrets baked** |
| `hermes-entrypoint.sh` | asserts `OPENROUTER_API_KEY` is present (redacted), then `exec`s Hermes |
| `hermes.env.tpl` | **`op://` references only** (safe to commit); the resolved file is tmpfs-only |
| `provision-1password.sh` | create the Hermes-only vault + OpenRouter key item from a signed-in `op` session |
| `materialize-hermes-secrets.sh` | host-side `op inject` → tmpfs env-file (refuses non-tmpfs) |
| `docker-compose.yml` | volume for `/data` state, `env_file` for secrets, rootfs/cap/pids/mem hardening |
| `hermes.service` | user systemd unit; `ExecStartPre` materializes secrets into `%t` (tmpfs) |

## One-time setup

1. Create a **Hermes-only** 1Password vault (e.g. `Hermes`) — disjoint from the ★1
   Azabu / ★2 foxcale vaults and from OpenClaw's per-agent items. Add the
   Hermes-only `OPENROUTER_API_KEY` (and, only if you run the gateway, **new** bot
   tokens). Adjust the `op://` paths in `hermes.env.tpl` to match.
2. Build: `docker compose build`

## Run

```bash
# resolve secrets to tmpfs, then start (detached)
./materialize-hermes-secrets.sh
docker compose up -d

docker compose exec hermes hermes      # interactive CLI
docker compose logs -f hermes          # gateway logs
```

Or manage it as a service: `cp hermes.service ~/.config/systemd/user/ &&
systemctl --user enable --now hermes.service` (materializes secrets on every start).

## Why host-side 1Password

The `op` session stays on the host; the container receives only the resolved
values for its own vault, as process env. A compromised self-generated Hermes skill
therefore cannot pivot to a 1Password token or read beyond what Hermes already
needs — the same least-privilege boundary OpenClaw enforces with per-agent
runtime-secret snapshots.

## Not yet verified on this host

The image build runs the upstream installer non-interactively; first-run behaviour
(env-only config via `HERMES_IGNORE_USER_CONFIG`) hasn't been exercised here.
Validate with `docker compose build` then a CLI smoke test before enabling the
service.
