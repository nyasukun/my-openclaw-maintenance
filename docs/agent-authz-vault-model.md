# Agent Authorization & 1Password Vault Model

This document describes how authentication/authorization for each OpenClaw
sub-agent is managed **per 1Password vault**, the least-privilege improvements
applied on 2026-06-21, and the credible sources those improvements are based on.

It covers the **deployed concern-lane system** (see
[`config/openclaw-concern-lanes/`](../config/openclaw-concern-lanes/)). The
authoritative machine-readable map is
[`vault-access-map.json`](../config/openclaw-concern-lanes/vault-access-map.json);
this document is its rationale.

## TL;DR

- Each agent is granted **only** the 1Password vault(s) its concern needs
  (common `openclaw-pod` + at most one dedicated vault).
- Authorization is **enforced at the host boundary**, not by prompt text: a
  per-agent runtime-secret snapshot is materialized from the agent's authorized
  vaults and bind-mounted read-only into **only that agent's** sandbox.
- Result: the orchestrator and the non-coding lanes (`security-research`,
  `presales-proposal`, `telegram-fable`) no longer receive any GitHub/shell
  credentials. Only `infra-ops` holds the PR-workflow GitHub PAT.

## Why (credible sources)

| Principle | Source | What it tells us |
| --- | --- | --- |
| Minimize tool permissions; execute in the user's security scope with minimum privileges; **implement authorization in downstream systems** rather than trusting the model ("complete mediation") | OWASP Top 10 for LLM Applications — [LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) | An agent must not hold credentials beyond its task. A "must-not-read" instruction in a prompt is not a control; enforce it outside the LLM. |
| Least-privilege, **per-session/per-request** access; all communication is untrusted regardless of network location | NIST SP 800-207 — [Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final) | Same-host co-location grants no implicit trust between lanes; scope credentials per agent. |
| Use **dedicated vaults** that are properly scoped; **do not grant access to more vaults than needed** | 1Password — [CLI / service-account best practices](https://www.1password.dev/cli/best-practices/) | The vault is the unit of authorization. One scoped vault per concern. |

## Problem in the previous design

The runtime-secret writer (`config/openclaw-agent-project/write-runtime-local-json.js`)
resolved every requested secret into a **single aggregate** file
`~/.openclaw/runtime-secrets/local.json`, and
`runtime-secret-mount.patch.json` bind-mounted **that same file into every
sandbox** via `agents.defaults`:

```
/home/yasu/.openclaw/runtime-secrets:/run/openclaw-secrets:ro
```

So every lane's sandbox received every materialized secret. In practice that
meant the general `GITHUB_TOKEN` **and** the foxcale project PAT
(`GITHUB_PAT_F_PROJECT`) were visible to `infra-ops`, `security-research`,
`presales-proposal`, `telegram-fable`, and the orchestrator — even though only a
coding/PR lane should ever hold a GitHub credential. This is textbook **excessive
agency / excessive permissions** (OWASP LLM06) and breaks vault-level least
privilege (1Password).

The earlier `vault-map.json` also only covered the **retired** purpose agents
(`work-cisco`, `coding`, …); the **active** concern lanes had no vault mapping at
all.

## The model now

### 1. Vault grants (authorization)

`vault-access-map.json` lists every agent and the vault(s) it may read. Active
agents:

| Agent | Role | Authorized vaults | Runtime secrets |
| --- | --- | --- | --- |
| `router-agent` | orchestrator | `openclaw-pod`, `openclaw-router` | none (must not read any lane vault) |
| `security-research` | concern lane | `openclaw-pod`, `openclaw-security-research` | none |
| `presales-proposal` | concern lane | `openclaw-pod`, `openclaw-presales-proposal` | none |
| `infra-ops` | concern lane | `openclaw-pod`, `openclaw-infra-ops` | `GITHUB_TOKEN` |
| `telegram-fable` | artifact lane | `openclaw-pod`, `openclaw-telegram-fable` | none |
| `main`/`hard`/`long`/`heartbeat` | system | `openclaw-pod` | none |

Retired purpose agents are kept with their original vault grants but marked
`retired-kept`; they inherit the empty `_common` snapshot until reactivated.

### 2. Enforcement (per-agent materialization + mount)

`materialize-runtime-secrets.js` replaces the single aggregate snapshot with one
snapshot per agent:

```
~/.openclaw/runtime-secrets/_common/local.json        # no scoped secrets
~/.openclaw/runtime-secrets/infra-ops/local.json      # GITHUB_TOKEN only
~/.openclaw/runtime-secrets/<agent-id>/local.json     # only that agent's grants
```

For every grant it resolves the value from the agent's **authorized** vault only
(primary, then fallbacks), via the 1Password `op` CLI — defense in depth, it will
refuse to read a vault the agent is not authorized for. `openclaw.patch.json`
then mounts each agent its own directory:

- `agents.defaults` → `.../runtime-secrets/_common:/run/openclaw-secrets:ro`
- `infra-ops` → `.../runtime-secrets/infra-ops:/run/openclaw-secrets:ro`
- `telegram-fable` → `.../runtime-secrets/telegram-fable:/run/openclaw-secrets:ro`

The container path stays `/run/openclaw-secrets/local.json`, so
`bootstrap-runtime-secrets.sh` is unchanged; only the host source differs per
agent.

The invariants are locked by [`tests/vault-access-map.test.mjs`](../tests/vault-access-map.test.mjs):
no sandbox mounts the shared aggregate; credential-free agents receive no grant;
every grant resolves only from an authorized vault.

## Operator steps

One-time vault work (manual, in 1Password):

1. Create `openclaw-infra-ops` and move the PR-workflow GitHub PAT there
   (`item: github`, `field: token`). Until then the grant falls back to
   `openclaw-azabu-corporate`, preserving current behavior.
2. Optionally create `openclaw-security-research`, `openclaw-presales-proposal`,
   `openclaw-telegram-fable` for any lane-specific API keys (listed under
   `vaults_to_create`).

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
# infra-ops sees the GitHub token...
openclaw exec --agent infra-ops -- sh -lc 'echo GITHUB_TOKEN=${GITHUB_TOKEN:+present}'
# ...and the non-coding lanes do not:
openclaw exec --agent telegram-fable -- sh -lc 'echo GITHUB_TOKEN=${GITHUB_TOKEN:-absent}'
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
- **Retired purpose agents remain in the config.** Seven `retired-kept` agents
  are unreachable from `router-agent.subagents.allowAgents` yet still defined.
  Reducing attack surface (NIST 800-207: monitor and minimize resources) argues
  for removing them — but do so deliberately, as the live host config has
  diverged from this snapshot (more agents than listed here); use
  `--replace-path 'agents.list'` with the full live list rather than a blanket
  patch.
