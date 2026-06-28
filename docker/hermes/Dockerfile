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

# NOTE: deliberately NOT setting HERMES_IGNORE_USER_CONFIG — it makes Hermes ignore
# /data/config.yaml, and the gateway conversation loop reads its default model from
# there (the HERMES_INFERENCE_* env only covers oneshot/-z). With it on, Telegram
# replies fail with "No models provided".
ENV PATH="/home/${HERMES_USER}/.local/bin:${PATH}" \
    HERMES_HOME=/data \
    XDG_CACHE_HOME=/home/${HERMES_USER}/.cache

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
