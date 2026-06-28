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

# Primary web capability is OpenRouter `:online` (search + page read), set via the
# model above — no extra keys. The keyless `ddgs` (DuckDuckGo) provider is kept as a
# free local-tool fallback for `web_search`. (No extract backend: `:online` reads
# pages; the key-based extract providers like Tavily are intentionally not wired.)
hermes config set web.search_backend ddgs >/dev/null 2>&1 || true

# Dashboard (remote gateway for Hermes Desktop) basic-auth. The 0.0.0.0 bind forces
# an auth provider; derive its password hash from HERMES_DASHBOARD_PASSWORD (injected
# from 1Password) so no credential is baked into the image or repo. Only runs when
# the password is provided; the dashboard service stays opt-in (compose profile).
if [ -n "${HERMES_DASHBOARD_PASSWORD:-}" ]; then
  "$HOME/.hermes/hermes-agent/venv/bin/python" - <<'PY' 2>/dev/null || true
import os, yaml
from plugins.dashboard_auth.basic import hash_password
p = "/data/config.yaml"
try:
    c = yaml.safe_load(open(p)) or {}
except FileNotFoundError:
    c = {}
ba = c.setdefault("dashboard", {}).setdefault("basic_auth", {})
ba["username"] = os.environ.get("HERMES_DASHBOARD_USER", "hermes")
ba["password_hash"] = hash_password(os.environ["HERMES_DASHBOARD_PASSWORD"])
yaml.safe_dump(c, open(p, "w"), sort_keys=False)
PY
fi

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

# Smartphone-safe PDF font. The oreilly-learning `build_pdf.py` skill embeds the
# font at /data/fonts/NotoSansCJKjp-{Regular,Bold}.otf into report PDFs. Noto Sans
# CJK is CFF/PostScript-outline → embeds as Type0/CIDFontType0(CFF), which Telegram's
# MOBILE viewer cannot render (Japanese garbles, though desktop + server raster are
# fine). The baked IPAexGothic is TrueType → embeds as CIDFontType2(TTF) → renders on
# phone AND PC, vector + searchable, no rasterization. Seed/repair those paths: replace
# a CFF ('OTTO' magic) or missing file with IPAex (backing the CFF up once); idempotent
# — a TrueType file is left untouched, so a later hand-placed TTF font is preserved.
IPAEX="/usr/share/fonts/opentype/ipaexfont-gothic/ipaexg.ttf"
if [ -f "$IPAEX" ]; then
  mkdir -p /data/fonts
  for f in NotoSansCJKjp-Regular.otf NotoSansCJKjp-Bold.otf; do
    dst="/data/fonts/$f"
    if [ -f "$dst" ] && [ "$(head -c4 "$dst" 2>/dev/null)" = "OTTO" ]; then
      [ -f "/data/fonts/.cff-backup/$f" ] || { mkdir -p /data/fonts/.cff-backup; cp -f "$dst" "/data/fonts/.cff-backup/$f"; }
      cp -f "$IPAEX" "$dst"
    elif [ ! -f "$dst" ]; then
      cp -f "$IPAEX" "$dst"
    fi
  done
fi

echo "hermes-entrypoint: OPENROUTER_API_KEY=present HERMES_HOME=${HERMES_HOME:-/data} model=${HERMES_INFERENCE_MODEL:-<config-default>} moa=fugu pdf_font=ipaex-ttf"

exec "$@"
