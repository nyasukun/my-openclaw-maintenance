# OpenClaw Concern Lanes

This directory is the single source of truth for the deployed concern-routing
setup on the local OpenClaw host. The lanes are the operator's five concerns.

## Shape

- Ingress from Telegram and Slack is routed to `router-agent`.
- `router-agent` delegates normal work to exactly one concern lane:
  - `azabu-corporate` — ★1 Azabu corporate ops + `azabu.io` site maintenance
    (holds the Azabu GitHub token, `GITHUB_TOKEN`).
  - `foxcale-advisor` — ★2 foxcale technical advisory / PM (no code, no token).
  - `foxcale-coding` — ★2 foxcale repository work (holds the foxcale project
    token, `GITHUB_PAT_F_PROJECT`).
  - `work-cisco` — Cisco partner-SE (no Azabu element, no GitHub token).
  - `learning-kb` — self-study.
  - `personal` — personal life admin.
  - `telegram-fable` — previewable Artifacts / Workspace Artifacts canvas /
    interactive HTML / generated-file-by-URL deliverables.
- Each lane has its own workspace, AGENTS.md lane contract, tool posture, and
  sandbox posture.
- **Concern isolation (hard):** ★1 (Azabu) and ★2 (foxcale) use different GitHub
  tokens in disjoint 1Password vaults and must never mix; `work-cisco` holds
  neither vault. Enforced at the host boundary by per-agent runtime-secret
  snapshots, not by prompt text.
- A lane that owns a repository may run the PR workflow without another approval
  when the user explicitly asks for a PR (`azabu-corporate` for `azabu.io`,
  `foxcale-coding` for foxcale repos): branch, edit, checks, commit, push, and PR
  creation. Merge, protected/shared force-push, production changes, credential
  changes, destructive data changes, and unrelated external sends still require
  explicit user authorization.

## Files

- `openclaw.patch.json`: config patch generated from the live host
  (`agents.defaults`, `agents.list`, Telegram/Slack bindings, queue policy,
  `tools.agentToAgent`, Codex sandbox exec setting, plugin entries). No channel
  credentials, SecretRefs, tokens, logs, or session transcripts.
- `routing-policy.json`: router keyword routes, broadcast/self-select policy,
  handoff payload schema, slash-command behavior, and the concern-isolation
  policy.
- `lane-contracts/*.AGENTS.md` (+ `router-agent.SOUL.md`): the lane and
  coordinator contracts deployed in the current workspaces.
