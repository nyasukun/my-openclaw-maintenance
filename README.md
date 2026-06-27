# My OpenClaw + Hermes Maintenance

Personal maintenance material for the **two agent stacks** this operator runs in
parallel on one host:

- **OpenClaw** — multi-agent gateway fronting Telegram/Slack (`router-agent` +
  concern lanes). Config patches, lane contracts, skills, and plugins here are
  deployed out to the live host.
- **Hermes Agent** — [Nous Research Hermes](https://hermes-agent.org/), a
  self-hosted persistent agent installed under `~/.hermes`, run alongside OpenClaw
  and driven through the same single OpenRouter provider. See
  [docs/hermes-agent.md](docs/hermes-agent.md) for install + coexistence rules.

The two stacks share only the host and the OpenRouter upstream; their control
planes, tokens, and secret stores stay disjoint.

This repository is the source of truth for both. Deployed copies (Codex skill dir
under `~/.codex/skills`, OpenClaw's managed skill/plugin dirs, `~/.hermes`) are only
deployed copies.

## Skills

- `openclaw-upgrade-regression`: after upgrading a local OpenClaw host, check
  for known regressions and reapply the guarded Control UI usage hotfix only
  when needed.
- `workspace-artifact-builder`: create previewable artifacts under the OpenClaw
  workspace and return Workspace Artifacts preview URLs.

## Plugins

- `plugins/workspace-artifacts`: authenticated OpenClaw Gateway UI for browsing,
  previewing, and editing workspace files.

## Hermes Agent

Hermes is a standalone stack (it is **not** an OpenClaw plugin), run in parallel
with the OpenClaw gateway. On this host it is **always deployed as a hardened
container with host-side 1Password secret injection** — the deploy artifacts are in
[`docker/hermes/`](docker/hermes/) and the runbook (coexistence model + the hard
constraints: own disjoint vault, Hermes-only OpenRouter key/bot tokens, never run
`hermes claw migrate` blindly) is in [docs/hermes-agent.md](docs/hermes-agent.md).
Deploy:

```bash
cd docker/hermes
# point hermes.env.tpl op:// refs at the Hermes-only vault; set HERMES_MODEL in compose
docker compose build
./materialize-hermes-secrets.sh && docker compose up -d
docker compose exec hermes hermes        # interactive CLI
```

The `op` session stays on the host; only the resolved values for Hermes' own vault
reach the container process — never a 1Password token, never the `/data` state
volume. Bare `~/.hermes` install is a throwaway-experiment escape hatch only (see
the doc appendix), not the managed deployment.

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

- [Hermes Agent](docs/hermes-agent.md): install Nous Research Hermes under
  `~/.hermes` and run it in parallel with OpenClaw — coexistence model, the
  `hermes claw migrate` / shared-bot-token / OpenRouter-key hazards, and rollback.
- [OpenClaw GitHub authentication](docs/openclaw-github-auth.md): lessons from
  wiring `gh` and `git` credentials into Docker sandboxes where
  `sandbox_exec` runs with `HOME=/workspace`.
- [OpenClaw skill deployment](docs/openclaw-skill-deployment.md): keep public
  skill sources generic, then inject the current Tailscale Serve URL only into
  the deployed OpenClaw-managed skill copy.
- [OpenClaw concern lanes](config/openclaw-concern-lanes/README.md): current
  Telegram/Slack `router-agent` setup whose lanes are the operator's five
  concerns (`azabu-corporate` ★1, `foxcale-advisor`/`foxcale-coding` ★2,
  `work-cisco`, `learning-kb`, `personal`) plus the `telegram-fable` Artifact
  lane, with ★1/★2 GitHub-token isolation and the per-concern PR workflow.
- [Host topology](docs/host-topology.md): whole-of-host mermaid diagrams — the
  operate plane (phone → Telegram/Slack) and the redundant maintain plane (phone →
  Codex remote / Claude remote), 1Password vault access granularity, and the
  container image → instance → session relationship.
- [Agent system overview](docs/agent-system-overview.md): whole-system mermaid
  diagrams of channel ingress, orchestration/routing, and the per-vault
  authorization boundary.
- [Agent authorization & vault model](docs/agent-authz-vault-model.md):
  least-privilege per-1Password-vault authz for each sub-agent, enforced at the
  host boundary by per-agent runtime-secret snapshots (OWASP LLM06 / NIST
  800-207 / 1Password guidance).
