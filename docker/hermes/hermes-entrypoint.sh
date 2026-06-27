#!/usr/bin/env bash
# Container entrypoint. Secrets are expected in the PROCESS ENV, injected
# by compose `env_file` from the host-side `op`-resolved tmpfs file. We assert
# presence only and never print a value (repo redaction convention).
set -euo pipefail

: "${OPENROUTER_API_KEY:?OPENROUTER_API_KEY missing — host op-materialize step did not run (see materialize-hermes-secrets.sh)}"

echo "hermes-entrypoint: OPENROUTER_API_KEY=present HERMES_HOME=${HERMES_HOME:-/data} model=${HERMES_MODEL:-<default>}"

exec "$@"
