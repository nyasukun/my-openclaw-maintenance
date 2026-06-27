#!/usr/bin/env bash
# Provision the Hermes-only 1Password vault + OpenRouter key item that
# hermes.env.tpl references (op://Hermes/openrouter/credential).
#
# Run in a terminal where `op` is signed in (`op signin` / `eval $(op signin)`);
# this needs your interactive 1Password session, so it can't run unattended. The
# OpenRouter API key is read from stdin (hidden) — never an argv/history value and
# never echoed. Idempotent: re-running skips anything that already exists.
#
# HARD CONSTRAINT: keep this vault disjoint from the ★1 Azabu / ★2 foxcale vaults
# and from OpenClaw's per-agent items (see ../../docs/hermes-agent.md).
set -euo pipefail

VAULT="${HERMES_VAULT:-Hermes}"

op whoami >/dev/null 2>&1 || { echo "Not signed in. Run 'op signin' first." >&2; exit 1; }

# 1) Vault
if op vault get "$VAULT" >/dev/null 2>&1; then
  echo "vault exists: $VAULT"
else
  op vault create "$VAULT" >/dev/null
  echo "created vault: $VAULT"
fi

# 2) OpenRouter key -> op://$VAULT/openrouter/credential
if op item get openrouter --vault "$VAULT" >/dev/null 2>&1; then
  echo "item exists: openrouter (leaving its value untouched)"
else
  printf 'Paste the Hermes-only OpenRouter API key (input hidden): '
  read -rs OR_KEY; echo
  [ -n "$OR_KEY" ] || { echo "empty key — aborted" >&2; exit 1; }
  # The "API Credential" category exposes a field named exactly "credential".
  op item create --category "API Credential" --vault "$VAULT" --title openrouter \
    "credential=${OR_KEY}" >/dev/null
  unset OR_KEY
  echo "created item: openrouter (field: credential)"
fi

echo
echo "Reference ready: op://$VAULT/openrouter/credential"
echo
echo "Optional — for the unattended systemd unit, create a vault-scoped service"
echo "account token (read-only) and drop it where the unit's EnvironmentFile expects:"
echo "  op service-account create hermes-runtime --vault '${VAULT}:read_items' --expires-in 90d"
echo "  mkdir -p ~/.config/hermes && chmod 600 ~/.config/hermes/op.env"
echo "  # then write: OP_SERVICE_ACCOUNT_TOKEN=<printed token>  into ~/.config/hermes/op.env"
