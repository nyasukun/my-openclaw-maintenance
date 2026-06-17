import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "config/openclaw-concern-lanes/openclaw.patch.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

const contractsDir = path.join(root, "config/openclaw-concern-lanes/lane-contracts");
const routerContract = readFileSync(path.join(contractsDir, "router-agent.AGENTS.md"), "utf8");
const infraContract = readFileSync(path.join(contractsDir, "infra-ops.AGENTS.md"), "utf8");
const securityContract = readFileSync(path.join(contractsDir, "security-research.AGENTS.md"), "utf8");
const proposalContract = readFileSync(path.join(contractsDir, "presales-proposal.AGENTS.md"), "utf8");

const concernAgents = ["security-research", "presales-proposal", "infra-ops"];

function agent(id) {
  const value = config.agents.list.find((candidate) => candidate.id === id);
  assert.ok(value, `${id} must exist in agents.list`);
  return value;
}

describe("OpenClaw concern-lane snapshot", () => {
  it("routes Telegram and Slack ingress to router-agent with stable per-peer sessions", () => {
    const routes = config.bindings.filter((binding) => binding.agentId === "router-agent");
    assert.deepEqual(
      routes.map((route) => route.match.channel).sort(),
      ["slack", "telegram"]
    );
    for (const route of routes) {
      assert.equal(route.type, "route");
      assert.equal(route.session.dmScope, "per-channel-peer");
    }
  });

  it("keeps router-agent constrained to the three concern lanes", () => {
    const router = agent("router-agent");
    assert.deepEqual(router.subagents.allowAgents, concernAgents);
    assert.equal(router.subagents.requireAgentId, true);
    assert.equal(router.sandbox.mode, "all");
    assert.deepEqual(
      ["sessions_spawn", "sessions_yield", "read", "write", "edit", "apply_patch", "exec", "process"].filter(
        (tool) => !router.tools.allow.includes(tool)
      ),
      []
    );
    assert.ok(router.tools.deny.includes("sessions_send"));
    assert.ok(router.tools.deny.includes("browser"));
  });

  it("gives infra-ops enough sandboxed authority for pre-authorized PR workflow", () => {
    const infra = agent("infra-ops");
    assert.equal(infra.workspace, "/home/yasu/.openclaw/workspace-infra-ops");
    assert.equal(infra.agentDir, "/home/yasu/.openclaw/agents/infra-ops/agent");
    assert.equal(infra.sandbox.mode, "all");
    assert.equal(infra.sandbox.workspaceAccess, "rw");
    assert.equal(infra.sandbox.scope, "agent");
    assert.equal(infra.sandbox.docker.network, "bridge");
    assert.match(infra.sandbox.docker.setupCommand, /bootstrap-runtime-secrets\.sh/);
    assert.deepEqual(infra.tools.exec, { host: "auto", mode: "full" });
    assert.deepEqual(
      ["read", "write", "edit", "apply_patch", "exec", "process"].filter(
        (tool) => !infra.tools.allow.includes(tool)
      ),
      []
    );
    assert.ok(infra.tools.deny.includes("sessions_send"));
    assert.ok(infra.tools.deny.includes("sessions_spawn"));
  });

  it("keeps specialist leaves from creating delegation loops", () => {
    for (const id of concernAgents) {
      const current = agent(id);
      assert.ok(current.tools.deny.includes("sessions_send"), `${id} must deny sessions_send`);
      assert.ok(current.tools.deny.includes("sessions_spawn"), `${id} must deny sessions_spawn`);
    }
  });

  it("keeps research and proposal lanes scoped to their minimum tool surfaces", () => {
    const security = agent("security-research");
    assert.deepEqual(security.tools.allow, ["read", "write", "web_search", "web_fetch"]);
    assert.ok(security.tools.deny.includes("exec"));

    const proposal = agent("presales-proposal");
    assert.deepEqual(proposal.tools.allow, ["read", "write", "apply_patch"]);
    assert.ok(proposal.tools.deny.includes("exec"));
  });

  it("documents context carry-over and PR authorization in lane contracts", () => {
    assert.match(routerContract, /For follow-up requests such as "PRして"/);
    assert.match(routerContract, /prior user intent/);
    assert.match(routerContract, /branch\s+creation,\s+commit,\s+push,\s+and\s+PR\s+creation\s+are\s+authorized/);
    assert.match(infraContract, /PR workflow is pre-authorized/);
    assert.match(infraContract, /task brief as the source of customer intent/);
    assert.match(proposalContract, /approved copy and the constraints/);
    assert.match(securityContract, /Do not use shell/);
  });

  it("captures the queue and plugin settings required by the rollout", () => {
    assert.deepEqual(config.tools.agentToAgent, { enabled: false });
    assert.deepEqual(config.messages.queue, {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize"
    });
    assert.equal(config.plugins.entries.codex.config.appServer.experimental.sandboxExecServer, true);
  });
});
