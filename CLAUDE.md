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

### Two config rollouts coexist

`config/` contains **two distinct, parallel designs** for the same host. Know
which one you are touching:

- **`openclaw-concern-lanes/`** — the **currently deployed** snapshot. A
  `router-agent` fans Telegram/Slack ingress to one of a few *concern lanes*
  (`security-research`, `presales-proposal`, `infra-ops`, `telegram-fable`).
  `openclaw.patch.json` here is generated *from* the live host.
- **`openclaw-agent-project/`** — an earlier/alternate **purpose-separated**
  design (8 domain agents: `work-cisco`, `azabu-corporate`, `personal`,
  `coding`, `foxcale-advisor`, `foxcale-coding`, `learning-kb`, …). Documented in
  `docs/agent-project-architecture.md`.

When in doubt, the concern-lanes snapshot reflects production.

### Config-as-data, validated against prose contracts

The tests in `tests/*.test.mjs` are the spec. They read the JSON patch
(`openclaw.patch.json`) **and** the markdown lane contracts
(`lane-contracts/*.AGENTS.md`, `*.SOUL.md`) and assert they agree — e.g. that
`router-agent` denies `sessions_send`, that `infra-ops` has the sandbox authority
its contract promises, and that specific guarantee sentences appear verbatim in
the contracts (via `assert.match` on regexes). **Editing a contract or a tool
allowlist almost always means updating the matching assertion**, and vice versa.
The patch JSON and the contract markdown must be changed together.

### Router orchestration model

`router-agent` is the only user-facing agent. It broadcasts (or, in concern-lane
mode, routes to exactly one lane) via `sessions_spawn`, streams partial results
back, and synthesizes a final answer. Leaf agents **deny `sessions_send`/
`sessions_spawn`** to prevent delegation loops. Agents self-select on broadcast
with `CLAIM` / `CLAIM_PARTIAL` / `NO_CLAIM` and return
`STREAM_UPDATE` / `FINAL_RESULT` / `BLOCKED`; out-of-scope direct handoffs return
a compact `MISROUTE` block. `scripts/sync-agent-workspace-boundaries.mjs`
generates these boundary/orchestration blocks into each workspace's `AGENTS.md`
between HTML-comment markers (it strips and re-inserts the marked region, so hand
edits inside the markers are overwritten).

### Secrets model (never commit values)

Secrets resolve through a 1Password exec provider using namespaced SecretRefs
(`common/<item>/<field>`, `<agent>/<item>/<field>`). Runtime credentials are
written to a host snapshot and bind-mounted read-only into each Docker sandbox at
`/run/openclaw-secrets/local.json`; a `bootstrap-runtime-secrets.sh` setup
command exposes them via `BASH_ENV`. The repo only ever stores **source
metadata** (vault/item/field names), never secret values. Shell snippets must do
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
