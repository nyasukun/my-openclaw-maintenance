# OpenClaw Skill Deployment Notes

Agent-facing notes for deploying skills from this public repository into a
private OpenClaw environment.

## Workspace Artifact Builder

Keep `skills/workspace-artifact-builder/SKILL.md` generic in git. It must not
contain a personal Tailscale hostname, tailnet name, LAN address, token, or any
other environment-specific value.

When deploying this skill into OpenClaw, install the generic copy first:

```bash
openclaw skills install "$REPO_ROOT/skills/workspace-artifact-builder" --global --as workspace-artifact-builder --force
```

Then patch only the deployed copy under the OpenClaw managed skills directory.
Resolve the current Tailscale Serve origin from the host:

```bash
tailscale serve status
```

Use the `https://...ts.net` origin shown by Tailscale Serve to replace the
deployed skill's Tailscale preview placeholders:

```text
<tailscale-serve-origin>
```

The deployed skill should emit preview URLs in this shape:

```text
Local: http://127.0.0.1:<gateway-port>/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html
Tailscale: https://<current-host>.<tailnet>.ts.net/plugins/workspace-artifacts/?file=canvas/<artifact-id>/index.html
```

Do not commit the patched deployed copy back to this repository. If the
deployed Skill is refreshed from git, repeat the local Tailscale origin patch
before asking Telegram or other OpenClaw agents to create artifacts.

After deployment, verify the target agent can see the skill:

```bash
openclaw skills check --agent telegram-fable --json
openclaw skills info workspace-artifact-builder --agent telegram-fable --json
openclaw gateway restart
```

Expected result: `workspace-artifact-builder` is `modelVisible: true` for the
target agent.
