#!/bin/sh
set -eu

secret_file="${OPENCLAW_SECRET_FILE:-/run/openclaw-secrets/local.json}"

if [ -f /workspace/.openclaw/runtime-secret-env.sh ]; then
  . /workspace/.openclaw/runtime-secret-env.sh
fi

if [ -r "$secret_file" ]; then
  token="$(python3 - "$secret_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
print(data.get("env", {}).get("GITHUB_TOKEN", ""))
PY
)"
  f_project_token="$(python3 - "$secret_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
print(data.get("env", {}).get("GITHUB_PAT_F_PROJECT", ""))
PY
)"
else
  token=""
  f_project_token=""
fi

effective_token="$f_project_token"
token_source="GITHUB_PAT_F_PROJECT"
if [ -z "$effective_token" ]; then
  effective_token="$token"
  token_source="GITHUB_TOKEN"
fi

if [ -n "$effective_token" ]; then
  umask 077
  python3 - "$effective_token" "$token" "$f_project_token" "$token_source" <<'PY'
import os
import pathlib
import shlex
import subprocess
import sys

effective_token = sys.argv[1]
general_token = sys.argv[2] if len(sys.argv) > 2 else ""
f_project_token = sys.argv[3] if len(sys.argv) > 3 else ""
token_source = sys.argv[4] if len(sys.argv) > 4 else "unknown"

home_paths = os.environ.get("OPENCLAW_GITHUB_HOME_PATHS", "/home/ubuntu:/workspace").split(":")
workspace_dir = pathlib.Path(os.environ.get("OPENCLAW_WORKSPACE_DIR", "/workspace"))


def write_creds(home_path: str) -> None:
    home = pathlib.Path(home_path)
    home.mkdir(parents=True, exist_ok=True)
    ghdir = home / ".config" / "gh"
    ghdir.mkdir(parents=True, exist_ok=True)
    os.chmod(ghdir, 0o700)
    (home / ".gitconfig").write_text(
        "[credential]\n"
        "\thelper = store\n"
        '[credential "https://github.com"]\n'
        "\thelper = store\n"
        '[url "https://github.com/"]\n'
        f"\tinsteadOf = https://{effective_token}@github.com/\n",
        encoding="utf-8",
    )
    (home / ".git-credentials").write_text(
        f"https://x-access-token:{effective_token}@github.com\n",
        encoding="utf-8",
    )
    (ghdir / "hosts.yml").write_text(
        "github.com:\n"
        f"    oauth_token: {effective_token}\n"
        "    user: nyasukun\n"
        "    git_protocol: https\n",
        encoding="utf-8",
    )
    env_lines = [
        f"export GITHUB_TOKEN={shlex.quote(effective_token)}",
        f"export GH_TOKEN={shlex.quote(effective_token)}",
        f"export OPENCLAW_GITHUB_TOKEN_SOURCE={shlex.quote(token_source)}",
    ]
    if f_project_token:
        env_lines.append(f"export GITHUB_PAT_F_PROJECT={shlex.quote(f_project_token)}")
    if general_token and general_token != effective_token:
        env_lines.append(f"export GITHUB_GENERAL_TOKEN={shlex.quote(general_token)}")
    env_lines.append(f"export HOME={shlex.quote(home_path)}")
    (home / ".openclaw-github-env").write_text("\n".join(env_lines) + "\n", encoding="utf-8")
    for rel in [".gitconfig", ".git-credentials", ".openclaw-github-env", ".config/gh/hosts.yml"]:
        os.chmod(home / rel, 0o600)


for home_path in home_paths:
    if home_path:
        write_creds(home_path)

override_dir = workspace_dir / ".openclaw"
override_dir.mkdir(parents=True, exist_ok=True)
override_lines = [
    f"export GITHUB_TOKEN={shlex.quote(effective_token)}",
    f"export GH_TOKEN={shlex.quote(effective_token)}",
    f"export OPENCLAW_GITHUB_TOKEN_SOURCE={shlex.quote(token_source)}",
]
if f_project_token:
    override_lines.append(f"export GITHUB_PAT_F_PROJECT={shlex.quote(f_project_token)}")
if general_token and general_token != effective_token:
    override_lines.append(f"export GITHUB_GENERAL_TOKEN={shlex.quote(general_token)}")
(override_dir / "runtime-secret-overrides.sh").write_text("\n".join(override_lines) + "\n", encoding="utf-8")
os.chmod(override_dir / "runtime-secret-overrides.sh", 0o600)

if workspace_dir.is_dir():
    for gitdir in workspace_dir.glob("*/.git"):
        repo = gitdir.parent
        try:
            remotes = subprocess.check_output(
                ["git", "-C", str(repo), "remote"],
                text=True,
                stderr=subprocess.DEVNULL,
            ).split()
        except Exception:
            continue
        for remote in remotes:
            try:
                url = subprocess.check_output(
                    ["git", "-C", str(repo), "remote", "get-url", remote],
                    text=True,
                    stderr=subprocess.DEVNULL,
                ).strip()
            except Exception:
                continue
            if url.startswith("https://") and "@github.com/" in url:
                clean = "https://github.com/" + url.split("@github.com/", 1)[1]
                subprocess.run(
                    ["git", "-C", str(repo), "remote", "set-url", remote, clean],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
PY
  for rc in "/home/ubuntu/.profile" "/home/ubuntu/.bashrc" "/workspace/.profile" "/workspace/.bashrc"; do
    if [ -f "$rc" ] && ! grep -q 'openclaw-github-env' "$rc"; then
      printf '\n# OpenClaw GitHub credentials\n[ -f "$HOME/.openclaw-github-env" ] && . "$HOME/.openclaw-github-env"\n' >> "$rc"
    fi
  done
fi
