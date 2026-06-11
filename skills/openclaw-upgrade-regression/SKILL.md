---
name: openclaw-upgrade-regression
description: Use from local Codex, outside OpenClaw, after upgrading a target OpenClaw host to check for regressions and reapply the guarded usage-page hotfix only when needed.
metadata:
  short-description: Check and repair OpenClaw upgrade regressions
---

# OpenClaw Upgrade Regression

Use this from local Codex after any OpenClaw upgrade or reinstall on a target host. Set `OPENCLAW_TARGET` to the SSH target, for example `user@host`. This is not an OpenClaw agent skill; do not add it to OpenClaw's agent skill allowlist.

Goal: connect over SSH, detect whether upstream OpenClaw already preserves the local fixes, and only patch installed OpenClaw files when behavior regressed and the known code shape is still present.

## Safety Rules

- Run checks from local Codex with `ssh "$OPENCLAW_TARGET" '...'`; avoid an interactive SSH shell unless necessary.
- Do not print or copy secrets from remote `~/.openclaw/openclaw.json`.
- Back up every file before editing under the remote OpenClaw npm install directory.
- Prefer behavior checks over string checks. If upstream is fixed, report "no patch needed".
- If code patterns do not match, stop and report that OpenClaw changed; do not force a blind patch.
- After any patch, run syntax checks, restart the gateway, and verify RPC output.

## Known Local Fix

Problem fixed on 2026-05-28: Control UI "Usage" showed zero for `long` sessions because:

- `usage.cost` ignored `agentId` and always read the default/main usage cache.
- Control UI called `sessions.usage` and `usage.cost` without passing the current session's agent id.

Expected fixed behavior:

- `sessions.usage` with `agentId:"long"` returns `long` sessions for the selected date.
- `usage.cost` with `agentId:"long"` returns matching nonzero totals when the `long` session logs have usage.
- UI request payloads include `agentId:ZS(e)` for both `sessions.usage` and `usage.cost`.

## Quick Check

Run these from local Codex:

```bash
ssh "$OPENCLAW_TARGET" 'openclaw --version'
ssh "$OPENCLAW_TARGET" 'openclaw gateway status'
ssh "$OPENCLAW_TARGET" 'openclaw sessions --agent long --json --limit 20 | jq "[.. | objects | select((.totalTokens? // 0) > 0)] | length"'
```

Pick a date with known `long` usage, usually today or the latest `updatedAt` date from `openclaw sessions --agent long`.

```bash
DATE=2026-05-28
ssh "$OPENCLAW_TARGET" "openclaw gateway call sessions.usage --json --params '{\"agentId\":\"long\",\"startDate\":\"$DATE\",\"endDate\":\"$DATE\",\"limit\":1000,\"includeContextWeight\":true}' | jq '{sessions:(.sessions|length), totals:.totals, cacheStatus:.cacheStatus}'"
ssh "$OPENCLAW_TARGET" "openclaw gateway call usage.cost --json --params '{\"agentId\":\"long\",\"startDate\":\"$DATE\",\"endDate\":\"$DATE\"}' | jq '{daily, totals, cacheStatus}'"
```

Interpretation:

- If `sessions.usage` finds long sessions and `usage.cost.totals.totalTokens` is nonzero, the backend is good.
- If `sessions.usage` finds long sessions but `usage.cost` stays zero or only reports main-cache files, inspect and patch.
- If both are zero, first confirm the date and that long session logs actually contain usage.

## Source Checks

Important files:

```text
${OPENCLAW_NPM_GLOBAL:-~/.npm-global}/lib/node_modules/openclaw/dist/server-methods-*.js
${OPENCLAW_NPM_GLOBAL:-~/.npm-global}/lib/node_modules/openclaw/dist/control-ui/index.html
${OPENCLAW_NPM_GLOBAL:-~/.npm-global}/lib/node_modules/openclaw/dist/control-ui/assets/index-*.js
```

Server-side requirements:

- In `loadCostUsageSummaryCached(params)`, cache key includes `agentId`.
- The call to `loadCostUsageSummaryFromCache(...)` passes `agentId`.
- The `"usage.cost"` handler normalizes `params.agentId` and passes it to `loadCostUsageSummaryCached(...)`.

UI requirements:

- The usage-page call to `sessions.usage` includes `agentId:ZS(e)`.
- The usage-page call to `usage.cost` includes `agentId:ZS(e)`.
- `index.html` loads an asset containing those calls. A local hotfix may use a file named like `index-*.codex-usage-agentid.js` to avoid stale browser/service-worker caches.

Useful grep checks:

```bash
ssh "$OPENCLAW_TARGET" 'grep -RIn "\"usage.cost\": async" "${OPENCLAW_NPM_GLOBAL:-$HOME/.npm-global}"/lib/node_modules/openclaw/dist/server-methods-*.js'
ssh "$OPENCLAW_TARGET" 'grep -RIn "agentId:ZS(e).*sessions.usage\\|sessions.usage.*agentId:ZS(e)" "${OPENCLAW_NPM_GLOBAL:-$HOME/.npm-global}"/lib/node_modules/openclaw/dist/control-ui/assets/index-*.js'
ssh "$OPENCLAW_TARGET" 'grep -RIn "agentId:ZS(e).*usage.cost\\|usage.cost.*agentId:ZS(e)" "${OPENCLAW_NPM_GLOBAL:-$HOME/.npm-global}"/lib/node_modules/openclaw/dist/control-ui/assets/index-*.js'
```

