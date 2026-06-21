# OpenClaw Concern Lanes

This directory captures the currently deployed concern-routing setup for the
local OpenClaw host.

## Shape

- Ingress from Telegram and Slack is routed to `router-agent`.
- `router-agent` delegates normal work to exactly one concern lane:
  - `security-research`
  - `presales-proposal`
  - `infra-ops`
  - `telegram-fable`
- `telegram-fable` owns previewable Artifact, Workspace Artifacts canvas,
  interactive HTML/app, visual demo, and generated-file-by-URL deliverables.
- Each lane has its own workspace, agentDir, session store, AGENTS.md lane
  contract, tool posture, and sandbox posture.
- `infra-ops` is allowed to run the PR workflow without another approval when
  the user explicitly asks for a PR: branch, edit, checks, commit, push, and PR
  creation. Merge, protected/shared force-push, production changes, credential
  changes, destructive data changes, and unrelated external sends still require
  explicit user authorization.

## Files

- `openclaw.patch.json`: config patch generated from the live host. It includes
  `agents.defaults`, `agents.list`, Telegram/Slack bindings, queue policy,
  `tools.agentToAgent`, and the Codex sandbox exec plugin setting. It does not
  include channel credentials, SecretRefs, tokens, logs, or session transcripts.
- `lane-contracts/*.AGENTS.md`: the lane and coordinator contracts deployed in
  the current workspaces.
- `bootstrap-runtime-secrets.sh`: sandbox bootstrap script for GitHub/gh runtime
  credentials. The script reads the mounted runtime secret snapshot at container
  setup time; it does not contain secret values.
- `vault-access-map.json`: authoritative per-agent 1Password vault authorization
  (least privilege). Each agent maps to the vault(s) it may read plus declarative
  runtime-secret grants. See [`docs/agent-authz-vault-model.md`](../../docs/agent-authz-vault-model.md).
- `materialize-runtime-secrets.js`: writes a per-agent runtime-secret snapshot
  (`runtime-secrets/<agent>/local.json`) from only that agent's authorized
  vaults, so each sandbox mounts only its own secrets. Run with `--dry-run`
  first; resolves values via the 1Password `op` CLI.
- `ROLLBACK.md`: local rollback commands and backup path notes for the rollout.

## Apply

From this repository:

```sh
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d%H%M%S)
openclaw config patch --file config/openclaw-concern-lanes/openclaw.patch.json --dry-run
openclaw config patch --file config/openclaw-concern-lanes/openclaw.patch.json
install -m 700 config/openclaw-concern-lanes/bootstrap-runtime-secrets.sh \
  ~/.openclaw/workspace-infra-ops/.openclaw/bootstrap-runtime-secrets.sh
install -m 600 config/openclaw-concern-lanes/lane-contracts/router-agent.AGENTS.md \
  ~/.openclaw/workspaces/router-agent/AGENTS.md
install -m 600 config/openclaw-concern-lanes/lane-contracts/router-agent.SOUL.md \
  ~/.openclaw/workspaces/router-agent/SOUL.md
install -m 600 config/openclaw-concern-lanes/lane-contracts/infra-ops.AGENTS.md \
  ~/.openclaw/workspace-infra-ops/AGENTS.md
install -m 600 config/openclaw-concern-lanes/lane-contracts/security-research.AGENTS.md \
  ~/.openclaw/workspace-security-research/AGENTS.md
install -m 600 config/openclaw-concern-lanes/lane-contracts/presales-proposal.AGENTS.md \
  ~/.openclaw/workspace-presales-proposal/AGENTS.md
# Per-agent secret isolation: install the vault map + materializer, then write
# per-agent runtime-secret snapshots before recreating sandboxes.
install -m 600 config/openclaw-concern-lanes/vault-access-map.json \
  ~/.openclaw/secrets/vault-access-map.json
install -m 700 config/openclaw-concern-lanes/materialize-runtime-secrets.js \
  ~/.openclaw/secrets/materialize-runtime-secrets.js
OPENCLAW_VAULT_ACCESS_MAP=~/.openclaw/secrets/vault-access-map.json \
  node ~/.openclaw/secrets/materialize-runtime-secrets.js --dry-run
OPENCLAW_VAULT_ACCESS_MAP=~/.openclaw/secrets/vault-access-map.json \
  node ~/.openclaw/secrets/materialize-runtime-secrets.js
openclaw config validate
openclaw gateway restart
openclaw sandbox recreate --all --force
```

See [`docs/agent-authz-vault-model.md`](../../docs/agent-authz-vault-model.md)
for the per-vault authorization rationale and the manual 1Password vault steps.

## Verification

Run these after applying:

```sh
openclaw agents list --bindings
openclaw channels status --probe
openclaw exec-policy show --agent infra-ops --json
openclaw sandbox recreate --agent infra-ops --force
openclaw doctor
node --test tests/concern-lanes-config.test.mjs tests/vault-access-map.test.mjs
# infra-ops holds the GitHub token; the non-coding lanes must not:
openclaw exec --agent infra-ops -- sh -lc 'echo GITHUB_TOKEN=${GITHUB_TOKEN:+present}'
openclaw exec --agent telegram-fable -- sh -lc 'echo GITHUB_TOKEN=${GITHUB_TOKEN:-absent}'
```

Expected `infra-ops` exec policy:

```json
{
  "mode": "full",
  "security": "full",
  "ask": "off"
}
```

## Context Carry-Over Fix

The Telegram follow-up issue was caused by router delegation losing the prior
user intent when a short follow-up such as "PRして" spawned a fresh specialist
task. The current contracts fix this by requiring `router-agent` to include the
prior accepted user intent and latest wording in every follow-up task brief, and
by requiring `infra-ops` to treat that task brief as the source of customer
intent for repository and PR work.
