# Hermes secret references template. SAFE TO COMMIT: this file holds
# only `op://` references, never values. `materialize-hermes-secrets.sh` runs
# `op inject` over it on the host and writes the resolved KEY=VALUE file to tmpfs;
# that resolved file is git-ignored (.env*) and never enters the image or volume.
#
# Point every reference at the Hermes-only 1Password vault. HARD CONSTRAINT: this
# vault MUST be disjoint from the ★1 Azabu and ★2 foxcale vaults and from the
# OpenClaw per-agent items. Hermes gets its own OpenRouter key and its own bot
# tokens — never reuse OpenClaw's. (See docs/hermes-agent.md.)

OPENROUTER_API_KEY=op://Hermes/openrouter/credential

# Optional messaging gateway — uncomment only with NEW, Hermes-only bot tokens so
# you never double-receive a platform OpenClaw's router-agent already polls:
# TELEGRAM_BOT_TOKEN=op://Hermes/telegram-hermes/token
# SLACK_BOT_TOKEN=op://Hermes/slack-hermes/bot-token
# SLACK_APP_TOKEN=op://Hermes/slack-hermes/app-token
# DISCORD_BOT_TOKEN=op://Hermes/discord-hermes/token
