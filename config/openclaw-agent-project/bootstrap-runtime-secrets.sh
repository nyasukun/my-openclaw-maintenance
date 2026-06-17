#!/bin/sh
set -eu

secret_file="${OPENCLAW_SECRET_FILE:-/run/openclaw-secrets/local.json}"
runtime_env="/workspace/.openclaw/runtime-secret-env.sh"
compat_env="/workspace/.openclaw-github-env"

mkdir -p /workspace/.openclaw

cat > "$runtime_env" <<'EOF'
# OpenClaw runtime secret loader.
# This file is sourced by BASH_ENV for each sandbox shell. It re-reads the
# mounted secret snapshot so refreshed Vault values become visible without
# baking values into the agent prompt.
secret_file="${OPENCLAW_SECRET_FILE:-/run/openclaw-secrets/local.json}"
if [ -r "$secret_file" ]; then
  eval "$(
    python3 - "$secret_file" <<'PY'
import json
import re
import shlex
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        data = json.load(handle)
except Exception:
    data = {}

env = data.get("env", {})
if "GITHUB_TOKEN" in env and "GH_TOKEN" not in env:
    env["GH_TOKEN"] = env["GITHUB_TOKEN"]
keys = []
for key, value in sorted(env.items()):
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", str(key)):
        continue
    keys.append(str(key))
    print(f"export {key}={shlex.quote(str(value))}")

if keys:
    print(f"export OPENCLAW_RUNTIME_SECRET_KEYS={shlex.quote(','.join(keys))}")
PY
  )"
fi
if [ -f /workspace/.openclaw/runtime-secret-overrides.sh ]; then
  . /workspace/.openclaw/runtime-secret-overrides.sh
fi
EOF
chmod 600 "$runtime_env"

cat > "$compat_env" <<'EOF'
# Compatibility shim for older sandboxes that still point BASH_ENV here.
if [ -f /workspace/.openclaw/runtime-secret-env.sh ]; then
  . /workspace/.openclaw/runtime-secret-env.sh
fi
EOF
chmod 600 "$compat_env"

for rc in "/home/ubuntu/.profile" "/home/ubuntu/.bashrc" "/workspace/.profile" "/workspace/.bashrc"; do
  if [ -f "$rc" ] && ! grep -q 'runtime-secret-env.sh' "$rc"; then
    printf '\n# OpenClaw runtime secrets\nif [ -f /workspace/.openclaw/runtime-secret-env.sh ]; then . /workspace/.openclaw/runtime-secret-env.sh; fi\n' >> "$rc"
  fi
done

. "$runtime_env"

effective_token="${OPENCLAW_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
if [ -n "$effective_token" ]; then
  umask 077
  python3 - "$effective_token" <<'PY'
import os
import pathlib
import shlex
import subprocess
import sys

token = sys.argv[1]
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
        f"\tinsteadOf = https://{token}@github.com/\n",
        encoding="utf-8",
    )
    (home / ".git-credentials").write_text(
        f"https://x-access-token:{token}@github.com\n",
        encoding="utf-8",
    )
    (ghdir / "hosts.yml").write_text(
        "github.com:\n"
        f"    oauth_token: {token}\n"
        "    user: nyasukun\n"
        "    git_protocol: https\n",
        encoding="utf-8",
    )
    env_lines = [
        f"export GITHUB_TOKEN={shlex.quote(token)}",
        f"export GH_TOKEN={shlex.quote(token)}",
        f"export HOME={shlex.quote(home_path)}",
        "if [ -f /workspace/.openclaw/runtime-secret-env.sh ]; then . /workspace/.openclaw/runtime-secret-env.sh; fi",
    ]
    (home / ".openclaw-github-env").write_text("\n".join(env_lines) + "\n", encoding="utf-8")
    for rel in [".gitconfig", ".git-credentials", ".openclaw-github-env", ".config/gh/hosts.yml"]:
        os.chmod(home / rel, 0o600)


for home_path in home_paths:
    if home_path:
        write_creds(home_path)

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
fi
