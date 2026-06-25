# Runtime image for dynamic Workspace Artifacts + headless verification.
#
# Long-lived single container that the workspace-artifacts gateway plugin manages
# and proxies to. It runs the supervisor, which (a) lazily starts each dynamic
# artifact (npm start / node server.js) and proxies HTTP + WebSocket traffic, and
# (b) watches for `.verify/request.json` drops and renders artifacts in headless
# Chromium to produce a screenshot + structured diagnostics.
#
# Base is the official Playwright image, which already bundles Node + Chromium and
# all system libraries (so the image is large, ~1.5GB — this is intentional: the
# in-sandbox agent has no browser, and the gateway is unreachable from sandboxes,
# so verification happens here and is shared back over the workspace bind mount).
#
# Security posture (mirrors the OpenClaw sandbox stance):
#   - NO 1Password / runtime-secrets snapshot is ever mounted here.
#   - runs as uid 1000 (pwuser); the plugin runs it with --cap-drop ALL, resource
#     limits, and the supervisor port published to 127.0.0.1 only.
#   - egress is allowed so `npm ci` can fetch dependencies; this is the only
#     outbound exposure. Run with egress disabled + server.js-only artifacts for a
#     fully offline posture (verification still works — it renders local files).
#
# Build is driven by the plugin (ensureRuntimeContainer) or manually:
#   docker build -t openclaw-artifacts-runtime:0.1.0 plugins/workspace-artifacts/runtime
FROM mcr.microsoft.com/playwright:v1.61.0-noble

ENV NPM_CONFIG_CACHE=/home/pwuser/.npm \
    SUPERVISOR_PORT=7000 \
    ARTIFACTS_ROOT=/workspace/artifacts \
    BASE_PREFIX=/plugins/workspace-artifacts/run

WORKDIR /opt/artifacts-runtime
COPY package.json supervisor.mjs render.mjs ./
# Chromium is already present in the base image (PLAYWRIGHT_BROWSERS_PATH=/ms-playwright);
# we only need the playwright npm package to drive it.
RUN npm install --omit=dev --no-audit --no-fund \
    && mkdir -p /workspace/artifacts /workspace/canvas \
    && chown -R pwuser:pwuser /workspace /opt/artifacts-runtime /home/pwuser

USER pwuser
EXPOSE 7000
CMD ["node", "supervisor.mjs"]
