import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const laneDir = path.join(root, "config/openclaw-concern-lanes");

const map = JSON.parse(readFileSync(path.join(laneDir, "vault-access-map.json"), "utf8"));
const config = JSON.parse(readFileSync(path.join(laneDir, "openclaw.patch.json"), "utf8"));

const SECRET_MOUNT = "/run/openclaw-secrets";
const AGGREGATE = "/home/yasu/.openclaw/runtime-secrets";
const COMMON_VAULT = map.common_vault;

// The operator's five concerns as concern agents (foxcale split into advisor + coding).
const ACTIVE_LANES = [
  "work-cisco",
  "azabu-corporate",
  "foxcale-advisor",
  "foxcale-coding",
  "learning-kb",
  "personal"
];
const LANE_VAULTS = [
  "openclaw-work-cisco",
  "openclaw-azabu-corporate",
  "openclaw-foxcale-advisor",
  "openclaw-foxcale-coding",
  "openclaw-learning-kb",
  "openclaw-personal"
];
// Agents that must never receive a GitHub (or any shell) credential.
const CREDENTIAL_FREE_AGENTS = [
  "router-agent",
  "foxcale-advisor",
  "work-cisco",
  "learning-kb",
  "personal",
  "telegram-fable"
];
// Only the two coding/PR concerns override the empty _common mount.
const OWN_SNAPSHOT = {
  "azabu-corporate": `${AGGREGATE}/azabu-corporate`,
  "foxcale-coding": `${AGGREGATE}/foxcale-coding`,
  "telegram-fable": `${AGGREGATE}/telegram-fable`
};
const COMMON_SNAPSHOT_AGENTS = [
  "router-agent",
  "foxcale-advisor",
  "work-cisco",
  "learning-kb",
  "personal"
];

const AZABU_VAULT = "openclaw-azabu-corporate";
const FOXCALE_VAULT = "openclaw-foxcale-coding";

function agentConfig(id) {
  const found = config.agents.list.find((a) => a.id === id);
  assert.ok(found, `${id} must exist in agents.list`);
  return found;
}

// The host path mounted at /run/openclaw-secrets for an agent: its own docker.binds
// override if present, otherwise the inherited agents.defaults binds.
function secretMountSource(id) {
  const own = agentConfig(id).sandbox?.docker?.binds;
  const defaults = config.agents.defaults.sandbox.docker.binds;
  const binds = own ?? defaults;
  const entry = binds.find((b) => b.includes(`:${SECRET_MOUNT}:`) || b.endsWith(`:${SECRET_MOUNT}`));
  assert.ok(entry, `${id} must mount ${SECRET_MOUNT}`);
  return entry.slice(0, entry.indexOf(`:${SECRET_MOUNT}`));
}

function allowedVaults(id) {
  const spec = map.agents[id];
  assert.ok(spec, `${id} must appear in vault-access-map`);
  return new Set([COMMON_VAULT, ...(spec.vaults || [])]);
}

function grantByName(name) {
  const grant = map.runtime_secret_grants.find((g) => g.name === name);
  assert.ok(grant, `grant ${name} must exist`);
  return grant;
}

