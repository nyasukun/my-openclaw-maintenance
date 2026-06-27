# Hermes Agent — containerized, run in parallel with OpenClaw

[Hermes Agent](https://hermes-agent.org/) (Nous Research, MIT, self-hosted) is the
**second** agent stack this repository maintains, run **in parallel** with the
OpenClaw gateway on the same host. Hermes is a persistent, self-improving personal
agent (memory + skill creation + multi-platform gateway) that executes its own
generated code — so on this host it is **always deployed as a hardened container
with host-side 1Password secret injection**. That is the one supported shape; bare
`hermes` on the host is only a throwaway experiment (see the appendix), never the
managed deployment.

The deploy artifacts live in [`docker/hermes/`](../docker/hermes/)
([README](../docker/hermes/README.md)). Like everything else here, they are
**deployed out to the live host**, not run from this repo. This document is the
source-of-truth runbook; nothing Hermes-specific is checked in beyond docs, the
container build, and `op://`-reference templates (never a secret value).

## Coexistence model — two stacks, one host

| | OpenClaw | Hermes |
|---|---|---|
| Install root | `~/.openclaw/` + this repo's deployed copies | container image `hermes:local`; state in the `hermes-data` volume |
| Process / service | user systemd `openclaw-gateway.service` | container via user systemd `hermes.service` (compose) |
| Front door | `router-agent` → concern lanes over Telegram/Slack | `docker compose exec hermes hermes` (CLI); optional gateway |
| LLM inference | single `openrouter` provider (per-agent exec keyRef) | OpenRouter, its **own** key |
| Secrets | 1Password exec provider, per-vault per-agent snapshots | host-side `op` → tmpfs env-file → container process env |

The two stacks share **only the host and the OpenRouter upstream**. Their control
planes, tokens, and secret stores stay disjoint.

## Hard coexistence constraints

This host enforces ★1 Azabu / ★2 foxcale GitHub-token isolation across disjoint
1Password vaults (see [agent authz & vault model](agent-authz-vault-model.md)).
Hermes knows nothing about that model, so the burden is on the operator:

1. **Hermes gets its own disjoint 1Password vault.** Disjoint from the ★1 Azabu and
   ★2 foxcale vaults and from OpenClaw's per-agent items. Its OpenRouter key and any
   bot tokens live only there.
2. **Never reuse OpenClaw's OpenRouter key or bot tokens.** A shared bot token makes
   Hermes and OpenClaw's `router-agent` double-receive the same platform; a shared
   OpenRouter key tangles billing and revocation. Issue new, Hermes-only credentials.
3. **Do not run `hermes claw migrate` blindly.** It imports OpenClaw personas,
   memories, skills, **and API keys** into Hermes' single store — collapsing the
   ★1/★2 vault separation. If you ever migrate, hand-select what crosses; never the
   secrets.
4. **Keep Hermes out of the repo's secret surface and OpenClaw's.** Only `op://`
   reference templates are committed; resolved secrets are tmpfs-only. Never add
   Hermes to OpenClaw's `vault-access-map.json` / its tests — it is a separate store.

## How it works — container + host-side 1Password

Hermes has no native `op` support, so the **host's** `op` resolves the Hermes-only
vault into a tmpfs env-file, which compose loads as the container's process env. The
1Password token and the resolved secret values **never enter the image or the
`/data` state volume** — only the values for Hermes' own vault reach the process.
This mirrors OpenClaw's per-agent runtime-secret snapshots: a compromised
self-generated Hermes skill can't pivot to a 1Password token or read beyond its own
scope.

Properties baked into `docker/hermes/`:

- **State vs secrets split** — `HERMES_HOME=/data` is the `hermes-data` named volume
  (sessions, skills, memory — Hermes is stateful, so this persists); secrets arrive
  only as process env and are never written to the volume or the image.
- **Hardening** — `read_only` rootfs, `cap_drop: ALL`, `no-new-privileges`,
  `pids_limit`, `mem_limit`, tmpfs scratch, and **no inbound ports** (the gateway is
  outbound-polling).
- **Host-side materialize** — `materialize-hermes-secrets.sh` runs `op inject` over
  `hermes.env.tpl` (only `op://` references, safe to commit) into the per-user tmpfs
  runtime dir, refusing to write onto a persistent filesystem. The user systemd unit
  runs it as `ExecStartPre`, self-contained so it never defaults to a removable path
  (cf. the gateway-restart vault-map landmine).

## Deploy

One-time:

1. Create the **Hermes-only** 1Password vault (e.g. `Hermes`) per constraint 1, and
   add the Hermes-only OpenRouter key as `op://Hermes/openrouter/credential` (and,
   only if you run the gateway, new bot tokens). `provision-1password.sh` does this
   for you from a signed-in `op` session (vault + key item, key read from stdin);
   point the `op://` paths in `hermes.env.tpl` at whatever vault/item you use.
2. Set the model id: edit `HERMES_MODEL` in `docker/hermes/docker-compose.yml` to a
   real OpenRouter model (`openrouter/<provider>/<model>`).
3. Build the image: `cd docker/hermes && docker compose build`.

`op inject` resolves **every** reference in `hermes.env.tpl`, including ones on
`#`-commented lines, and it does not write the reference scheme in prose — keep only
references you actually want resolved in that file.

The host-side `op` must be authenticated when secrets are materialized:

- **Managed service (unattended):** a systemd `--user` `ExecStartPre` has no
  interactive session, so give it a **1Password Service Account token scoped to the
  Hermes-only vault**. The token lives host-side only and never enters the container:

  ```bash
  mkdir -p ~/.config/hermes
  printf 'OP_SERVICE_ACCOUNT_TOKEN=%s\n' "ops_..." > ~/.config/hermes/op.env
  chmod 600 ~/.config/hermes/op.env          # the unit loads this via EnvironmentFile
  ```

- **By hand:** an interactive `op signin` session in your shell is enough.

Run it as a managed service (materializes secrets on every start):

```bash
cp docker/hermes/hermes.service ~/.config/systemd/user/hermes.service
systemctl --user daemon-reload && systemctl --user enable --now hermes.service
```

Or by hand (after `op signin`):

```bash
cd docker/hermes
./materialize-hermes-secrets.sh   # host-side op -> tmpfs env-file
docker compose up -d
```

## Operate

```bash
docker compose exec hermes hermes      # interactive CLI
docker compose logs -f hermes          # gateway logs
```

The optional messaging gateway is the container's default command; it runs only
with the **new, Hermes-only** bot tokens from `hermes.env.tpl`. Leave those
commented out to run CLI-only and avoid any chance of double-receiving a platform
OpenClaw already polls.

## Maintain

```bash
cd docker/hermes
docker compose build --pull            # upgrade Hermes (rebuild the image)
docker compose up -d                   # restart onto the new image
```

`docker compose exec hermes hermes doctor` diagnoses configuration from inside.

## Rollback / uninstall

```bash
systemctl --user disable --now hermes.service   # if installed
cd docker/hermes && docker compose down
docker volume rm hermes_hermes-data             # destroys Hermes state — be sure
docker image rm hermes:local
```

OpenClaw is untouched by any of this; Hermes is confined to its image, the
`hermes-data` volume, and the tmpfs secret file.

## Appendix — bare install (throwaway only)

For a quick local trial **outside** the managed deployment, the upstream installer
puts Hermes under `~/.hermes` and reads secrets from process env or `~/.hermes/.env`:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
source ~/.bashrc && hermes doctor && hermes setup   # choose OpenRouter, Hermes-only key
```

This is not how this host runs Hermes — it has no container hardening and no
host-side 1Password boundary. Use it only to evaluate, then remove `~/.hermes`,
`~/.local/bin/hermes`, and the PATH line added to your rc files.

## Sources

- https://hermes-agent.org/ — product overview, features, requirements.
- `NousResearch/hermes-agent` README + `install.sh` + env-var reference — install
  behaviour, directory layout, gateway, env-only/headless config, `hermes claw
  migrate`.
