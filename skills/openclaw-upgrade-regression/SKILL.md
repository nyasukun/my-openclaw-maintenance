---
name: openclaw-upgrade-regression
description: Use from local Codex, outside OpenClaw, after upgrading OpenClaw on yasu@192.168.86.103 to check for regressions and reapply the guarded usage-page hotfix only when needed.
metadata:
  short-description: Check and repair OpenClaw upgrade regressions
---

# OpenClaw Upgrade Regression

Use this from local Codex after any OpenClaw upgrade or reinstall on `yasu@192.168.86.103`. This is not an OpenClaw agent skill; do not add it to OpenClaw's agent skill allowlist.

Goal: connect over SSH, detect whether upstream OpenClaw already preserves the local fixes, and only patch installed OpenClaw files when behavior regressed and the known code shape is still present.

## Safety Rules

- Run checks from local Codex with `ssh yasu@192.168.86.103 '...'`; avoid an interactive SSH shell unless necessary.
- Do not print or copy secrets from remote `/home/yasu/.openclaw/openclaw.json`.
- Back up every file before editing under `/home/yasu/.npm-global/lib/node_modules/openclaw/dist`.
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
ssh yasu@192.168.86.103 'openclaw --version'
ssh yasu@192.168.86.103 'openclaw gateway status'
ssh yasu@192.168.86.103 'openclaw sessions --agent long --json --limit 20 | jq "[.. | objects | select((.totalTokens? // 0) > 0)] | length"'
```

Pick a date with known `long` usage, usually today or the latest `updatedAt` date from `openclaw sessions --agent long`.

```bash
DATE=2026-05-28
ssh yasu@192.168.86.103 "openclaw gateway call sessions.usage --json --params '{\"agentId\":\"long\",\"startDate\":\"$DATE\",\"endDate\":\"$DATE\",\"limit\":1000,\"includeContextWeight\":true}' | jq '{sessions:(.sessions|length), totals:.totals, cacheStatus:.cacheStatus}'"
ssh yasu@192.168.86.103 "openclaw gateway call usage.cost --json --params '{\"agentId\":\"long\",\"startDate\":\"$DATE\",\"endDate\":\"$DATE\"}' | jq '{daily, totals, cacheStatus}'"
```

Interpretation:

- If `sessions.usage` finds long sessions and `usage.cost.totals.totalTokens` is nonzero, the backend is good.
- If `sessions.usage` finds long sessions but `usage.cost` stays zero or only reports main-cache files, inspect and patch.
- If both are zero, first confirm the date and that long session logs actually contain usage.

## Source Checks

Important files:

```text
/home/yasu/.npm-global/lib/node_modules/openclaw/dist/server-methods-*.js
/home/yasu/.npm-global/lib/node_modules/openclaw/dist/control-ui/index.html
/home/yasu/.npm-global/lib/node_modules/openclaw/dist/control-ui/assets/index-*.js
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
ssh yasu@192.168.86.103 'grep -RIn "\"usage.cost\": async" /home/yasu/.npm-global/lib/node_modules/openclaw/dist/server-methods-*.js'
ssh yasu@192.168.86.103 'grep -RIn "agentId:ZS(e).*sessions.usage\\|sessions.usage.*agentId:ZS(e)" /home/yasu/.npm-global/lib/node_modules/openclaw/dist/control-ui/assets/index-*.js'
ssh yasu@192.168.86.103 'grep -RIn "agentId:ZS(e).*usage.cost\\|usage.cost.*agentId:ZS(e)" /home/yasu/.npm-global/lib/node_modules/openclaw/dist/control-ui/assets/index-*.js'
```

## Patch Procedure

Only continue if the behavior check fails and source checks show the old code shape.

1. Create a timestamped backup:

```bash
ssh yasu@192.168.86.103 'set -e
TS=$(date +%Y%m%d%H%M%S)
BACKUP=/home/yasu/.openclaw/codex-backups/usage-ui-hotfix-$TS
mkdir -p "$BACKUP"
cp /home/yasu/.npm-global/lib/node_modules/openclaw/dist/server-methods-*.js "$BACKUP"/
cp /home/yasu/.npm-global/lib/node_modules/openclaw/dist/control-ui/index.html "$BACKUP"/
cp /home/yasu/.npm-global/lib/node_modules/openclaw/dist/control-ui/assets/index-*.js "$BACKUP"/
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
ssh yasu@192.168.86.103 'node --check /home/yasu/.npm-global/lib/node_modules/openclaw/dist/server-methods-*.js'
ssh yasu@192.168.86.103 'node --check /home/yasu/.npm-global/lib/node_modules/openclaw/dist/control-ui/assets/index-*.codex-usage-agentid.js'
ssh yasu@192.168.86.103 'openclaw gateway restart'
ssh yasu@192.168.86.103 'systemctl --user is-active openclaw-gateway.service'
```

5. Verify behavior:

```bash
DATE=2026-05-28
ssh yasu@192.168.86.103 "openclaw gateway call usage.cost --json --params '{\"agentId\":\"long\",\"startDate\":\"$DATE\",\"endDate\":\"$DATE\"}' | jq '{daily, totals, cacheStatus}'"
ssh yasu@192.168.86.103 'curl -sS http://127.0.0.1:18789/ | grep "codex-usage-agentid" || true'
```

If `cacheStatus.status` is `refreshing`, wait a few seconds and rerun. The final expected status is `fresh` with nonzero totals for dates where `long` has usage.

## Current Baseline

As of 2026-05-28, the local hotfix produced this known-good backend result for `long` on `2026-05-28`:

```text
totalTokens: 798442
totalCost: 1.3130598
cacheStatus.status: fresh
```

Do not hard-code these numbers as pass/fail forever. They are just a sanity anchor for this environment.
