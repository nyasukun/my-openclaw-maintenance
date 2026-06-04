# OpenClaw GitHub Authentication

This note records the 2026-06-05 fix for GitHub auth inside OpenClaw
Docker sandboxes.

## Symptom

OpenClaw agents could see the local repository and `gh`, but GitHub operations
failed from the agent:

```text
gh auth status: not logged in
git push: could not read Username for 'https://github.com'
git ls-remote origin HEAD: failed
```

Host-level checks and `docker exec` checks were misleading because they used a
different home directory than OpenClaw's agent tool runtime.

## Root Cause

`sandbox_exec` runs commands with:

```text
HOME=/workspace
```

The initial credential setup wrote files under `/home/ubuntu`:

```text
/home/ubuntu/.gitconfig
/home/ubuntu/.git-credentials
/home/ubuntu/.config/gh/hosts.yml
```

That made direct `docker exec ... sh -lc ...` checks pass, while real OpenClaw
agent tool calls still failed because `gh` and `git` looked under `/workspace`.

## Fix Pattern

Write GitHub credentials for both possible homes:

```text
/home/ubuntu
/workspace
```

Required files in each home:

```text
.gitconfig
.git-credentials
.config/gh/hosts.yml
.openclaw-github-env
```

Set `BASH_ENV` to the `/workspace` env file for the actual agent path:

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "docker": {
          "env": {
            "BASH_ENV": "/workspace/.openclaw-github-env"
          }
        }
      }
    }
  }
}
```

The Docker setup command should also normalize any GitHub remote URL that has a
token or username embedded:

```text
https://github.com/owner/repo.git
```

not:

```text
https://TOKEN@github.com/owner/repo.git
```

Git credential matching can fail when the remote URL already has a username.

## Apply Sequence

After updating `/home/yasu/.openclaw/openclaw.json`:

```bash
openclaw secrets reload
openclaw gateway restart
openclaw sandbox recreate --all --force
```

The gateway restart matters. Without it, new sandboxes may still be created
from the old in-memory setup command.

## Verification

Do not trust host-only checks. Verify through an actual OpenClaw session using
`sandbox_exec`.

Expected agent-side result:

```text
HOME=/workspace
gh auth status: success
/workspace/.config/gh/hosts.yml: present
/workspace/.git-credentials: present
/workspace/.gitconfig: present
git ls-remote origin HEAD: success
```

Useful command for a real OpenClaw session:

```sh
pwd
id
echo HOME=$HOME
command -v gh
gh auth status
env | grep -E '^(GH_TOKEN|GITHUB_TOKEN|BASH_ENV|HOME)=' | sed -E 's/(GH_TOKEN|GITHUB_TOKEN)=.*/\1=present/'
ls -l "$HOME/.config/gh/hosts.yml" "$HOME/.git-credentials" "$HOME/.gitconfig" 2>&1
cd /workspace/azabu.io && git config --global --list && git status -sb && git ls-remote origin HEAD
```

Avoid printing raw tokens. `gh auth status` may print a masked token, but do not
paste unredacted `hosts.yml`, `.git-credentials`, `.env`, or `local.json`.

## PR Workflow Note

If `git push` is blocked but the Codex GitHub connector is available, it can
create Git objects and open a PR without relying on sandbox `gh` auth. That was
used to create:

```text
https://github.com/nyasukun/azabu.io/pull/17
```

If a branch later shows:

```text
ahead 1, behind 1
```

after connector-based publishing, it may be because the local commit and the
connector-created remote commit have the same tree but different commit SHAs.
That is not an authentication failure.
