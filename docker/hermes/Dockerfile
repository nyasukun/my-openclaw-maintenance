# Hermes Agent — containerized, run in parallel with the OpenClaw gateway.
#
# Host resolves secrets: NO 1Password token or secret value is baked into this
# image. Code (venv + source) lives in the image; runtime *state* lives in the
# /data volume (HERMES_HOME); *secrets* arrive only via the container's process env
# (compose `env_file`), materialized on the host by `op`. See docs/hermes-agent.md
# and ./README.md.

FROM debian:bookworm-slim

ARG HERMES_USER=hermes

# Pre-install the optional system packages the Hermes installer would otherwise
# want sudo for (ripgrep/ffmpeg), plus xz-utils (the installer's managed Node 22 is
# a .tar.xz and `tar` aborts under set -e without xz). Then the piped installer runs
# fully unprivileged.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git ripgrep ffmpeg xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash "${HERMES_USER}"
USER ${HERMES_USER}
WORKDIR /home/${HERMES_USER}

# Bake the install (code + venv -> ~/.hermes/hermes-agent). Flags:
#   --skip-setup   no interactive wizard (we configure via env + entrypoint)
#   --skip-browser no Playwright/Chromium (needs sudo system deps + a large
#                  download; add it in a derived image if a skill needs a browser)
#   --non-interactive  never prompt during the image build
# The installer still installs its own managed Node 22 (unconditional, .tar.xz) —
# hence xz-utils above; without it `tar` aborts under set -e.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh \
    | bash -s -- --skip-setup --skip-browser --non-interactive

# The installer ships only the core package; the messaging-platform adapters
# (Telegram/Slack/Discord) live in the `messaging` extra. Install it into the
# uv-managed venv so `hermes gateway` can create platform adapters — without it a
# configured TELEGRAM_BOT_TOKEN logs "requirements not met" and the bot stays silent.
RUN /home/${HERMES_USER}/.hermes/bin/uv pip install \
        --python /home/${HERMES_USER}/.hermes/hermes-agent/venv/bin/python \
        "hermes-agent[messaging] @ /home/${HERMES_USER}/.hermes/hermes-agent"

# Keyless web search: the bundled `ddgs` (DuckDuckGo) provider needs the `ddgs`
# package, which the base install omits. Without it `web_search` returns "ddgs
# package is not installed" and the agent silently falls back to local search only.
# (exa/tavily/firecrawl/brave-free all require API keys; ddgs is the no-key path.)
RUN /home/${HERMES_USER}/.hermes/bin/uv pip install \
        --python /home/${HERMES_USER}/.hermes/hermes-agent/venv/bin/python \
        ddgs

# PDF generation toolchain for report skills (e.g. oreilly-learning/build_pdf.py:
# Markdown -> figure-embedded PDF, with a --rasterize path via PyMuPDF for
# no-mojibake delivery to unknown viewers). Without these the skills hand-vendor
# the wheels into /data/pylib at runtime — fragile, since the venv has no pip and
# the rootfs is read-only, so a wiped /data volume silently breaks all PDF output.
# Baking them into the venv makes PDF generation a property of the IMAGE (code),
# not of /data (state). fpdf2 provides `fpdf`; pymupdf provides `fitz`. (markdown
# and pillow already ship with the base install.)
RUN /home/${HERMES_USER}/.hermes/bin/uv pip install \
        --python /home/${HERMES_USER}/.hermes/hermes-agent/venv/bin/python \
        fpdf2 pymupdf pypdf fonttools defusedxml

# Build the dashboard web UI into the image. The package ships source (web/), not a
# prebuilt dist, and `hermes dashboard --skip-build` refuses to start without the
# built UI at site-packages/hermes_cli/web_dist. The read-only runtime rootfs can't
# build on launch, so bake it here. Needed to serve the Hermes Desktop / web client.
# vite outputs to the SOURCE tree (hermes_cli/web_dist), but `hermes` runs from the
# installed package in the venv site-packages — copy the built dist there so
# `hermes dashboard --skip-build` finds it.
RUN export PATH="/home/${HERMES_USER}/.hermes/node/bin:${PATH}" \
    && cd /home/${HERMES_USER}/.hermes/hermes-agent \
    && npm install --workspace web --no-audit --no-fund \
    && npm run build -w web \
    && rm -rf venv/lib/python3.11/site-packages/hermes_cli/web_dist \
    && cp -r hermes_cli/web_dist venv/lib/python3.11/site-packages/hermes_cli/web_dist \
    && rm -rf web/node_modules