describe("least-privilege vault access map", () => {
  it("scopes the orchestrator away from every concern vault", () => {
    const router = map.agents["router-agent"];
    assert.ok(router, "router-agent must be mapped");
    for (const vault of LANE_VAULTS) {
      assert.ok(!router.vaults.includes(vault), `router-agent must not be granted ${vault}`);
      assert.ok(router.must_not_read.includes(vault), `router-agent must_not_read must list ${vault}`);
    }
  });

  it("gives every active concern lane its own vault plus the common vault", () => {
    for (const lane of ACTIVE_LANES) {
      const spec = map.agents[lane];
      assert.equal(spec.status, "active", `${lane} must be active`);
      assert.ok(spec.vaults.includes(COMMON_VAULT), `${lane} must include the common vault`);
      assert.ok(
        spec.vaults.some((v) => v !== COMMON_VAULT),
        `${lane} must have a dedicated vault`
      );
    }
  });

  it("isolates the two customer GitHub tokens (★1 Azabu vs ★2 foxcale) in disjoint vaults", () => {
    const azabuGrant = grantByName("GITHUB_TOKEN");
    const foxcaleGrant = grantByName("GITHUB_PAT_F_PROJECT");

    // ★1: Azabu token, only azabu-corporate, only the Azabu vault, no fallbacks.
    assert.deepEqual(azabuGrant.agents, ["azabu-corporate"]);
    assert.equal(azabuGrant.vault, AZABU_VAULT);
    assert.ok(
      !azabuGrant.vault_fallbacks || azabuGrant.vault_fallbacks.length === 0,
      "the Azabu token grant must not fall back to any other vault"
    );

    // ★2: foxcale token, only foxcale-coding, only the foxcale vault.
    assert.deepEqual(foxcaleGrant.agents, ["foxcale-coding"]);
    assert.equal(foxcaleGrant.vault, FOXCALE_VAULT);
    assert.ok(
      !foxcaleGrant.vault_fallbacks || foxcaleGrant.vault_fallbacks.length === 0,
      "the foxcale token grant must not fall back to any other vault"
    );

    // The two grants share no agent and no vault.
    assert.notEqual(azabuGrant.vault, foxcaleGrant.vault);
    assert.equal(
      azabuGrant.agents.filter((a) => foxcaleGrant.agents.includes(a)).length,
      0,
      "no agent may hold both customer GitHub tokens"
    );

    // Cross-authorization is impossible: azabu cannot read the foxcale vault and vice versa.
    assert.ok(!allowedVaults("azabu-corporate").has(FOXCALE_VAULT));
    assert.ok(!allowedVaults("foxcale-coding").has(AZABU_VAULT));
  });

  it("keeps work-cisco clean of any Azabu/foxcale vault or credential", () => {
    const cisco = allowedVaults("work-cisco");
    assert.ok(!cisco.has(AZABU_VAULT), "work-cisco must not be authorized for the Azabu vault");
    assert.ok(!cisco.has(FOXCALE_VAULT), "work-cisco must not be authorized for the foxcale vault");
    assert.ok(!cisco.has("openclaw-foxcale-advisor"));
    for (const grant of map.runtime_secret_grants) {
      assert.ok(
        !grant.agents.includes("work-cisco"),
        `work-cisco must not receive runtime secret ${grant.name}`
      );
    }
  });

  it("only resolves a secret grant from a vault the target agent is authorized for", () => {
    for (const grant of map.runtime_secret_grants) {
      const candidates = [grant.vault, ...(grant.vault_fallbacks || [])];
      for (const agentId of grant.agents) {
        const allowed = allowedVaults(agentId);
        assert.ok(
          candidates.some((v) => allowed.has(v)),
          `grant ${grant.name} for ${agentId} resolves only from unauthorized vaults [${candidates.join(", ")}]`
        );
      }
    }
  });

  it("never grants a GitHub or shell credential to a credential-free agent", () => {
    for (const grant of map.runtime_secret_grants) {
      for (const agentId of grant.agents) {
        assert.ok(
          !CREDENTIAL_FREE_AGENTS.includes(agentId),
          `${agentId} must not receive runtime secret ${grant.name}`
        );
      }
    }
  });

  it("mounts a per-agent secret snapshot, never the shared aggregate, into every sandbox", () => {
    // The pre-hardening leak: every sandbox mounted the same aggregate snapshot dir.
    const defaultsBind = config.agents.defaults.sandbox.docker.binds.find((b) =>
      b.includes(`:${SECRET_MOUNT}:`)
    );
    assert.equal(
      defaultsBind,
      `${AGGREGATE}/_common:${SECRET_MOUNT}:ro`,
      "defaults must mount the empty _common snapshot, not the aggregate"
    );
    for (const id of [...ACTIVE_LANES, "router-agent", "telegram-fable", "main", "hard", "long", "heartbeat"]) {
      const source = secretMountSource(id);
      assert.notEqual(source, AGGREGATE, `${id} must not mount the shared aggregate snapshot`);
      assert.ok(
        source.startsWith(`${AGGREGATE}/`),
        `${id} secret mount must be a per-agent subdirectory, got ${source}`
      );
    }
  });

  it("mounts the two coding concerns their own snapshot and routes credential-free lanes to _common", () => {
    for (const [id, expected] of Object.entries(OWN_SNAPSHOT)) {
      assert.equal(secretMountSource(id), expected, `${id} must mount its own snapshot`);
    }
    for (const id of COMMON_SNAPSHOT_AGENTS) {
      assert.equal(
        secretMountSource(id),
        `${AGGREGATE}/_common`,
        `${id} must inherit the empty _common snapshot`
      );
    }
  });

  it("ships the materializer that enforces the map at the host boundary", () => {
    assert.ok(existsSync(path.join(laneDir, "materialize-runtime-secrets.js")));
  });
});
