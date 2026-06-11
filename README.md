# My OpenClaw Maintenance

Personal maintenance material for OpenClaw environments operated from local Codex.

This repository is the source of truth for local Codex maintenance skills. The
installed Codex skill directory under `~/.codex/skills` is only a deployed copy.

## Skills

- `openclaw-upgrade-regression`: after upgrading a local OpenClaw host, check
  for known regressions and reapply the guarded Control UI usage hotfix only
  when needed.
- `workspace-artifact-builder`: create previewable artifacts under the OpenClaw
  workspace and return Workspace Artifacts preview URLs.

## Plugins

- `plugins/workspace-artifacts`: authenticated OpenClaw Gateway UI for browsing,
  previewing, and editing workspace files.

## Install Locally

From this repository:

```bash
mkdir -p ~/.codex/skills
rsync -a skills/openclaw-upgrade-regression ~/.codex/skills/
rsync -a skills/workspace-artifact-builder ~/.codex/skills/
```

Then start a fresh Codex session and ask:

```text
Use the openclaw-upgrade-regression skill to check my OpenClaw upgrade.
```

For the Workspace Artifacts plugin:

```bash
cd plugins/workspace-artifacts
npm install
npm run build
openclaw plugins install --link "$PWD"
openclaw gateway restart
```

## Operating Model

- GitHub repo: source of truth.
- `~/.codex/skills/openclaw-upgrade-regression`: local deployed copy used by
  Codex.
- `~/.codex/skills/workspace-artifact-builder`: local deployed copy used by
  Codex.
- `openclaw-upgrade-regression` is intentionally an outside-of-OpenClaw
  maintenance workflow that reaches the target host over SSH.
- `workspace-artifact-builder` writes previewable files into the configured
  OpenClaw workspace.

## Notes

Do not commit secrets from `~/.openclaw/openclaw.json` or session logs.

Operational notes:

- [OpenClaw GitHub authentication](docs/openclaw-github-auth.md): lessons from
  wiring `gh` and `git` credentials into Docker sandboxes where
  `sandbox_exec` runs with `HOME=/workspace`.
