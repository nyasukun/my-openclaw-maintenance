# My OpenClaw Maintenance

Personal maintenance material for OpenClaw environments operated from local Codex.

This repository is the source of truth for local Codex maintenance skills. The
installed Codex skill directory under `~/.codex/skills` is only a deployed copy.

## Skills

- `openclaw-upgrade-regression`: after upgrading OpenClaw on
  `yasu@192.168.86.103`, check for known regressions and reapply the guarded
  Control UI usage hotfix only when needed.

## Install Locally

From this repository:

```bash
mkdir -p ~/.codex/skills
rsync -a skills/openclaw-upgrade-regression ~/.codex/skills/
```

Then start a fresh Codex session and ask:

```text
Use the openclaw-upgrade-regression skill to check my OpenClaw upgrade.
```

## Operating Model

- GitHub repo: source of truth.
- `~/.codex/skills/openclaw-upgrade-regression`: local deployed copy used by
  Codex.
- OpenClaw workspaces: not used for this skill. This is intentionally an
  outside-of-OpenClaw maintenance workflow that reaches the host over SSH.

## Notes

Do not commit secrets from `/home/yasu/.openclaw/openclaw.json` or session logs.

Operational notes:

- [OpenClaw GitHub authentication](docs/openclaw-github-auth.md): lessons from
  wiring `gh` and `git` credentials into Docker sandboxes where
  `sandbox_exec` runs with `HOME=/workspace`.
