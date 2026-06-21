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
const COMMON_VAULT = map.common_vault;
const ACTIVE_LANES = ["security-research", "presales-proposal", "infra-ops", "telegram-fable"];
const LANE_VAULTS = [
  "openclaw-security-research",
  "openclaw-presales-proposal",
  "openclaw-infra-ops",
  "openclaw-telegram-fable"
];
// Lanes that must never receive a GitHub (or any shell) credential.
const CREDENTIAL_FREE_AGENTS = ["router-agent", "security-research", "presales-proposal", "telegram-fable"];

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

describe("least-privilege vault access map", () => {
  it("scopes the orchestrator away from every lane vault", () => {
    const router = map.agents["router-agent"];
    assert.ok(router, "router-agent must be mapped");
    for (const vault of LANE_VAULTS) {
      assert.ok(!router.vaults.includes(vault), `router-agent must not be granted ${vault}`);
      assert.ok(router.must_not_read.includes(vault), `router-agent must_not_read must list ${vault}`);
    }
  });

  it("gives every active lane its own vault plus the common vault", () => {
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
    const aggregate = "/home/yasu/.openclaw/runtime-secrets";
    const defaultsBind = config.agents.defaults.sandbox.docker.binds.find((b) =>
      b.includes(`:${SECRET_MOUNT}:`)
    );
    assert.equal(
      defaultsBind,
      `${aggregate}/_common:${SECRET_MOUNT}:ro`,
      "defaults must mount the empty _common snapshot, not the aggregate"
    );
    for (const id of [...ACTIVE_LANES, "router-agent", "main", "hard", "long", "heartbeat"]) {
      const source = secretMountSource(id);
      assert.notEqual(source, aggregate, `${id} must not mount the shared aggregate snapshot`);
      assert.ok(
        source.startsWith(`${aggregate}/`),
        `${id} secret mount must be a per-agent subdirectory, got ${source}`
      );
    }
  });

  it("mounts infra-ops only its own snapshot and routes credential-free lanes to _common", () => {
    assert.equal(
      secretMountSource("infra-ops"),
      "/home/yasu/.openclaw/runtime-secrets/infra-ops"
    );
    for (const id of ["router-agent", "security-research", "presales-proposal"]) {
      assert.equal(
        secretMountSource(id),
        "/home/yasu/.openclaw/runtime-secrets/_common",
        `${id} must inherit the empty _common snapshot`
      );
    }
  });

  it("ships the materializer that enforces the map at the host boundary", () => {
    assert.ok(existsSync(path.join(laneDir, "materialize-runtime-secrets.js")));
  });
});
