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

For sandboxed OpenClaw agents, also keep an agent/workspace instruction that
prevents host-path skill lookup failures before the skill file is loaded. The
instruction should say:

- if `~/.openclaw/skills/workspace-artifact-builder/SKILL.md` is unavailable in
  sandbox, read
  `/workspace/.openclaw/sandbox-skills/skills/workspace-artifact-builder/SKILL.md`
  first;
- if the sandbox skill file is unavailable, continue from the injected skill
  summary and do not search the whole filesystem;
- write Artifact source files under `/workspace/artifacts/<artifact-id>/` and
  web previews under `/workspace/canvas/<artifact-id>/`;
- use POSIX-safe heredocs or a complete file-write tool call, never an empty
  `apply_patch` add-file call;
- return the Workspace Artifacts Local URL instead of pasting the artifact body.

This guard belongs in the workspace/agent `AGENTS.md`, not only inside
`SKILL.md`, because the model may need the sandbox path before it can open the
skill file.

For the Artifact lane, also expose the deployed skill directory read-only to
sandbox paths that models commonly try when following the injected skill
location, and expose the same workspace at its configured absolute path because
the skill may resolve `/home/yasu/.openclaw/workspace` before writing:

```json
"sandbox": {
  "docker": {
    "binds": [
      "/home/yasu/.openclaw/runtime-secrets:/run/openclaw-secrets:ro",
      "/home/yasu/.openclaw/skills:/home/yasu/.openclaw/skills:ro",
      "/home/yasu/.openclaw/skills:/home/ubuntu/.openclaw/skills:ro",
      "/home/yasu/.openclaw/workspace:/home/yasu/.openclaw/workspace"
    ]
  }
}
```

After changing sandbox binds, restart Gateway and recreate the affected
agent's sandbox containers:

```bash
openclaw gateway restart
openclaw sandbox recreate --agent telegram-fable --force
```
