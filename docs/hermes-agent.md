# Hermes Agent — install & parallel operation with OpenClaw

[Hermes Agent](https://hermes-agent.org/) (Nous Research, MIT, self-hosted) is the
**second** agent stack this repository maintains, run **in parallel** with the
OpenClaw gateway on the same host. Hermes is a persistent, self-improving personal
agent (memory + skill creation + multi-platform gateway). It is **not** an OpenClaw
plugin: it installs under `~/.hermes`, ships its own CLI (`hermes`) and its own
optional messaging gateway, and is driven through the same single OpenRouter
provider this host already standardised on (see
[OpenRouter consolidation](openrouter-consolidation.md)).

Like everything else here, Hermes is **deployed out to the live host**, not run from
this repo. This document is the source-of-truth runbook; nothing Hermes-specific is
checked in beyond docs and (optionally) skill sources.

## Coexistence model — two stacks, one host

| | OpenClaw | Hermes |
|---|---|---|
| Install root | `~/.openclaw/` + this repo's deployed copies | `~/.hermes/` (source at `~/.hermes/hermes-agent`) |
| Process / service | user systemd `openclaw-gateway.service` | `hermes` CLI; optional `hermes gateway` (own systemd unit or `nohup`) |
| Front door | `router-agent` → concern lanes over Telegram/Slack | `hermes` CLI; optional gateway over Telegram/Discord/Slack/WhatsApp/Signal |
| LLM inference | single `openrouter` provider (per-agent exec keyRef) | OpenRouter (its **own** key) |
| Secrets | 1Password exec provider, per-vault per-agent snapshots | Hermes-local store under `~/.hermes` |

The two stacks share **only the host and the OpenRouter upstream**. Keep their
control planes, tokens, and secret stores disjoint.

## Hard coexistence constraints (read before installing)

This host enforces ★1 Azabu / ★2 foxcale GitHub-token isolation across disjoint
1Password vaults (see [agent authz & vault model](agent-authz-vault-model.md)).
Hermes knows nothing about that model, so the burden is on the operator:

1. **Do not run `hermes claw migrate` blindly.** It imports OpenClaw personas,
   memories, skills, **and API keys** into Hermes' single local store. That would
   collapse the ★1/★2 vault separation by pulling cross-concern secrets into one
   place. If you ever migrate, hand-select what crosses over — never the secrets.
2. **Never reuse OpenClaw's bot tokens.** OpenClaw's `router-agent` already polls
   Telegram/Slack. If Hermes' gateway uses the same bot token you get double
   replies and `getUpdates` conflicts. Issue **separate** bot tokens for Hermes, or
   leave the Hermes gateway off and use the `hermes` CLI only.
3. **Give Hermes its own OpenRouter key.** Do not reuse the per-agent
   `openrouter:default` exec keyRef that OpenClaw provisions via `secrets apply`.
   Billing and revocation must stay independent.
4. **Keep Hermes out of the repo's secret surface.** Hermes secrets live in
   `~/.hermes`. `.gitignore` already excludes `.env*` / `.openclaw/`; never commit a
   Hermes key or `~/.hermes` contents.

## Install

Non-root user, Linux. `sudo` is requested only for optional system packages.

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

What the installer does:

- installs `uv` + Python 3.11 (and optionally Node.js 22 + Playwright/Chromium for
  browser tools);
- clones the source to `~/.hermes/hermes-agent`; config/data live under `~/.hermes/`
  (`sessions/`, `logs/`, `skills/`, `cron/`, …);
- symlinks the CLI to `~/.local/bin/hermes` and adds it to PATH via `~/.bashrc`;
- opens **no** listening ports (the gateway is outbound-polling).

Activate and sanity-check:

```bash
source ~/.bashrc
hermes doctor      # diagnose configuration before doing anything else
```

## Configure (OpenRouter)

```bash
hermes setup
```

Choose **OpenRouter** and paste the **Hermes-only** OpenRouter API key. Switch
models without code changes:

```bash
hermes model openrouter:<provider/model>
```

## Run

CLI only (safest first step — touches nothing OpenClaw owns):

```bash
hermes
```

Optional messaging gateway — **only with fresh, non-OpenClaw bot tokens**:

```bash
hermes gateway setup    # configure platforms with NEW tokens
hermes gateway start    # foreground, verify behaviour
hermes gateway install  # install as background service once verified
```

OpenClaw's gateway is `openclaw-gateway.service`; the Hermes unit has a distinct
name, so systemd coexists fine. The only real risk is **double-receiving the same
platform** — avoid it via separate tokens.

## Containerized + 1Password (Option B) — recommended

For fine-grained control of this self-improving, code-executing agent, run Hermes in
a hardened container instead of bare on the host. The deploy artifacts live in
[`docker/hermes/`](../docker/hermes/) ([README](../docker/hermes/README.md)).

The 1Password integration is **Option B**: Hermes has no native `op` support, so the
host's `op` resolves the **Hermes-only vault** into a tmpfs env-file, which compose
loads as the container's process env. The 1Password token and the resolved secret
values never enter the container image or the `/data` state volume — only the values
for Hermes' own vault reach the process, mirroring OpenClaw's per-agent
runtime-secret snapshots. A compromised Hermes skill thus can't pivot to a token or
read beyond its own scope.

Key properties baked into `docker/hermes/`:

- **State vs secrets split** — `HERMES_HOME=/data` is a named volume (sessions,
  skills, memory — Hermes is stateful, so this persists); secrets arrive only as
  process env and are never written to the volume or the image.
- **Hardening** — `read_only` rootfs, `cap_drop: ALL`, `no-new-privileges`,
  `pids_limit`, `mem_limit`, tmpfs scratch, and **no inbound ports** (the gateway is
  outbound-polling).
- **Host-side materialize** — `materialize-hermes-secrets.sh` runs `op inject` over
  `hermes.env.tpl` (which holds only `op://` references, safe to commit) into the
  per-user tmpfs runtime dir, refusing to write onto a persistent filesystem. The
  user systemd unit runs it as `ExecStartPre`, self-contained so it never defaults
  to a removable path (cf. the gateway-restart vault-map landmine).

```bash
cd docker/hermes
# adjust the op:// paths in hermes.env.tpl to your Hermes-only vault, then:
docker compose build
./materialize-hermes-secrets.sh && docker compose up -d
docker compose exec hermes hermes        # interactive CLI
```

The hard constraints above still apply: the Hermes vault is disjoint from ★1/★2 and
from OpenClaw's items; Hermes uses its own OpenRouter key and (if the gateway runs)
its own bot tokens.

## Maintain

```bash
hermes update     # upgrade (bare install); for the container: docker compose build --pull
hermes doctor     # diagnose
```

## Rollback / uninstall

Hermes is confined to `~/.hermes`, `~/.local/bin/hermes`, and the PATH line in your
rc files. OpenClaw is untouched by removal.

```bash
# if a gateway service was installed, stop/disable it first (name via `hermes doctor`)
rm -rf ~/.hermes
rm -f ~/.local/bin/hermes
# remove the 'export PATH=...$HOME/.local/bin...' line added to ~/.bashrc (and ~/.profile)
```

## Sources

- https://hermes-agent.org/ — product overview, features, requirements.
- `NousResearch/hermes-agent` README + `install.sh` — install behaviour, directory
  layout, gateway, provider configuration, `hermes claw migrate`.
