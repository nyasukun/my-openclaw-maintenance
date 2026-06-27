#!/usr/bin/env bash
# HOST-SIDE secret materialization for the containerized Hermes (Option B).
#
# Resolves the Hermes-only 1Password vault into a tmpfs env-file that docker
# compose loads as the container's process env. The 1Password token (your `op`
# session) NEVER enters the container — only the resolved values do, and only for
# Hermes' own vault. This mirrors OpenClaw's per-agent runtime-secret snapshots.
#
# Run as the same user that runs the gateway, with `op` already signed in.
# Self-contained on purpose: it does NOT default to any repo path that could be
# removed out from under it (cf. the gateway-restart vault-map landmine).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TPL="${HERMES_ENV_TPL:-$HERE/hermes.env.tpl}"
OUT="${HERMES_SECRETS_ENV:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/hermes-secrets/hermes.env}"

[ -r "$TPL" ] || { echo "template not readable: $TPL" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"

# Refuse to write resolved secrets onto a persistent filesystem.
fstype="$(stat -f -c %T "$(dirname "$OUT")" 2>/dev/null || echo unknown)"
case "$fstype" in
  tmpfs|ramfs) : ;;
  *) echo "refusing to write secrets to non-tmpfs ($fstype): $(dirname "$OUT")" >&2; exit 1 ;;
esac

umask 077
op inject -i "$TPL" -o "$OUT"

# Redacted verification only — report presence, never the value.
if grep -q '^OPENROUTER_API_KEY=.\+' "$OUT"; then
  echo "OPENROUTER_API_KEY=present  ->  $OUT (tmpfs, 0600)"
else
  echo "OPENROUTER_API_KEY=MISSING — check the op:// reference / vault grant" >&2
  exit 1
fi