- `bootstrap-runtime-secrets.sh`: sandbox bootstrap that reads the mounted
  runtime-secret snapshot at container setup (configures git/`gh` from the
  agent's own `GITHUB_TOKEN`/`GH_TOKEN`). Contains no secret values.
- `foxcale-github-auth.sh`: `foxcale-coding`'s extra setup command — makes
  `GITHUB_PAT_F_PROJECT` (★2 token B) the effective git/`gh` token in that
  sandbox only.
- `vault-access-map.json`: authoritative per-agent 1Password vault authorization
  (least privilege) plus the declarative runtime-secret grants. See
  [`docs/agent-authz-vault-model.md`](../../docs/agent-authz-vault-model.md).
- `materialize-runtime-secrets.js`: writes a per-agent runtime-secret snapshot
  (`runtime-secrets/<agent>/local.json`) from only that agent's authorized
  vaults, so each sandbox mounts only its own secrets. Run with `--dry-run`
  first; resolves values via the 1Password `op` CLI.
- `ROLLBACK.md`: local rollback commands, backup paths, and removed-agent notes.

## Apply

The live host carries four agents this snapshot removes (`coding`,
`security-research`, `presales-proposal`, `infra-ops`). Because
`openclaw config patch` replaces arrays wholesale, apply `agents.list` with
`--replace-path` so those agents are removed — after backing up `openclaw.json`.

```sh
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d%H%M%S)

# Per-agent secret isolation: install the map + materializer, then write
# per-agent runtime-secret snapshots before recreating sandboxes.
install -m 600 config/openclaw-concern-lanes/vault-access-map.json \
  ~/.openclaw/secrets/vault-access-map.json
install -m 700 config/openclaw-concern-lanes/materialize-runtime-secrets.js \
  ~/.openclaw/secrets/materialize-runtime-secrets.js
OPENCLAW_VAULT_ACCESS_MAP=~/.openclaw/secrets/vault-access-map.json \
  node ~/.openclaw/secrets/materialize-runtime-secrets.js --dry-run
OPENCLAW_VAULT_ACCESS_MAP=~/.openclaw/secrets/vault-access-map.json \
  node ~/.openclaw/secrets/materialize-runtime-secrets.js

# Sandbox setup scripts for the two coding concerns.
install -m 700 config/openclaw-concern-lanes/bootstrap-runtime-secrets.sh \
  ~/.openclaw/workspaces/azabu-corporate/.openclaw/bootstrap-runtime-secrets.sh
install -m 700 config/openclaw-concern-lanes/bootstrap-runtime-secrets.sh \
  ~/.openclaw/workspaces/foxcale-coding/.openclaw/bootstrap-runtime-secrets.sh
install -m 700 config/openclaw-concern-lanes/foxcale-github-auth.sh \
  ~/.openclaw/workspaces/foxcale-coding/.openclaw/foxcale-github-auth.sh

# Lane + coordinator contracts.
install -m 600 config/openclaw-concern-lanes/lane-contracts/router-agent.AGENTS.md \
  ~/.openclaw/workspaces/router-agent/AGENTS.md
install -m 600 config/openclaw-concern-lanes/lane-contracts/router-agent.SOUL.md \
  ~/.openclaw/workspaces/router-agent/SOUL.md
for lane in azabu-corporate foxcale-advisor foxcale-coding work-cisco learning-kb personal; do
  install -m 600 "config/openclaw-concern-lanes/lane-contracts/${lane}.AGENTS.md" \
    "~/.openclaw/workspaces/${lane}/AGENTS.md"
done

# Apply config. Replace agents.list so the four removed agents are deleted.
openclaw config patch --file config/openclaw-concern-lanes/openclaw.patch.json \
  --replace-path 'agents.list' --dry-run     # review: should report removals
openclaw config patch --file config/openclaw-concern-lanes/openclaw.patch.json \
  --replace-path 'agents.list'
openclaw config validate
openclaw gateway restart
openclaw sandbox recreate --all --force
```

See [`docs/agent-authz-vault-model.md`](../../docs/agent-authz-vault-model.md)
for the per-vault authorization rationale and the manual 1Password vault steps.

## Verification

Run these after applying:

```sh
openclaw agents list --bindings           # 12 agents; the four removed ones gone
openclaw channels status --probe
openclaw doctor
node --test tests/*.test.mjs
# ★1/★2 token isolation + Cisco-clean:
openclaw exec --agent azabu-corporate -- sh -lc 'echo GITHUB_TOKEN=${GITHUB_TOKEN:+A-present}'
openclaw exec --agent azabu-corporate -- sh -lc 'echo F_PROJECT=${GITHUB_PAT_F_PROJECT:-absent}'
openclaw exec --agent foxcale-coding  -- sh -lc 'echo F_PROJECT=${GITHUB_PAT_F_PROJECT:+B-present}'
openclaw exec --agent foxcale-coding  -- sh -lc 'echo AZABU=${GITHUB_TOKEN:-absent}'
openclaw exec --agent work-cisco      -- sh -lc 'echo GITHUB_TOKEN=${GITHUB_TOKEN:-clean}'
```

## Context Carry-Over

`router-agent` includes the prior accepted user intent and latest wording in
every follow-up task brief (e.g. a short "PRして"), and the owning concern agent
treats that task brief as the source of customer intent for repository and PR
work. Subagents do not inherit the Telegram conversation unless that context is
explicitly included.