## Patch Procedure

Only continue if the behavior check fails and source checks show the old code shape.

1. Create a timestamped backup:

```bash
ssh "$OPENCLAW_TARGET" 'set -e
TS=$(date +%Y%m%d%H%M%S)
OPENCLAW_NPM_GLOBAL=${OPENCLAW_NPM_GLOBAL:-$HOME/.npm-global}
BACKUP=$HOME/.openclaw/codex-backups/usage-ui-hotfix-$TS
mkdir -p "$BACKUP"
cp "$OPENCLAW_NPM_GLOBAL"/lib/node_modules/openclaw/dist/server-methods-*.js "$BACKUP"/
cp "$OPENCLAW_NPM_GLOBAL"/lib/node_modules/openclaw/dist/control-ui/index.html "$BACKUP"/
cp "$OPENCLAW_NPM_GLOBAL"/lib/node_modules/openclaw/dist/control-ui/assets/index-*.js "$BACKUP"/
printf "backup=%s\n" "$BACKUP"'
```

2. Patch the server method module.

Find `async function loadCostUsageSummaryCached(params)`. Change it so it derives `const agentId = params.agentId`, includes that in the cache key, and passes `agentId` into `loadCostUsageSummaryFromCache`.

Then find the `"usage.cost"` handler. After `parseDateRange(...)`, normalize the requested agent:

```js
const requestedAgentId = normalizeOptionalString$1(params?.agentId);
const effectiveAgentId = normalizeAgentId(requestedAgentId ?? resolveDefaultAgentId(config));
```

Pass `agentId: effectiveAgentId` into `loadCostUsageSummaryCached(...)`.

3. Patch the Control UI asset.

Find the minified usage request pair similar to:

```js
n.request(`sessions.usage`,{startDate:r,endDate:i,...o,...s,limit:1e3,includeContextWeight:!0}),n.request(`usage.cost`,{startDate:r,endDate:i,...o})
```

Change it to include the current agent id:

```js
n.request(`sessions.usage`,{startDate:r,endDate:i,...o,...s,agentId:ZS(e),limit:1e3,includeContextWeight:!0}),n.request(`usage.cost`,{startDate:r,endDate:i,...o,agentId:ZS(e)})
```

Prefer writing the patched asset as a new filename, for example:

```text
index-BUILD.codex-usage-agentid.js
```

Then update `control-ui/index.html` to load that new asset.

4. Validate and restart:

```bash
ssh "$OPENCLAW_TARGET" 'node --check "${OPENCLAW_NPM_GLOBAL:-$HOME/.npm-global}"/lib/node_modules/openclaw/dist/server-methods-*.js'
ssh "$OPENCLAW_TARGET" 'node --check "${OPENCLAW_NPM_GLOBAL:-$HOME/.npm-global}"/lib/node_modules/openclaw/dist/control-ui/assets/index-*.codex-usage-agentid.js'
ssh "$OPENCLAW_TARGET" 'openclaw gateway restart'
ssh "$OPENCLAW_TARGET" 'systemctl --user is-active openclaw-gateway.service'
```

5. Verify behavior:

```bash
DATE=2026-05-28
ssh "$OPENCLAW_TARGET" "openclaw gateway call usage.cost --json --params '{\"agentId\":\"long\",\"startDate\":\"$DATE\",\"endDate\":\"$DATE\"}' | jq '{daily, totals, cacheStatus}'"
ssh "$OPENCLAW_TARGET" 'curl -sS http://127.0.0.1:18789/ | grep "codex-usage-agentid" || true'
```

If `cacheStatus.status` is `refreshing`, wait a few seconds and rerun. The final expected status is `fresh` with nonzero totals for dates where `long` has usage.

## Current Baseline

As of 2026-05-31, upgrading the local install from OpenClaw `2026.5.22`
to `2026.5.28` did not need the local hotfix reapplied. The upstream
code shape changed enough that the old minified string checks no longer
matched, but behavior checks passed after `openclaw gateway restart`.

Known-good backend result for `long` on `2026-05-28` after that upgrade:

```text
OpenClaw CLI version: 2026.5.28
OpenClaw Gateway version: 2026.5.28
usage.cost totalTokens: 1402020
usage.cost totalCost: 2.7405108
usage.cost cacheStatus.status: fresh
sessions.usage totals.totalTokens: 1402020
sessions.usage cacheStatus.status: fresh
```

Conclusion: no patch was needed for `2026.5.28`; behavior checks are the
source of truth when source string checks fail because upstream changed.

As of 2026-05-28, the local hotfix produced this known-good backend result for `long` on `2026-05-28`:

```text
totalTokens: 798442
totalCost: 1.3130598
cacheStatus.status: fresh
```

Do not hard-code these numbers as pass/fail forever. They are just a sanity anchor for this environment.
