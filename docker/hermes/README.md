# docker/hermes — containerized Hermes

The managed deployment for [Hermes Agent](https://hermes-agent.org/): a hardened
container run in parallel with the OpenClaw gateway, with secrets supplied by
**host-side 1Password** — your interactive `op` session never enters the container.
(One narrow, opt-in exception: a read-only, Hermes-vault-scoped Service Account
token is passed in so a skill can read live, rotating credentials — see *In-container
`op`* in [`../../docs/hermes-agent.md`](../../docs/hermes-agent.md).) This is the one
supported shape on this host (bare `~/.hermes` install is
a throwaway-experiment escape hatch only). Background and the hard coexistence
constraints: [`../../docs/hermes-agent.md`](../../docs/hermes-agent.md).

## Files

| File | Role |
|---|---|
| `Dockerfile` | bakes the Hermes install (code/venv) + a skill toolkit (`op`, `python3`+`requests`+`beautifulsoup4`, `jq`) into `hermes:local`; **no secrets baked** (the `op` token arrives at runtime) |
| `hermes-entrypoint.sh` | asserts `OPENROUTER_API_KEY` is present (redacted), then `exec`s Hermes |
| `hermes.env.tpl` | **`op://` references only** (safe to commit); the resolved file is tmpfs-only |
| `provision-1password.sh` | create the Hermes-only vault + OpenRouter key item from a signed-in `op` session |
| `materialize-hermes-secrets.sh` | host-side `op inject` → tmpfs env-file (refuses non-tmpfs) |
| `docker-compose.yml` | volume for `/data` state, `env_file` for secrets, rootfs/cap/pids/mem hardening |
| `hermes.service` | user systemd unit; `ExecStartPre` materializes secrets into `%t` (tmpfs) |
| `backup-hermes-data.sh` | snapshot the `hermes-data` volume (memory + learned skills) to a tgz |
| `audit/collect-signals.sh` | no-LLM productivity-audit report (gaps, self-authored skills, errors) for the [`hermes-productivity-audit`](../../skills/hermes-productivity-audit/SKILL.md) skill |

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

Your **interactive** `op` session stays on the host; the container receives only
the resolved values for its own vault, as process env — the same least-privilege
boundary OpenClaw enforces with per-agent runtime-secret snapshots. The lone
exception is the opt-in in-container `op`: a **read-only, Hermes-vault-scoped**
Service Account token is passed in so a skill can read live, rotating credentials
(e.g. O'Reilly session tokens). That token can read every item in the Hermes vault
but **nothing outside it** (`op vault list` inside the container shows only
`Hermes`), which is why the vault stays Hermes-only. A compromised skill still
cannot reach your `op` session, the host, OpenClaw, or any other vault.

## Persistence — keep the `hermes-data` volume

Hermes' persistent memory and agent-generated skills live in the `hermes-data`
volume (`/data`). It survives restarts and image upgrades but **not** `docker volume
rm`. Keep it, and back it up with `./backup-hermes-data.sh`. Full notes
("Persistence, memory & growth" and the cheap-default / escalate-to-Fugu model
strategy) are in [`../../docs/hermes-agent.md`](../../docs/hermes-agent.md).
