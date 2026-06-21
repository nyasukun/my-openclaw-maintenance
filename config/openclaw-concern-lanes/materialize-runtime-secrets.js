#!/usr/bin/env node
"use strict";

// Per-agent runtime secret materializer for the concern-lane deployment.
//
// Replaces the single aggregate runtime-secrets/local.json (which was bind-mounted
// into EVERY sandbox) with one snapshot per agent:
//
//   /home/yasu/.openclaw/runtime-secrets/_common/local.json      (no scoped secrets)
//   /home/yasu/.openclaw/runtime-secrets/<agent-id>/local.json   (only that agent's grants)
//
// Each sandbox bind-mounts only its own directory read-only at /run/openclaw-secrets,
// so a lane can never read another lane's credentials even if prompt-injected. This
// is the host-boundary enforcement ("complete mediation") behind vault-access-map.json.
//
// Sources: OWASP LLM06:2025 Excessive Agency (minimize permissions; downstream
// authorization), NIST SP 800-207 (least-privilege per-request access), 1Password
// (dedicated, minimally-scoped vaults).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = process.env.OPENCLAW_REPO_ROOT || "/home/yasu/work/my-openclaw-maintenance";
const mapPath =
  process.env.OPENCLAW_VAULT_ACCESS_MAP ||
  path.join(repoRoot, "config/openclaw-concern-lanes/vault-access-map.json");
const requestPath =
  process.env.OPENCLAW_RUNTIME_SECRET_REQUESTS ||
  "/home/yasu/.openclaw/secrets/runtime-secret-requests.json";
const outRoot = process.env.OPENCLAW_RUNTIME_SECRETS_DIR || "/home/yasu/.openclaw/runtime-secrets";
const op = process.env.OP_BIN || "/usr/bin/op";
const dryRun = process.argv.includes("--dry-run");

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function isSafeName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value));
}

function isSafeRefPart(value) {
  return /^[A-Za-z0-9._:-]+$/.test(String(value)) && value !== "." && value !== "..";
}

function isSafeAgentId(value) {
  return /^[A-Za-z0-9_-]+$/.test(String(value)) && value !== "." && value !== "..";
}

function loadServiceAccountEnv() {
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) return;
  const envPath =
    process.env.OP_SERVICE_ACCOUNT_ENV ||
    "/home/yasu/.openclaw/secrets/1password-service-account.env";
  try {
    const data = fs.readFileSync(envPath, "utf8");
    for (const raw of data.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1);
      }
      if (key === "OP_SERVICE_ACCOUNT_TOKEN") process.env.OP_SERVICE_ACCOUNT_TOKEN = value;
    }
  } catch {}
}

// Build the set of vaults each agent is authorized to read (common + own).
function allowedVaultsByAgent(map) {
  const result = new Map();
  const common = map.common_vault || "openclaw-pod";
  for (const [agent, spec] of Object.entries(map.agents || {})) {
    const vaults = new Set([common, ...(spec.vaults || [])]);
    result.set(agent, vaults);
  }
  return result;
}

// Normalize and validate a single secret grant.
function normalizeGrant(raw) {
  const grant = {
    name: raw.name,
    agents: Array.isArray(raw.agents) ? raw.agents : [],
    vault: raw.vault,
    vaultFallbacks: Array.isArray(raw.vault_fallbacks) ? raw.vault_fallbacks : [],
    item: raw.item,
    field: raw.field,
    purpose: raw.purpose || ""
  };
  if (!isSafeName(grant.name)) throw new Error(`invalid env name: ${grant.name}`);
  if (!grant.agents.length) throw new Error(`grant ${grant.name} has no agents`);
  for (const agent of grant.agents) {
    if (!isSafeAgentId(agent)) throw new Error(`invalid agent id in grant ${grant.name}: ${agent}`);
  }
  for (const vault of [grant.vault, ...grant.vaultFallbacks]) {
    if (!vault || !isSafeRefPart(vault)) throw new Error(`invalid vault for ${grant.name}: ${vault}`);
  }
  if (!grant.item || !isSafeRefPart(grant.item)) throw new Error(`invalid item for ${grant.name}`);
  if (!grant.field || String(grant.field).split("/").some((p) => !isSafeRefPart(p))) {
    throw new Error(`invalid field for ${grant.name}`);
  }
  return grant;
}

