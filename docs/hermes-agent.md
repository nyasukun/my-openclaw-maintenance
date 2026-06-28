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
2. Model: `docker-compose.yml` pins **Owl Alpha** on OpenRouter by default
   (`openrouter/owl-alpha`, free/agentic). `hermes model` is interactive-only and
   can't run in the build, so the default is set via env across all code paths
   (`HERMES_INFERENCE_PROVIDER`/`HERMES_INFERENCE_MODEL` for `-z`/inference,
   `HERMES_MODEL` for cron, `HERMES_TUI_PROVIDER` for chat). Change those to switch
   models.
3. Build the image: `cd docker/hermes && docker compose build`. The image carries
   no Chromium — the build passes `--skip-browser` (Playwright system deps need
   sudo), so `browser`/`computer_use` skills are inactive; add them in a derived
   image if needed. The container runs `hermes gateway run` as its main process and
   idles safely with no messaging platforms configured.

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
docker compose exec hermes hermes                 # interactive chat (TUI)
docker compose exec -T hermes hermes -z "PROMPT"  # one-shot, non-interactive
docker compose exec -T hermes hermes doctor       # config/connectivity check
docker compose logs -f hermes                     # gateway logs
```

The container's main process is the messaging gateway (`hermes gateway run`). With
no bot tokens configured it idles safely (CLI-only). To connect Telegram/Slack/etc.,
see **Messaging gateway** below.

## Messaging gateway (optional)

The gateway connects Hermes to chat platforms (Telegram, Slack, Discord, …). A
platform is **enabled by the presence of its bot-token env var**; without a
per-platform or global allowlist, every user is denied. Tokens are secrets (→
1Password, via `hermes.env.tpl`); user-id allowlists are not (→ compose
`environment:`).

**Hard rule:** create a **new, Hermes-only bot** for each platform. Never reuse
OpenClaw's `router-agent` bot token — a shared token makes both stacks poll the same
bot and double-receive. A separate bot account is fine; it just must be its own.

Env vars (token enables the platform; allowlist is a CSV of user ids):

| Platform | Token env (→ 1Password) | Allowlist env (→ compose) |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN` | `TELEGRAM_ALLOWED_USERS` |
| Slack | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | `SLACK_ALLOWED_USERS` |
| Discord | `DISCORD_BOT_TOKEN` | `DISCORD_ALLOWED_USERS` |
| any | — | `GATEWAY_ALLOWED_USERS` (all platforms) |

Steps (Telegram example):

1. Create a new bot and find your user id, in the Telegram app:
   - Open a chat with **@BotFather** → send `/newbot`.
   - Give it a **display name** (e.g. `Hermes`), then a **username** that must end in
     `bot` (e.g. `yasu_hermes_bot`). This is a brand-new bot, separate from
     OpenClaw's — do not reuse OpenClaw's bot.
   - BotFather replies with the **token**, like `123456789:AAH...`. That is the
     secret for the next step.
   - (optional) `/setprivacy` → *Disable* lets the bot see all group messages;
     leave *Enabled* if you only DM it. `/setdescription`, `/setcommands` as desired.
   - Get your **numeric user id**: message **@userinfobot** (or @RawDataBot); it
     replies with `Id: 123456789`. That is `TELEGRAM_ALLOWED_USERS`.
   - Press **Start** in a chat with your new bot so it is allowed to message you.
2. Store the token in the Hermes-only vault, e.g. item `telegram-hermes`, field
   `token`.
3. Add an **active** reference line to `docker/hermes/hermes.env.tpl` (not a `#`
   comment — `op inject` resolves commented references too and would fail):

   ```
   TELEGRAM_BOT_TOKEN=op://Hermes/telegram-hermes/token
   ```
4. Add the allowlist (non-secret) to `docker-compose.yml` under `environment:`:

   ```yaml
       TELEGRAM_ALLOWED_USERS: "123456789"
   ```
5. Apply — a systemd restart re-materializes secrets and recreates the container
   (ExecStop `down` → ExecStartPre materialize → ExecStart `up`), so it picks up the
   new token and allowlist:

   ```bash
   systemctl --user restart hermes.service
   docker compose exec -T hermes hermes doctor   # platform now present, no allowlist warning
   docker compose logs -f hermes                 # watch it connect
   ```
   (By hand instead: `./materialize-hermes-secrets.sh && docker compose up -d --force-recreate`.)

Then message the bot. Slack/Discord follow the same pattern with their env vars
above (Slack needs both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`).

## Persistence, memory & growth

Hermes is "self-improving": it accumulates **persistent memory** and **agent-generated
skills** over time. On this host all of that lives under `HERMES_HOME=/data`, which is
the **`hermes-data` named volume** — `memories/`, `state.db`, `sessions/`, `skills/`
(incl. the curator's `.curator_state`), `cron/`, `hooks/`. Only `/tmp` and
`XDG_CACHE_HOME` (tmpfs) are ephemeral, and those are pure caches.

So growth **survives container restarts and image upgrades** (`docker compose
build/up` never touches the volume). It does **not** survive deleting the volume.
**Operating rule: keep `hermes-data`.** Never `docker volume rm` it without a backup,
and back it up regularly:

```bash
docker/hermes/backup-hermes-data.sh           # -> ~/hermes-backups/hermes-data-<ts>.tgz
```

Memory is the **built-in** provider (persisted in `/data`); for richer long-term
recall you can later configure an external memory provider, but it is optional.

## Model strategy: cheap default, escalate hard questions

Hermes has **no automatic difficulty-based routing** — the main model answers every
message, and background growth tasks use it too. The default here is **Owl Alpha**
(`openrouter/owl-alpha`, free), pinned via the entrypoint. To get a stronger model on
the *core* questions, escalate **manually** per conversation, in the chat itself:

```text
/model sakana/fugu-ultra --provider openrouter --session   # this thread -> Fugu Ultra
…ask the hard question(s)…
/model openrouter/owl-alpha --provider openrouter          # back to the free default
```

`sakana/fugu-ultra` (Sakana AI) is itself a quality-first multi-step orchestrator —
but it is **paid** (~$5/$30 per M tokens), so escalate deliberately. `--session`
scopes the switch to that conversation. Alternatively configure a one-model `/moa`
preset (`hermes moa configure`) pointing at `sakana/fugu-ultra` and use
`/moa <question>` for a single turn that **auto-restores** the default afterward.

## Maintain

Upgrades keep the `hermes-data` volume (memory + learned skills persist):

```bash
cd docker/hermes
docker compose build --pull            # rebuild the image (volume untouched)
docker compose up -d                   # or: systemctl --user restart hermes.service
```

`docker compose exec hermes hermes doctor` diagnoses configuration from inside.

## Rollback / uninstall

Stop and remove the **container/image** — this **keeps** all state (memory, skills):

```bash
systemctl --user disable --now hermes.service   # if installed
cd docker/hermes && docker compose down         # keeps the hermes-data volume
docker image rm hermes:local                    # optional
```

Destroying state is a **separate, deliberate** step — it **erases Hermes' memory and
all learned skills**. Back up first, and only then:

```bash
docker/hermes/backup-hermes-data.sh             # snapshot before destroying
docker volume rm hermes_hermes-data             # ⚠ wipes memory + learned skills
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
