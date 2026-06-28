#!/usr/bin/env bash
# Productivity-audit signal collector for the containerized Hermes. NO LLM — just
# reads the running container's logs/skills/config and prints a focused Markdown
# report. An external auditor (Claude Code / Codex, via the
# `hermes-productivity-audit` skill) reads this to decide what image/config/skill
# changes would make Hermes more productive, then proposes them as a PR.
#
# Focuses on capability GAPS (missing tools/deps), self-authored skills, repeated
# failures, and resource ceilings. Avoids dumping raw conversation bodies.
#
# Usage: docker/hermes/audit/collect-signals.sh   (run from anywhere)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # docker/hermes
cd "$HERE"
SVC=hermes
ex() { docker compose exec -T "$SVC" bash -lc "$1" 2>/dev/null || true; }

echo "# Hermes productivity-audit signals"
echo "_collected $(date -u +%FT%TZ) — source: running \`$SVC\` container_"
echo

echo "## Container & health"
docker inspect -f 'state={{.State.Status}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$SVC" 2>/dev/null || echo "(container not found)"
echo '```'
docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}} pids={{.PIDs}}' "$SVC" 2>/dev/null || true
echo '```'
echo

echo "## Config, model & autonomy"
echo '```'
ex 'echo "model: $(hermes config show 2>/dev/null | grep -m1 Model:)"; echo "YOLO=$HERMES_YOLO_MODE ACCEPT_HOOKS=$HERMES_ACCEPT_HOOKS"; echo "moa default: $(hermes moa list 2>/dev/null | grep -m1 Default:)"'
echo '```'
echo

echo "## Capability gaps (what the agent lacked — strongest signal for image updates)"
echo "Counts of gap-indicating log lines across /data/logs:"
echo '```'
ex 'cat /data/logs/*.log 2>/dev/null | grep -hoiE "command not found|no module named [a-z0-9_.]+|requirements not met|ModuleNotFoundError|playwright|chromium|not installed|permission denied|read-only file system|No such file|pip install|apt-get|missing [A-Z_]+|unsupported|timed out|rate.?limit|quota" | sort | uniq -c | sort -rn | head -40'
echo '```'
echo "Recent distinct ERROR lines (deduped, metadata only):"
echo '```'
ex 'grep -hE "ERROR|CRITICAL" /data/logs/errors.log 2>/dev/null | sed -E "s/^[0-9T:.,+-]+ //; s/\[[0-9_a-f]+\]//g" | sort -u | tail -30'
echo '```'
echo

echo "## Self-authored skills (what Hermes is building — candidates to harden/equip)"
echo '```'
ex 'ls -t /data/skills 2>/dev/null | grep -vE "^\." | head -40; echo "---"; echo "curator: $(cat /data/skills/.curator_state 2>/dev/null | tr -d "\n" | head -c 400)"'
echo '```'
echo "Agent-created (non-bundled) skill roots:"
echo '```'
ex 'hermes curator status 2>/dev/null | head -30'
echo '```'
echo

echo "## Tools / commands the agent actually used (frequency)"
echo '```'
ex 'cat /data/logs/agent.log 2>/dev/null | grep -hoiE "tool[:= ]+[a-z_]+|shell|skill_manage|web_(search|fetch)|browser_|write_file|patch|memory" | sort | uniq -c | sort -rn | head -25'
echo '```'
echo

echo "## Image facts (what is baked vs deliberately skipped)"
echo '```'
echo "browser/playwright: build passes --skip-browser (no Chromium)"
ex 'command -v node >/dev/null && echo "node: $(node --version)" || echo "node: absent"; ~/.hermes/hermes-agent/venv/bin/python -c "import sys;print(\"python:\",sys.version.split()[0])"'
echo "apt extras baked: ripgrep ffmpeg git xz-utils (see Dockerfile)"
echo '```'
echo

echo "## Audit hints"
cat <<'HINTS'
- A high-count gap (e.g. "no module named X", "command not found: Y", repeated
  "requirements not met") usually means: bake X/Y into the Dockerfile.
- Browser/computer_use errors → consider a derived image WITH Playwright/Chromium.
- Many self-authored skills around one theme → bundle a first-class skill or add
  the tool/CLI they shell out to.
- Frequent model timeouts/rate-limits → revisit the default model or fallback chain.
- Remember: /data (memory + skills) persists across rebuilds; only the IMAGE changes.
HINTS
