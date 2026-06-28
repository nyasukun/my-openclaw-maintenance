# Hermes 1Password secret-reference template. SAFE TO COMMIT: only references,
# never values. materialize-hermes-secrets.sh runs `op inject` over this file on
# the host and writes the resolved KEY=VALUE to tmpfs (git-ignored, never in the
# image or volume).
#
# GOTCHA: `op inject` resolves EVERY reference token in this file regardless of
# shell-style "#" comments — a commented example line is still resolved and will
# fail if the item does not exist. So keep ONLY references you actually want
# resolved here, and do not write the reference scheme in prose comments.
#
# Point each reference at the Hermes-only 1Password vault — disjoint from the
# ★1 Azabu / ★2 foxcale vaults and from OpenClaw's items (see docs/hermes-agent.md).
# To run the messaging gateway, add a line with a NEW, Hermes-only token, e.g.
#   TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, DISCORD_BOT_TOKEN
# each pointing at its own reference in the Hermes vault.

OPENROUTER_API_KEY=op://Hermes/openrouter/credential
TELEGRAM_BOT_TOKEN=op://Hermes/telegram-hermes/token
