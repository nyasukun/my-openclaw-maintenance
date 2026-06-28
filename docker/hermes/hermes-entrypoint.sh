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

# Web tooling split by capability:
#  - search  -> ddgs (DuckDuckGo): keyless, free, unlimited (baked into the image).
#  - extract -> tavily: ddgs can't fetch page bodies, so URL extraction uses Tavily,
#    which needs TAVILY_API_KEY (injected from 1Password via the env-file). Until
#    that key is present, web_extract reports a missing key rather than silently
#    falling back to a search-only backend.
hermes config set web.search_backend ddgs >/dev/null 2>&1 || true
hermes config set web.extract_backend tavily >/dev/null 2>&1 || true

# Ensure the `/moa` escalation preset uses Fugu Ultra (paid, on-demand) — a single
# stronger model for "core" questions that auto-restores the default afterward. The
# preset is a nested/list structure `hermes config set` can't express, so write it
# with PyYAML. Non-clobbering (setdefault): only adds the preset/default if absent,
# so a later `hermes moa configure` is preserved.
"$HOME/.hermes/hermes-agent/venv/bin/python" - <<'PY' 2>/dev/null || true
import yaml
p = "/data/config.yaml"
try:
    c = yaml.safe_load(open(p)) or {}
except FileNotFoundError:
    c = {}
moa = c.setdefault("moa", {})
moa.setdefault("presets", {}).setdefault("fugu", {
    "reference_models": [{"provider": "openrouter", "model": "sakana/fugu-ultra"}],
    "aggregator": {"provider": "openrouter", "model": "sakana/fugu-ultra"},
})
moa.setdefault("default_preset", "fugu")
yaml.safe_dump(c, open(p, "w"), sort_keys=False)
PY

echo "hermes-entrypoint: OPENROUTER_API_KEY=present HERMES_HOME=${HERMES_HOME:-/data} model=${HERMES_INFERENCE_MODEL:-<config-default>} moa=fugu"

exec "$@"
