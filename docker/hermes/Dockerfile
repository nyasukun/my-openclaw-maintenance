# Hermes Agent — containerized, run in parallel with the OpenClaw gateway.
#
# Option B (host resolves secrets): NO 1Password token or secret value is baked
# into this image. Code (venv + source) lives in the image; runtime *state* lives
# in the /data volume (HERMES_HOME); *secrets* arrive only via the container's
# process env (compose `env_file`), materialized on the host by `op`. See
# docs/hermes-agent.md and ./README.md.

FROM debian:bookworm-slim

ARG HERMES_USER=hermes

# Pre-install the optional system packages the Hermes installer would otherwise
# want sudo for (ripgrep/ffmpeg) so the piped installer runs fully unprivileged.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git ripgrep ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Entrypoint asserts secrets are present (redacted) before launching Hermes.
COPY hermes-entrypoint.sh /usr/local/bin/hermes-entrypoint.sh
RUN chmod +x /usr/local/bin/hermes-entrypoint.sh

RUN useradd --create-home --shell /bin/bash "${HERMES_USER}"
USER ${HERMES_USER}
WORKDIR /home/${HERMES_USER}

# Bake the install (code + venv -> ~/.hermes/hermes-agent). No `hermes setup` is
# run here: setup needs secrets, and secrets never touch the image.
# Note: Node/Playwright browser extras are skipped on this slim base (no node);
# add them in a derived image if a skill needs a real browser.
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

ENV PATH="/home/${HERMES_USER}/.local/bin:${PATH}" \
    HERMES_HOME=/data \
    HERMES_IGNORE_USER_CONFIG=1 \
    XDG_CACHE_HOME=/home/${HERMES_USER}/.cache

# State only (sessions/skills/memory). Secrets are NEVER written here.
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/hermes-entrypoint.sh"]
# Default to the messaging gateway. For an interactive shell instead:
#   docker compose exec hermes hermes
CMD ["hermes", "gateway", "start"]
