#!/usr/bin/env bash
# Back up the Hermes state volume (hermes_hermes-data -> /data): persistent memory,
# agent-generated skills, sessions, config, cron. This volume is the ONLY place
# Hermes' "growth" lives — keep these backups, and never `docker volume rm` the
# volume without one. Safe to run while the container is up (read-only mount).
#
# Usage:   backup-hermes-data.sh [OUT_DIR]      (default: ~/hermes-backups)
# Restore: stop the service, then
#   docker run --rm -v hermes_hermes-data:/data -v <dir>:/b alpine \
#     sh -c 'rm -rf /data/* /data/..?* /data/.[!.]* 2>/dev/null; tar xzf /b/<file>.tgz -C /data'
set -euo pipefail

VOL="${HERMES_VOLUME:-hermes_hermes-data}"
OUT_DIR="${1:-$HOME/hermes-backups}"

docker volume inspect "$VOL" >/dev/null 2>&1 || { echo "volume not found: $VOL" >&2; exit 1; }
mkdir -p "$OUT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="hermes-data-$STAMP.tgz"

docker run --rm -v "$VOL":/data:ro -v "$OUT_DIR":/backup alpine \
  tar czf "/backup/$FILE" -C /data .

echo "backup written: $OUT_DIR/$FILE ($(du -h "$OUT_DIR/$FILE" | cut -f1))"
