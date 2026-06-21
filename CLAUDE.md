# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is **not an application**. It is the version-controlled source of truth for
maintaining one operator's OpenClaw deployment (a multi-agent gateway fronting
Telegram/Slack). It holds three kinds of artifact, each deployed *out* to a live
host rather than run from here:

- **`config/`** — OpenClaw config patches (JSON) plus the AGENTS.md/SOUL.md lane
  contracts that go with them. These are applied to a live host with
  `openclaw config patch`.
- **`skills/`** — `SKILL.md` files (each a directory with frontmatter + body).
  Deployed copies live under `~/.codex/skills` or OpenClaw's managed skill dir;
  the copies here are authoritative.
- **`plugins/`** — two TypeScript OpenClaw plugins (`workspace-artifacts`,
  `agent-command`) built against the `openclaw` SDK and linked into the gateway.

Because everything is deployed elsewhere, **most files here are data/markdown that
the test suite validates structurally** — there is no app to run locally.

## Commands

Config / contract tests (no install needed, plain Node test runner):

```bash
node --test tests/*.test.mjs                    # all config tests
node --test tests/concern-lanes-config.test.mjs # one file
node --test tests/routing-policy.test.mjs
```

Plugin build + tests (each plugin is self-contained; needs `npm install` first):

```bash
cd plugins/workspace-artifacts   # or plugins/agent-command
npm install
npm run build                    # tsc -p tsconfig.json -> dist/
npm test                         # vitest run
npx vitest run src/index.test.ts # single test file
```

Applying config to a live host (run against the target, not in CI) — always
back up and dry-run first:

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d%H%M%S)
openclaw config patch --file config/openclaw-concern-lanes/openclaw.patch.json --dry-run
openclaw config patch --file config/openclaw-concern-lanes/openclaw.patch.json
openclaw config validate
openclaw gateway restart
```

Regenerate per-agent AGENTS.md boundary blocks on the live host:

```bash
node scripts/sync-agent-workspace-boundaries.mjs
```

## Architecture

### One config design: concern lanes = the operator's five concerns

`config/openclaw-concern-lanes/` is the **single** active design (a prior parallel
`openclaw-agent-project/` draft was folded in and removed). `router-agent` fans
Telegram/Slack ingress to exactly one *concern lane*, where the lanes are the
operator's real concerns:

- `azabu-corporate` — ★1 Azabu corporate ops + `azabu.io` site maintenance
  (holds the Azabu GitHub token).
- `foxcale-advisor` / `foxcale-coding` — ★2 foxcale advisory / repo work
  (`foxcale-coding` holds the foxcale project token).
- `work-cisco` — Cisco partner-SE (no Azabu element, no GitHub token).
- `learning-kb` — self-study. `personal` — personal life admin.

Plus `telegram-fable` (artifact lane), `router-agent` (orchestrator, no domain
credentials), and the system agents `main`/`hard`/`long`/`heartbeat`.
`openclaw.patch.json` is generated *from* the live host; the live host still
carries four removed agents (`coding`, `security-research`, `presales-proposal`,
`infra-ops`) until the next apply (see "Applying config" + ROLLBACK).

**Hard constraints (enforced at the host boundary, see Secrets model):** ★1 and
★2 use different GitHub tokens that must never mix; Cisco work carries no Azabu
element. The whole-system view lives in `docs/agent-system-overview.md`.

### Config-as-data, validated against prose contracts

The tests in `tests/*.test.mjs` are the spec. They read the JSON patch
(`openclaw.patch.json`), the routing policy (`routing-policy.json`), the vault map
(`vault-access-map.json`), **and** the markdown lane contracts
(`lane-contracts/*.AGENTS.md`, `*.SOUL.md`) and assert they agree — e.g. that
`router-agent` denies `sessions_send`, that the Azabu (★1) and foxcale (★2) GitHub
tokens resolve from disjoint vaults and never reach the same agent, that
`work-cisco` holds neither vault, and that specific guarantee sentences appear
verbatim in the contracts (via `assert.match` on regexes). **Editing a contract,
a tool allowlist, or a vault grant almost always means updating the matching
assertion**, and vice versa. The patch JSON, vault map, and contract markdown must
be changed together.

### Router orchestration model

`router-agent` is the only user-facing agent. It broadcasts (or, in concern-lane
mode, routes to exactly one lane) via `sessions_spawn`, streams partial results
back, and synthesizes a final answer. Concern lanes **deny `sessions_send`** and
may only `sessions_spawn` back to `router-agent` (`subagents.allowAgents:
["router-agent"]`), so they cannot form delegation loops (`telegram-fable` denies
both). Agents self-select on broadcast
with `CLAIM` / `CLAIM_PARTIAL` / `NO_CLAIM` and return
`STREAM_UPDATE` / `FINAL_RESULT` / `BLOCKED`; out-of-scope direct handoffs return
a compact `MISROUTE` block. `scripts/sync-agent-workspace-boundaries.mjs`
generates these boundary/orchestration blocks into each workspace's `AGENTS.md`
between HTML-comment markers (it strips and re-inserts the marked region, so hand
edits inside the markers are overwritten).

### Secrets model (never commit values)

Secrets resolve through a 1Password exec provider using namespaced SecretRefs
(`common/<item>/<field>`, `<agent>/<item>/<field>`). Authorization is **per
1Password vault, per agent**: `config/openclaw-concern-lanes/vault-access-map.json`
is the source of truth, and `materialize-runtime-secrets.js` writes a **per-agent**
snapshot (`runtime-secrets/<agent>/local.json`) containing only that agent's
authorized vaults. Each sandbox bind-mounts only its own snapshot read-only at
`/run/openclaw-secrets/local.json`; a `bootstrap-runtime-secrets.sh` setup command
exposes it via `BASH_ENV`. **The ★1 Azabu token (`GITHUB_TOKEN`) and the ★2
foxcale token (`GITHUB_PAT_F_PROJECT`) resolve from disjoint vaults into separate
per-agent snapshots — never grant both to one agent, never add a cross-concern
`vault_fallbacks`, and keep `work-cisco` free of either vault.** The repo only
ever stores **source metadata** (vault/item/field names), never secret values.
Rationale + sources: `docs/agent-authz-vault-model.md`. Do not reintroduce a
single shared snapshot mounted into all sandboxes (`tests/vault-access-map.test.mjs`
guards this, along with the ★1/★2 isolation). Shell snippets must do
redacted checks (`TOKEN=present`, not the value). `.gitignore` excludes
`.openclaw/`, `.env*`, and logs — keep it that way.

### Plugins

TypeScript, ESM, built with `tsc` to `dist/`, tested with `vitest`. They import
from the `openclaw` peer dependency's SDK (`openclaw/plugin-sdk/*`) and register
via `definePluginEntry`. `workspace-artifacts` serves an authenticated
file-browser/preview UI from the gateway under `/plugins/workspace-artifacts`
(note its path-traversal guards in `normalizeRelativePath`). `agent-command`
implements the `/agent` slash command for explicit single-agent routing.

## Conventions

- Config tests use the built-in `node:test` runner and `node:assert/strict` — no
  test framework dependency. Plugin tests use `vitest`.
- There is no root `package.json`; do not add one expecting a monorepo runner.
  Each plugin manages its own deps.
- Skill `SKILL.md` files require YAML frontmatter (`name`, `description`,
  optional `metadata`). Several skills are deliberately generic so the deployed
  copy can be patched with environment-specific URLs (see
  `docs/openclaw-skill-deployment.md`); do not bake host-specific URLs into the
  source here.