// Operator-supplied extra grants. Same per-agent shape as runtime-secret-requests.json:
//   { "agents": { "<agent-id>": { "env": { "NAME": { vault, item, field, purpose } } } } }
function loadExtraGrants() {
  const data = loadJson(requestPath, { version: 1, agents: {} });
  const grants = [];
  for (const [agent, config] of Object.entries(data.agents || {})) {
    for (const [name, raw] of Object.entries(config.env || {})) {
      grants.push(
        normalizeGrant({
          name,
          agents: [agent],
          vault: raw.vault,
          vault_fallbacks: raw.vault_fallbacks,
          item: raw.item,
          field: raw.field,
          purpose: raw.purpose
        })
      );
    }
  }
  return grants;
}

function opRead(vault, item, field) {
  const ref = `op://${vault}/${item}/${field}`;
  const result = spawnSync(op, ["read", ref], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) return null;
  return result.stdout.replace(/\r?\n$/, "");
}

// Resolve a grant's value, honoring the agent's authorized vault set and trying
// the primary vault before any fallbacks. Returns { value, vault } or throws.
function resolveGrant(grant, allowed) {
  const candidates = [grant.vault, ...grant.vaultFallbacks];
  for (const vault of candidates) {
    if (!allowed.has(vault)) continue; // defense in depth: never read an unauthorized vault
    if (dryRun) return { value: `<dry-run:${vault}>`, vault };
    const value = opRead(vault, grant.item, grant.field);
    if (value !== null) return { value, vault };
  }
  throw new Error(
    `could not resolve ${grant.name} from authorized vaults [${candidates.join(", ")}]`
  );
}

function writeAgentSnapshot(agentId, env, sources) {
  const dir = path.join(outRoot, agentId);
  const file = path.join(dir, "local.json");
  const data = { generated_at: new Date().toISOString(), agent: agentId, env, sources };
  if (dryRun) {
    console.log(`[dry-run] would write ${file} with keys: ${Object.keys(env).join(", ") || "(none)"}`);
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  console.log(`wrote ${file} (${Object.keys(env).length} secret(s))`);
}

function main() {
  loadServiceAccountEnv();
  const map = loadJson(mapPath, null);
  if (!map || !map.agents) throw new Error(`vault access map not found or invalid: ${mapPath}`);

  const allowedByAgent = allowedVaultsByAgent(map);
  const grants = [
    ...(map.runtime_secret_grants || []).map(normalizeGrant),
    ...loadExtraGrants()
  ];

  // Start every known agent (plus _common default) with an empty snapshot.
  const perAgent = new Map();
  perAgent.set("_common", { env: {}, sources: {} });
  for (const agentId of Object.keys(map.agents)) {
    perAgent.set(agentId, { env: {}, sources: {} });
  }

  for (const grant of grants) {
    for (const agentId of grant.agents) {
      const allowed = allowedByAgent.get(agentId);
      if (!allowed) throw new Error(`grant ${grant.name} targets unknown agent ${agentId}`);
      const bucket = perAgent.get(agentId);
      const { value, vault } = resolveGrant(grant, allowed);
      bucket.env[grant.name] = value;
      bucket.sources[grant.name] = {
        agent: agentId,
        vault,
        item: grant.item,
        field: grant.field,
        purpose: grant.purpose
      };
    }
  }

  if (!dryRun) fs.mkdirSync(outRoot, { recursive: true, mode: 0o700 });
  for (const [agentId, bucket] of perAgent) {
    writeAgentSnapshot(agentId, bucket.env, bucket.sources);
  }
}

main();
