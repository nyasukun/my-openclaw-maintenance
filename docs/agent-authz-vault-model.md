# Agent Authorization & 1Password Vault Model

This document describes how authentication/authorization for each OpenClaw
sub-agent is managed **per 1Password vault**, the least-privilege improvements
applied on 2026-06-21, and the credible sources those improvements are based on.

It covers the **deployed concern-lane system** (see
[`config/openclaw-concern-lanes/`](../config/openclaw-concern-lanes/)), whose
lanes are the operator's five concerns. The authoritative machine-readable map is
[`vault-access-map.json`](../config/openclaw-concern-lanes/vault-access-map.json);
this document is its rationale.

## TL;DR

- Each agent is granted **only** the 1Password vault(s) its concern needs
  (common `openclaw-pod` + at most one dedicated vault).
- Authorization is **enforced at the host boundary**, not by prompt text: a
  per-agent runtime-secret snapshot is materialized from the agent's authorized
  vaults and bind-mounted read-only into **only that agent's** sandbox.
- Result: only `azabu-corporate` holds the Azabu GitHub token (★1) and only
  `foxcale-coding` holds the foxcale project token (★2); the two live in disjoint
  vaults and never mix. `work-cisco` holds neither and carries no Azabu element.
  The orchestrator and the advisory/learning/personal/artifact lanes receive no
  GitHub or shell credential.

## Why (credible sources)

