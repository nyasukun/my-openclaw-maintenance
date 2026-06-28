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
  interactive session, so give it a **read-only 1Password Service Account token
  scoped to the Hermes-only vault** (`--vault 'Hermes:read_items'`). This same
  token is also passed into the container for live in-container reads (see
  [In-container `op`](#in-container-op-live-credential-reads) below) — so scope it
  to the single Hermes vault, read-only, and nothing else:

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

## In-container `op` (live credential reads)

Some secrets **rotate too fast** for materialize-at-start to hold them — e.g.
O'Reilly Learning's session JWT. For those, the image bakes the **1Password CLI**
(`op`) plus a small HTTP/HTML toolkit (`python3` + `requests` + `beautifulsoup4`,
and `jq`) so a self-authored skill can read a fresh value from the Hermes vault on
demand and scrape with it:

```bash
op read "op://Hermes/O'Reilly Learning Session/orm-jwt"   # live, no restart
op read "op://Hermes/O'Reilly Learning Session/orm-rt"
```

**This is a deliberate, narrow exception to the cage.** It needs an `op` credential
inside the container, which the pure-cage model forbids. The exception is bounded
three ways, and only holds if you keep all three:

1. **Only a Service Account token enters — never your interactive `op` session.**
   It rides in through the same tmpfs env-file as every other secret
   (`materialize-hermes-secrets.sh` appends `OP_SERVICE_ACCOUNT_TOKEN` when set);
   the image stays token-free.
2. **Read-only, single-vault scope.** Create it with
   `op service-account create hermes-runtime --vault 'Hermes:read_items'`. Inside
   the container `op vault list` then shows **only** the Hermes vault — that empty
   result for any other vault *is* the scope proof.
3. **The Hermes vault stays Hermes-only.** The token can read every item in it, so
   it must never hold an ★1 Azabu / ★2 foxcale or OpenClaw credential (constraint 1).

Provision the O'Reilly item with `provision-1password.sh` (prompts for the two
tokens, hidden). The field labels must be **exactly** `orm-jwt` / `orm-rt` or the
`op://` references above won't resolve. The `orm-jwt`/`orm-rt` cookies are
**HttpOnly** (page JS can't read them), so grab the values by hand: logged in to
learning.oreilly.com, open DevTools → Application → Cookies →
`https://learning.oreilly.com` and copy the Value of each row.

**Verify** (rebuilt image + token injected; runs as the non-root `hermes` user and
must exit 0):

```bash
docker compose exec -T hermes bash -lc \
  'python3 -c "import requests, bs4" && jq --version && op --version && echo deps-ok'
docker compose exec -T hermes op vault list   # only "Hermes" — no other vault is visible
```

## Web search

The interactive/gateway model is `openrouter/owl-alpha:online`. The `:online`
suffix turns on **OpenRouter's server-side web search** (Exa engine): the model
searches — and reads the resulting pages — only when it needs to, ~$0.005 per
search, billed through OpenRouter with **no extra API keys**. This is the primary
web capability and covers both search and page extraction. (Hermes has no config
switch for the OpenRouter web plugin; the `:online` model suffix is the way in, and
it passes straight through.)

Hermes' own `web_search` tool is also wired to the keyless `ddgs` (DuckDuckGo)
provider (the `ddgs` package is baked into the image) as a free local fallback.
Cron/background stays on plain `openrouter/owl-alpha` (no `:online`) so automated
turns don't incur search cost.

Key-based web providers (exa/tavily/firecrawl/parallel) are intentionally **not**
wired — `:online` already gives high-quality search + page read without managing
another secret. To switch to one later, add its key to `hermes.env.tpl` and set
`web.search_backend` / `web.extract_backend`.

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
scopes the switch to that conversation. The entrypoint also preconfigures a `/moa`
preset (`fugu`) pointing at `sakana/fugu-ultra`, so **`/moa <question>`** runs a
single turn through Fugu Ultra and **auto-restores** the default afterward — no
`/model` toggle needed.

## Autonomy & external productivity audit

Hermes runs with **full autonomy inside the sandbox**: `HERMES_YOLO_MODE=1` and
`HERMES_ACCEPT_HOOKS=1` (compose) make the gateway agent bypass dangerous-command
approval and auto-accept shell hooks — it executes tools and self-authors skills
without prompting. This is deliberate: **the container is the cage.** Read-only
rootfs, `cap_drop: ALL`, no host/OpenClaw reach, and only a **read-only,
single-vault Service Account token** (never your interactive `op` session) reaches
it — so the blast radius is the container + `/data` + outbound network + read-only
access to the Hermes vault's items. (Egress is currently open — restrict it at the
compose/iptables layer if you ever want to bound that too.) The one expansion vs.
the pure cage is in-container `op` (below): it widens the secret reach from "the
values in `hermes.env.tpl`" to "every item in the Hermes vault, read-only," which
is why that vault must stay Hermes-only.

Because the rootfs is read-only, Hermes **cannot evolve its own image** — new
packages/tools only persist if baked into the Dockerfile. So capability growth is a
**supervised loop**: Hermes runs free; periodically an external auditor (Claude Code
or Codex on the host) reviews how it's doing and proposes image/config/skill updates
as a **PR** — never an unattended redeploy. Run it on demand:

```bash
docker/hermes/audit/collect-signals.sh        # no-LLM: gaps, self-authored skills, errors
# then drive the audit with the skill (Claude Code / Codex):
#   "use the hermes-productivity-audit skill"
```

The [`hermes-productivity-audit`](../skills/hermes-productivity-audit/SKILL.md) skill
encodes the rules: translate capability gaps → Dockerfile/config changes, verify the
build, open a PR with the apply steps, and **keep the cage intact** (read-only,
secret boundary, `/data` preserved). A human reviews, merges, then rebuilds/redeploys.

## Remote gateway for the Hermes Desktop app

The **Hermes Desktop** (Electron) app can attach to this container as a remote
backend. It connects to Hermes' web server (`hermes dashboard`, port **9119**), which
shares the same `/data` (memory, skills, sessions) as the messaging gateway.

This is **opt-in** (compose profile `dashboard`) because it opens an inbound,
authenticated endpoint — a deliberate exception to the otherwise inbound-free cage.
The dashboard exposes config/API-keys/sessions/agent control, so it is **tailnet-only
+ authenticated**, never a public bind:

- The image **builds the dashboard web UI** into `hermes_cli/web_dist` (the package
  ships source only), so `hermes dashboard --skip-build` serves it on the read-only
  rootfs.
- The `hermes-dashboard` service binds `0.0.0.0:9119` inside the container (required
  for Docker port publish) → the dashboard **forces basic-auth**. The entrypoint
  derives `dashboard.basic_auth` from `HERMES_DASHBOARD_PASSWORD` (injected from
  1Password — no credential in the image/repo). Published to **host loopback only**
  (`127.0.0.1:9119`); reach it from the laptop via **`tailscale serve`** (TLS,
  tailnet-only). The container stays on the isolated bridge network (no host reach).

Setup:

1. Run `provision-1password.sh` — it **auto-generates** the dashboard password into
   the Hermes vault (item `dashboard`, field `password`); you never type one. Then add
   `HERMES_DASHBOARD_PASSWORD=op://Hermes/dashboard/password` to `hermes.env.tpl`
   (only after the item exists) and materialize. Copy the password from 1Password for
   the Desktop login.
2. Start it: `docker compose --profile dashboard up -d hermes-dashboard`.
3. Expose over Tailscale (host): `tailscale serve --bg --https 443 127.0.0.1:9119`
   → `https://<host>.<tailnet>.ts.net`.
4. In Hermes Desktop on the laptop (same tailnet), set the remote backend URL to that
   `https://…ts.net` and log in with username `hermes` + the password.

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
