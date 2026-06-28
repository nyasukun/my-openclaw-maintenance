#!/usr/bin/env bash
# Container entrypoint. Secrets are expected in the PROCESS ENV, injected
# by compose `env_file` from the host-side `op`-resolved tmpfs file. We assert
# presence only and never print a value (repo redaction convention).
set -euo pipefail

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY missing — host op-materialize step did not run (see materialize-hermes-secrets.sh)}"

# The gateway conversation loop reads its default model from config.yaml, not from
# the HERMES_INFERENCE_* env (which only covers oneshot/-z). Mirror the env-pinned
# model into config (under HERMES_HOME=/data) so Telegram/gateway replies use it
# too. Idempotent; runs every start so the repo/env stays the source of truth.
if [ -n "${HERMES_INFERENCE_MODEL:-}" ]; then
  # The agent reads model.default (and model.provider); model.name is NOT read.
  hermes config set model.provider "${HERMES_INFERENCE_PROVIDER:-openrouter}" >/dev/null 2>&1 || true
  hermes config set model.default "${HERMES_INFERENCE_MODEL}" >/dev/null 2>&1 || true
fi

echo "hermes-entrypoint: OPENROUTER_API_KEY=present HERMES_HOME=${HERMES_HOME:-/data} model=${HERMES_INFERENCE_MODEL:-<config-default>}"

exec "$@"
