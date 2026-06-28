#!/usr/bin/env bash
# HOST-SIDE secret materialization for the containerized Hermes.
#
# Resolves the Hermes-only 1Password vault into a tmpfs env-file that docker
# compose loads as the container's process env. Your INTERACTIVE `op` session
# never enters the container — only the resolved values do, and only for Hermes'
# own vault. This mirrors OpenClaw's per-agent runtime-secret snapshots.
#
# EXCEPTION (deliberate, narrow): if a read-only, Hermes-vault-scoped Service
# Account token is set (OP_SERVICE_ACCOUNT_TOKEN), it is ALSO written into the
# tmpfs env-file so the baked-in `op` can read LIVE credentials (e.g. rotating
# O'Reilly session tokens) from the Hermes vault at runtime. That single-vault
# read_items token is the only `op` credential that ever reaches the cage; keep
# the Hermes vault Hermes-only so its blast radius stays bounded.
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

# op must be authenticated. Unattended (systemd) → a 1Password Service Account
# token (OP_SERVICE_ACCOUNT_TOKEN, scoped to the Hermes-only vault). By hand → an
# interactive `op signin` session. Fail early with a clear message otherwise.
if ! op whoami >/dev/null 2>&1; then
  echo "1Password CLI not authenticated. Set OP_SERVICE_ACCOUNT_TOKEN (service) or run 'op signin' (by hand)." >&2
  exit 1
fi

umask 077
# -f: overwrite a stale tmpfs env-file without an interactive confirmation prompt
# (systemd ExecStartPre is non-interactive; without -f `op inject` aborts).
op inject -f -i "$TPL" -o "$OUT"

# Pass a Service Account token (if present) through to the container so its baked
# `op` is authenticated for live, read-only reads of the Hermes vault. Only the
# token reaches the container; the operator's interactive `op` session never does.
if [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  printf 'OP_SERVICE_ACCOUNT_TOKEN=%s\n' "$OP_SERVICE_ACCOUNT_TOKEN" >> "$OUT"
  echo "OP_SERVICE_ACCOUNT_TOKEN=present  ->  in-container \`op\` enabled (read-only)"
else
  echo "OP_SERVICE_ACCOUNT_TOKEN=absent   ->  in-container \`op\` NOT authenticated (interactive op-signin path)" >&2
fi

# Redacted verification only — report presence, never the value.
if grep -q '^OPENROUTER_API_KEY=.\+' "$OUT"; then
  echo "OPENROUTER_API_KEY=present  ->  $OUT (tmpfs, 0600)"
else
  echo "OPENROUTER_API_KEY=MISSING — check the op:// reference / vault grant" >&2
  exit 1
fi
