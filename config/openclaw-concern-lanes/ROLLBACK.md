# OpenClaw multi-agent rollback

Created: 2026-06-17

## Config backup

Nearest pre-2026-06-17 config backup currently present:

```bash
/home/yasu/.openclaw/openclaw.json.bak-router-agent-tool-policy-20260614-1124
```

Automatic backup from immediately before the Telegram context/tool-inheritance
fix:

```bash
/home/yasu/.openclaw/openclaw.json.bak.4
```

Snapshot after the Telegram context/tool-inheritance fix:

```bash
/home/yasu/.openclaw/openclaw.json.bak.202606171535_contextfix_applied
```

Backup before the PR no-approval workflow change:

```bash
/home/yasu/.openclaw/openclaw.json.bak.202606171552_pr_no_approval
```

## Roll back config

To roll back only the PR no-approval workflow change:

```bash
openclaw gateway stop
cp /home/yasu/.openclaw/openclaw.json.bak.202606171552_pr_no_approval /home/yasu/.openclaw/openclaw.json
openclaw config validate
openclaw gateway restart
openclaw sandbox recreate --agent infra-ops --force
```

To roll back only the Telegram context/tool-inheritance fix:

```bash
openclaw gateway stop
cp /home/yasu/.openclaw/openclaw.json.bak.4 /home/yasu/.openclaw/openclaw.json
openclaw config validate
openclaw doctor
openclaw gateway restart
```

To roll back to the nearest older config backup currently present:

```bash
openclaw gateway stop
cp /home/yasu/.openclaw/openclaw.json.bak-router-agent-tool-policy-20260614-1124 /home/yasu/.openclaw/openclaw.json
openclaw config validate
openclaw doctor
openclaw gateway restart
```

## Added agents

Phase 1 added these agent ids:

- `security-research`
- `presales-proposal`
- `infra-ops`

Their workspaces and agent state directories:

```bash
/home/yasu/.openclaw/workspace-security-research
/home/yasu/.openclaw/workspace-presales-proposal
/home/yasu/.openclaw/workspace-infra-ops
/home/yasu/.openclaw/agents/security-research
/home/yasu/.openclaw/agents/presales-proposal
/home/yasu/.openclaw/agents/infra-ops
```

After restoring the config, these directories can be archived or removed if they
are no longer needed. Do not delete them before checking for any work products
or auth/session state you want to preserve.

## Notes

- Gateway restart was run after Phase 1 and Phase 2 config changes.
- Existing Slack and Telegram bindings to `router-agent` were left unchanged.
- Phase 2 changed `agents.defaults.maxConcurrent`,
  `agents.defaults.subagents.maxConcurrent`,
  `agents.defaults.subagents.delegationMode`, and `messages.queue`.
- Existing `router-agent` remains the Telegram/Slack binding target, but its
  concern-routing overlay and `subagents.allowAgents` were updated to delegate
  only to `security-research`, `presales-proposal`, and `infra-ops`.
- The 2026-06-17 context/tool-inheritance fix changed `router-agent` to a
  sandboxed coordinator with a union allowlist, because child subagents inherit
  requester tool restrictions. It also sandboxed `security-research` and
  `presales-proposal`, added `process` to `infra-ops`, and enabled Codex
  `appServer.experimental.sandboxExecServer`.
- The 2026-06-17 PR no-approval workflow change made `infra-ops` explicitly use
  `tools.exec.mode: "full"`, configured its sandbox Docker network as `bridge`,
  added a sandbox setup command to initialize GitHub credentials from the
  mounted OpenClaw secret snapshot, and updated the router/infra lane contracts
  so branch creation, commit, push, and PR creation are authorized when the user
  asks for a PR. Merge, force-push to protected/shared branches, production
  changes, credential changes, and destructive data changes still require an
  explicit request.
- Existing doctor findings outside the three new agents were not fixed.
