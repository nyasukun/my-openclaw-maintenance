#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = "/home/yasu/work/my-openclaw-maintenance";
const vaultMapPath =
  process.env.OPENCLAW_VAULT_MAP_PATH ||
  path.join(repoRoot, "config/openclaw-agent-project/vault-map.json");
const requestPath =
  process.env.OPENCLAW_RUNTIME_SECRET_REQUESTS ||
  "/home/yasu/.openclaw/secrets/runtime-secret-requests.json";
const outDir = process.env.OPENCLAW_RUNTIME_SECRETS_DIR || "/home/yasu/.openclaw/runtime-secrets";
const outFile = path.join(outDir, "local.json");
const op = process.env.OP_BIN || "/usr/bin/op";

const commonVault = process.env.OP_COMMON_VAULT || "openclaw-pod";
const azabuCorporateVault = process.env.OP_AZABU_CORPORATE_VAULT || "openclaw-azabu-corporate";
const foxcaleCodingVault = process.env.OP_FOXCALE_CODING_VAULT || "openclaw-foxcale-coding";

const builtInRequests = [
  {
    name: "GITHUB_TOKEN",
    agent: "azabu-corporate",
    vault: azabuCorporateVault,
    item: "github",
    field: "token",
    purpose: "general GitHub access"
  },
  {
    name: "GITHUB_PAT_F_PROJECT",
    agent: "foxcale-coding",
    vault: foxcaleCodingVault,
    item: "github",
    field: "pat_f_project",
    purpose: "foxcale project GitHub access"
  }
];

function loadServiceAccountEnv() {
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) return;
  const envPath = process.env.OP_SERVICE_ACCOUNT_ENV || "/home/yasu/.openclaw/secrets/1password-service-account.env";
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

function allowedVaultsByAgent(vaultMap) {
  const result = new Map();
  const common = vaultMap.common_vault || commonVault;
  result.set("common", new Set([common]));
  for (const [agent, vaults] of Object.entries(vaultMap.agent_vaults || {})) {
    result.set(agent, new Set([common, ...vaults]));
  }
  return result;
}

function normalizeRequest(name, raw, defaultAgent) {
  const request = {
    name,
    agent: raw.agent || defaultAgent,
    vault: raw.vault,
    item: raw.item,
    field: raw.field,
    purpose: raw.purpose || ""
  };
  if (!isSafeName(request.name)) throw new Error(`invalid env name: ${request.name}`);
  if (!request.agent || typeof request.agent !== "string") throw new Error(`missing agent for ${request.name}`);
  if (!request.vault || !isSafeRefPart(request.vault)) throw new Error(`invalid vault for ${request.name}`);
  if (!request.item || !isSafeRefPart(request.item)) throw new Error(`invalid item for ${request.name}`);
  if (!request.field || String(request.field).split("/").some((part) => !isSafeRefPart(part))) {
    throw new Error(`invalid field for ${request.name}`);
  }
  return request;
}

function loadRequestedSecrets() {
  const data = loadJson(requestPath, { version: 1, agents: {} });
  const requests = [];
  for (const raw of data.env || []) {
    requests.push(normalizeRequest(raw.name, raw, raw.agent || "common"));
  }
  for (const [agent, config] of Object.entries(data.agents || {})) {
    for (const [name, raw] of Object.entries(config.env || {})) {
      requests.push(normalizeRequest(name, raw, agent));
    }
  }
  return requests;
}

function assertAllowed(request, allowedByAgent) {
  const allowed = allowedByAgent.get(request.agent);
  if (!allowed) throw new Error(`unknown runtime secret agent scope for ${request.name}: ${request.agent}`);
  if (!allowed.has(request.vault)) {
    throw new Error(`vault ${request.vault} is not allowed for ${request.agent} (${request.name})`);
  }
}

function opRead(vault, item, field) {
  const ref = `op://${vault}/${item}/${field}`;
  const result = spawnSync(op, ["read", ref], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(`op read failed for ${vault}/${item}/${field}`);
  return result.stdout.replace(/\r?\n$/, "");
}

loadServiceAccountEnv();

const vaultMap = loadJson(vaultMapPath, { common_vault: commonVault, agent_vaults: {} });
const allowedByAgent = allowedVaultsByAgent(vaultMap);
const requests = [...builtInRequests, ...loadRequestedSecrets()];
const env = {};
const sources = {};

for (const request of requests) {
  const normalized = normalizeRequest(request.name, request, request.agent);
  assertAllowed(normalized, allowedByAgent);
  env[normalized.name] = opRead(normalized.vault, normalized.item, normalized.field);
  sources[normalized.name] = {
    agent: normalized.agent,
    vault: normalized.vault,
    item: normalized.item,
    field: normalized.field,
    purpose: normalized.purpose
  };
}

const data = {
  generated_at: new Date().toISOString(),
  env,
  sources
};

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const tmp = `${outFile}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
fs.renameSync(tmp, outFile);
fs.chmodSync(outFile, 0o600);