| Principle | Source | What it tells us |
| --- | --- | --- |
| Minimize tool permissions; execute in the user's security scope with minimum privileges; **implement authorization in downstream systems** rather than trusting the model ("complete mediation") | OWASP Top 10 for LLM Applications — [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) | An agent must not hold credentials beyond its task. A "must-not-read" instruction in a prompt is not a control; enforce it outside the LLM. |
| Least-privilege, **per-session/per-request** access; all communication is untrusted regardless of network location | NIST SP 800-207 — [Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final) | Same-host co-location grants no implicit trust between lanes; scope credentials per agent. |
| Use **dedicated vaults** that are properly scoped; **do not grant access to more vaults than needed** | 1Password — [CLI / service-account best practices](https://www.1password.dev/cli/best-practices/) | The vault is the unit of authorization. One scoped vault per concern. |

## Problem in the previous design

The earlier runtime-secret writer (the now-removed
`config/openclaw-agent-project/write-runtime-local-json.js`) resolved every
requested secret into a **single aggregate** file
`~/.openclaw/runtime-secrets/local.json`, and a `runtime-secret-mount` patch
bind-mounted **that same file into every sandbox** via `agents.defaults`:

```
/home/yasu/.openclaw/runtime-secrets:/run/openclaw-secrets:ro
```

So every lane's sandbox received every materialized secret. In practice that
meant the Azabu `GITHUB_TOKEN` (★1) **and** the foxcale project PAT
(`GITHUB_PAT_F_PROJECT`, ★2) were visible to every lane and the orchestrator —
exactly the "★1 and ★2 must never mix" violation, and textbook **excessive
agency / excessive permissions** (OWASP LLM06) that breaks vault-level least
privilege (1Password).

A parallel earlier draft routed all repository/PR work through a single shared
`infra-ops` lane whose token grant even fell back to the Azabu vault — the same
mixing hazard from a different direction. Both that lane and the generic `coding`
agent have been removed; repository work now belongs to the owning concern
(`azabu-corporate` for ★1, `foxcale-coding` for ★2), each with its own token.

## The model now

### 1. Vault grants (authorization)

`vault-access-map.json` lists every agent and the vault(s) it may read. Active
agents:

| Agent | Role / concern | Authorized vaults | Runtime secrets |
| --- | --- | --- | --- |
| `router-agent` | orchestrator | `openclaw-pod`, `openclaw-router` | none (must not read any concern vault) |
| `azabu-corporate` | ★1 Azabu corp + azabu.io | `openclaw-pod`, `openclaw-azabu-corporate` | `GITHUB_TOKEN` (token A) |
| `foxcale-advisor` | ★2 foxcale advisory | `openclaw-pod`, `openclaw-foxcale-advisor` | none |
| `foxcale-coding` | ★2 foxcale repo work | `openclaw-pod`, `openclaw-foxcale-coding` | `GITHUB_PAT_F_PROJECT` (token B) |
| `work-cisco` | Cisco partner-SE | `openclaw-pod`, `openclaw-work-cisco` | none |
| `learning-kb` | self-study | `openclaw-pod`, `openclaw-learning-kb` | none |
| `personal` | personal | `openclaw-pod`, `openclaw-personal` | none |
| `telegram-fable` | artifact lane | `openclaw-pod`, `openclaw-telegram-fable` | none |
| `main`/`hard`/`long`/`heartbeat` | system | `openclaw-pod` | none |

### ★1/★2 token isolation & Cisco-clean (the hard constraints)

- **★1 and ★2 never mix.** The Azabu token (`GITHUB_TOKEN`) is granted only to
  `azabu-corporate` from `openclaw-azabu-corporate`; the foxcale token
  (`GITHUB_PAT_F_PROJECT`) only to `foxcale-coding` from `openclaw-foxcale-coding`.
  Neither grant has a `vault_fallbacks` entry, the two vaults are disjoint, and no
  agent is authorized for both — so a prompt-injected azabu lane cannot reach the
  foxcale token's vault and vice versa.
- **Cisco carries no Azabu element.** `work-cisco` is authorized for neither the
  Azabu nor the foxcale vault and receives no runtime-secret grant.
- These three invariants are asserted in
  [`tests/vault-access-map.test.mjs`](../tests/vault-access-map.test.mjs)
  ("isolates the two customer GitHub tokens", "keeps work-cisco clean").

### 2. Enforcement (per-agent materialization + mount)

`materialize-runtime-secrets.js` replaces the single aggregate snapshot with one
snapshot per agent:

```
~/.openclaw/runtime-secrets/_common/local.json            # no scoped secrets
~/.openclaw/runtime-secrets/azabu-corporate/local.json    # GITHUB_TOKEN (token A) only
~/.openclaw/runtime-secrets/foxcale-coding/local.json     # GITHUB_PAT_F_PROJECT (token B) only
~/.openclaw/runtime-secrets/<agent-id>/local.json         # only that agent's grants
```

For every grant it resolves the value from the agent's **authorized** vault only
(primary, then fallbacks), via the 1Password `op` CLI — defense in depth, it will
refuse to read a vault the agent is not authorized for. `openclaw.patch.json`
then mounts each agent its own directory:

- `agents.defaults` → `.../runtime-secrets/_common:/run/openclaw-secrets:ro`
- `azabu-corporate` → `.../runtime-secrets/azabu-corporate:/run/openclaw-secrets:ro`
- `foxcale-coding` → `.../runtime-secrets/foxcale-coding:/run/openclaw-secrets:ro`
- `telegram-fable` → `.../runtime-secrets/telegram-fable:/run/openclaw-secrets:ro`

The container path stays `/run/openclaw-secrets/local.json`, so
`bootstrap-runtime-secrets.sh` is unchanged; only the host source differs per
agent.

The invariants are locked by [`tests/vault-access-map.test.mjs`](../tests/vault-access-map.test.mjs):
no sandbox mounts the shared aggregate; credential-free agents receive no grant;
every grant resolves only from an authorized vault.

## Operator steps

One-time vault work (manual, in 1Password):

1. Keep the Azabu GitHub token in `openclaw-azabu-corporate` (`item: github`,
   `field: token`) and the foxcale project token in `openclaw-foxcale-coding`
   (`item: github`, `field: pat_f_project`). These two vaults must stay distinct.
2. Optionally create `openclaw-foxcale-advisor`, `openclaw-learning-kb`,
   `openclaw-personal`, `openclaw-telegram-fable` for any lane-specific API keys
   (listed under `vaults_to_create`).

Deploy:

```sh
# 1. Install the map + materializer where the gateway can run them
install -m 600 config/openclaw-concern-lanes/vault-access-map.json \
  ~/.openclaw/secrets/vault-access-map.json
install -m 700 config/openclaw-concern-lanes/materialize-runtime-secrets.js \
  ~/.openclaw/secrets/materialize-runtime-secrets.js

# 2. Materialize per-agent snapshots (dry-run first)
OPENCLAW_VAULT_ACCESS_MAP=~/.openclaw/secrets/vault-access-map.json \
  node ~/.openclaw/secrets/materialize-runtime-secrets.js --dry-run
OPENCLAW_VAULT_ACCESS_MAP=~/.openclaw/secrets/vault-access-map.json \
  node ~/.openclaw/secrets/materialize-runtime-secrets.js

# 3. Apply the per-agent bind changes. Because the live host has more agents than
#    this snapshot, patch agents.list by path rather than blanket-replacing it.
openclaw config patch --file config/openclaw-concern-lanes/openclaw.patch.json --dry-run
#    (review; apply with the operator's usual --replace-path 'agents.list' flow)

# 4. Recreate sandboxes so the new read-only mounts take effect
openclaw gateway restart
openclaw sandbox recreate --all --force
```

Wire `materialize-runtime-secrets.js` into gateway startup in place of (or after)
`write-runtime-local-json.js` so per-agent snapshots refresh whenever vault
values change.

## Verify

```sh
# ★1 azabu-corporate sees token A, ★2 foxcale-coding sees token B...
openclaw exec --agent azabu-corporate -- sh -lc 'echo GITHUB_TOKEN=${GITHUB_TOKEN:+A-present}'
openclaw exec --agent foxcale-coding  -- sh -lc 'echo F_PROJECT=${GITHUB_PAT_F_PROJECT:+B-present}'
# ...neither sees the other's token, and Cisco/non-coding lanes see none:
openclaw exec --agent azabu-corporate -- sh -lc 'echo F_PROJECT=${GITHUB_PAT_F_PROJECT:-absent}'
openclaw exec --agent foxcale-coding  -- sh -lc 'echo AZABU=${GITHUB_TOKEN:-absent}'
openclaw exec --agent work-cisco      -- sh -lc 'echo GITHUB_TOKEN=${GITHUB_TOKEN:-clean}'
node --test tests/vault-access-map.test.mjs
```

## Residual risks / follow-ups

- **`router-agent` retains `exec`/`process`.** This is an intentional OpenClaw
  workaround: spawned subagents inherit the requester's tool allowlist, so the
  orchestrator must expose those tools for delegated coding lanes to keep shell
  access. The router holds **no** repo/domain credentials (empty `_common`
  mount), which bounds the blast radius, but removing exec from the router once
  OpenClaw supports per-child tool grants would be stronger (OWASP LLM06:
  minimize functionality).
- **The live host has more agents than this snapshot.** The snapshot now defines
  12 agents (4 system + router + telegram-fable + 6 concerns); the live
  `~/.openclaw/openclaw.json` still carries the four removed ones
  (`coding`, `security-research`, `presales-proposal`, `infra-ops`) plus any
  drift. Because `openclaw config patch` replaces arrays wholesale, removing those
  agents on the live host means applying this 12-agent `agents.list` with
  `--replace-path 'agents.list'` (back up `openclaw.json` first). Archive the
  removed agents' workspaces/state only after checking for work products
  (see `config/openclaw-concern-lanes/ROLLBACK.md`).