# --- Runtime tooling for self-authored skills (root for apt/pip) -------------
# python3+requests+beautifulsoup4 and jq give skills an HTTP/HTML/JSON toolkit
# (e.g. scraping O'Reilly Learning). `op` (1Password CLI) is baked so a skill can
# read LIVE, rotating credentials from the Hermes vault at runtime — but NO token
# is baked here: the image only carries the *binary*. The read-only,
# Hermes-vault-scoped Service Account token arrives at runtime as process env
# (OP_SERVICE_ACCOUNT_TOKEN, via the tmpfs env-file). This is a DELIBERATE, NARROW
# exception to the "no op in the cage" rule: the operator's interactive `op`
# session still never enters; only a single-vault read_items token does. Keep the
# Hermes vault Hermes-only so the blast radius stays bounded. See docs/hermes-agent.md.
USER root
# fonts-noto-cjk / -color-emoji: the base image ships only DejaVu (no CJK glyphs),
# so ANY rendering path that hits fontconfig (matplotlib charts, image generation,
# PDF rasterization, vision overlays) renders Japanese/Chinese/Korean as tofu □□□.
# Baking system CJK + emoji fonts fixes every such path at once. fontconfig +
# fc-cache so the new fonts are indexed at build time, not first use on read-only rootfs.
#
# fonts-ipaexfont-gothic (TrueType): the SMARTPHONE-SAFE PDF font. Noto Sans CJK is
# CFF/PostScript-outline → fpdf2 embeds it as Type0/CIDFontType0(CFF), which Telegram's
# MOBILE viewer cannot render (garbles Japanese, though desktop viewers + server-side
# raster are fine). A TrueType-outline font (IPAexGothic) embeds as CIDFontType2(TTF),
# which mobile viewers DO render — so report PDFs stay small + text-searchable (no
# rasterization) and read correctly on phone AND PC. The entrypoint seeds it into
# build_pdf's /data/fonts so generated PDFs use it. Verified end-to-end 2026-06-28.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip jq curl gnupg ca-certificates \
        fontconfig fonts-noto-cjk fonts-noto-color-emoji fonts-ipaexfont-gothic \
    && mkdir -p /etc/fonts \
    && printf '%s\n' \
        '<?xml version="1.0"?>' \
        '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' \
        '<fontconfig><cachedir>/tmp/fontconfig</cachedir></fontconfig>' \
        > /etc/fonts/local.conf \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*
# fontconfig writable cache (local.conf above): the runtime rootfs is read-only and
# the compose tmpfs at ~/.cache is root-owned, so fontconfig (running as `hermes`)
# can write to neither /var/cache/fontconfig nor $XDG_CACHE_HOME/fontconfig →
# "Fontconfig error: No writable cache directories" on every font lookup (works but
# re-scans each call). /tmp is a world-writable tmpfs, so pointing the cachedir there
# gives fontconfig a writable cache without touching XDG_CACHE_HOME (uv/python use it).
RUN pip3 install --no-cache-dir --break-system-packages requests beautifulsoup4
RUN curl -sS https://downloads.1password.com/linux/keys/1password.asc \
        | gpg --dearmor -o /usr/share/keyrings/1password-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" \
        > /etc/apt/sources.list.d/1password.list \
    && apt-get update && apt-get install -y --no-install-recommends 1password-cli \
    && rm -rf /var/lib/apt/lists/*
USER ${HERMES_USER}

# NOTE: deliberately NOT setting HERMES_IGNORE_USER_CONFIG — it makes Hermes ignore
# /data/config.yaml, and the gateway conversation loop reads its default model from
# there (the HERMES_INFERENCE_* env only covers oneshot/-z). With it on, Telegram
# replies fail with "No models provided".
# UTF-8 locale. The base image sets no locale (LANG/LC_ALL/PYTHONIOENCODING all
# unset → C/POSIX), which mangles non-ASCII text (e.g. Japanese Telegram captions
# arrive 文字化け/mojibake) at Python subprocess/pipe boundaries on the gateway
# delivery path. C.UTF-8 is built into glibc (bookworm), so no `locales` package or
# locale-gen is needed. PYTHONIOENCODING is belt-and-suspenders for pipe encoding.
# This is OS-level runtime locale, not Hermes behaviour config — image ENV is its
# correct home (not .env, not config.yaml).
ENV PATH="/home/${HERMES_USER}/.local/bin:${PATH}" \
    HERMES_HOME=/data \
    XDG_CACHE_HOME=/home/${HERMES_USER}/.cache \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONIOENCODING=utf-8

# The /data state volume must be writable by the non-root runtime user. Create it
# owned by hermes in the image so Docker initializes the (empty) named volume with
# that ownership on first mount.
USER root
RUN mkdir -p /data && chown "${HERMES_USER}:${HERMES_USER}" /data
# Entrypoint copied last so edits to it don't invalidate the heavy install layers.
COPY hermes-entrypoint.sh /usr/local/bin/hermes-entrypoint.sh
RUN chmod +x /usr/local/bin/hermes-entrypoint.sh
USER ${HERMES_USER}

VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/hermes-entrypoint.sh"]
# Run the gateway as the container's main process (`run`, not `start`: `start`
# manages a host service and refuses inside a container). Idles safely with no
# messaging platforms configured. For an interactive shell instead:
#   docker compose exec hermes hermes
CMD ["hermes", "gateway", "run"]
