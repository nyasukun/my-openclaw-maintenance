---
name: hermes-productivity-audit
description: Audit the running containerized Hermes Agent for productivity gaps and propose image/config/skill updates as a PR. Use when asked to "audit Hermes", review how Hermes is doing, or evolve the Hermes Docker image to make it more capable. Runs from the host (Claude Code or Codex); reads the live container, never auto-deploys.
metadata:
  type: maintenance
  target: containerized Hermes (docker/hermes/)
---

# Hermes productivity audit

You are auditing the **running containerized Hermes Agent** (`docker/hermes/`) to
answer one question: **what change to the Docker image / config / skills would make
Hermes more productive?** Hermes runs with full autonomy *inside* a read-only-rootfs
sandbox, so it cannot evolve its own image — that is your job, from outside, on a
cadence. You **propose** changes as a PR; a human reviews and applies them.

## Operating rules

- **Propose, don't deploy.** Make changes on a new branch and open a PR. Do **not**
  push to `main`, do **not** rebuild/redeploy the production daemon unattended.
- **Capability changes go in the IMAGE.** New packages/tools/system deps → edit
  `docker/hermes/Dockerfile`. Behaviour/model/autonomy → `docker-compose.yml` or the
  entrypoint's `hermes config set` block. New first-class skills → `skills/`.
- **Never weaken the cage.** Keep `read_only` rootfs, `cap_drop: ALL`, the host-side
  1Password boundary (no token in the container), and the autonomy env
  (`HERMES_YOLO_MODE`/`HERMES_ACCEPT_HOOKS`) intact unless explicitly asked.
- **`/data` is sacred.** Memory + self-authored skills live in the `hermes-data`
  volume and survive rebuilds. Never propose anything that wipes it; if a change is
  risky, note "run `docker/hermes/backup-hermes-data.sh` first" in the PR.

## Steps

1. **Collect signals** (no LLM):
   ```bash
   docker/hermes/audit/collect-signals.sh | tee /tmp/hermes-audit.md
   ```
2. **Separate live gaps from already-fixed history.** Many log errors are old
   (check timestamps vs the container's `started`). Only act on gaps that still
   reproduce or are structural. Confirm a gap is real before proposing a fix.
3. **Translate gaps → concrete improvements.** Typical mappings:
   - repeated `command not found: X` / `no module named Y` / "requirements not met"
     → bake `X`/`Y` into the Dockerfile (apt or `uv pip install ... --python <venv>`).
   - browser / `computer_use` errors → propose a derived image **with**
     Playwright/Chromium (drop `--skip-browser`, add system deps).
   - many self-authored skills around one theme → bundle a first-class skill in
     `skills/` or add the CLI/tool they shell out to.
   - frequent model timeouts / rate-limits → revisit the default model or add a
     `hermes fallback` chain.
4. **Make the change on a branch** off `main` (e.g. `hermes-audit-YYYYMMDD`). Edit
   the Dockerfile/compose/skills. Keep edits minimal and well-commented.
5. **Verify the build** before proposing, if feasible: `cd docker/hermes &&
   docker compose build` (this does NOT touch the running container or its volume).
6. **Open a PR** summarizing: the signals that justified each change, the diff, and
   the apply steps for after merge:
   ```bash
   docker/hermes/backup-hermes-data.sh           # snapshot first
   cd docker/hermes && docker compose build       # rebuild image (volume untouched)
   systemctl --user restart hermes.service        # redeploy onto new image
   docker compose exec -T hermes hermes doctor     # sanity
   ```
7. **If no change is warranted**, say so plainly — an audit that finds nothing
   actionable is a valid outcome. Do not invent work.

## Notes

- Background: `docs/hermes-agent.md` (Autonomy, Persistence, Model strategy).
- The signal collector reads logs/skills/config but avoids dumping raw conversation
  bodies; if you need more detail, read `/data/logs/*.log` directly via
  `docker compose exec`.
