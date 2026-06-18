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
const routerSoul = readFileSync(path.join(contractsDir, "router-agent.SOUL.md"), "utf8");
const infraContract = readFileSync(path.join(contractsDir, "infra-ops.AGENTS.md"), "utf8");
const securityContract = readFileSync(path.join(contractsDir, "security-research.AGENTS.md"), "utf8");
const proposalContract = readFileSync(path.join(contractsDir, "presales-proposal.AGENTS.md"), "utf8");
const artifactBuilderSkill = readFileSync(
  path.join(root, "skills/workspace-artifact-builder/SKILL.md"),
  "utf8"
);
const skillDeploymentDoc = readFileSync(
  path.join(root, "docs/openclaw-skill-deployment.md"),
  "utf8"
);

const concernAgents = ["security-research", "presales-proposal", "infra-ops"];
const routerAllowedAgents = [...concernAgents, "telegram-fable"];

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

  it("keeps router-agent constrained to the concern lanes and artifact lane", () => {
    const router = agent("router-agent");
    assert.deepEqual(router.subagents.allowAgents, routerAllowedAgents);
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
    assert.match(routerContract, /route only to `telegram-fable`/);
    assert.match(routerContract, /Do not co-spawn/);
    assert.match(routerContract, /return the Local and Tailscale preview URLs/);
    assert.match(routerContract, /do not paste the full artifact body/);
    assert.match(routerContract, /correct route-only answer is `telegram-fable`/);
    assert.match(routerSoul, /`telegram-fable`/);
    assert.match(routerSoul, /must return `telegram-fable`/);
    assert.match(routerSoul, /delegate only to `telegram-fable`/);
    assert.match(infraContract, /PR workflow is pre-authorized/);
    assert.match(infraContract, /task brief as the source of customer intent/);
    assert.match(proposalContract, /approved copy and the constraints/);
    assert.match(securityContract, /Do not use shell/);
  });

  it("requires artifact skills to return Workspace Artifacts URLs", () => {
    const telegramFable = agent("telegram-fable");
    assert.ok(
      telegramFable.sandbox.docker.binds.includes(
        "/home/yasu/.openclaw/skills:/home/yasu/.openclaw/skills:ro"
      )
    );
    assert.ok(
      telegramFable.sandbox.docker.binds.includes(
        "/home/yasu/.openclaw/skills:/home/ubuntu/.openclaw/skills:ro"
      )
    );
    assert.ok(
      telegramFable.sandbox.docker.binds.includes(
        "/home/yasu/.openclaw/workspace:/home/yasu/.openclaw/workspace"
      )
    );
    assert.deepEqual(telegramFable.tools.exec, { host: "sandbox", mode: "full" });
    for (const tool of ["read", "write", "edit", "apply_patch", "exec", "process"]) {
      assert.ok(telegramFable.tools.allow.includes(tool), `telegram-fable must allow ${tool}`);
      assert.ok(
        telegramFable.tools.sandbox.tools.allow.includes(tool),
        `telegram-fable sandbox must allow ${tool}`
      );
    }
    assert.ok(telegramFable.tools.deny.includes("sessions_spawn"));
    assert.ok(telegramFable.tools.sandbox.tools.deny.includes("sessions_spawn"));
    assert.match(
      telegramFable.sandbox.docker.setupCommand,
      /if \[ ! -e "\$HOME\/\.openclaw\/skills" \]/
    );
    assert.match(
      telegramFable.sandbox.docker.setupCommand,
      /ln -s \/workspace\/\.openclaw\/sandbox-skills\/skills "\$HOME\/\.openclaw\/skills"/
    );
    assert.match(artifactBuilderSkill, /Gateway URL/);
    assert.match(artifactBuilderSkill, /Fast Path for New Web Artifacts/);
    assert.match(artifactBuilderSkill, /do not browse the workspace first/);
    assert.match(artifactBuilderSkill, /Do not use the shell built-in `test`/);
    assert.match(artifactBuilderSkill, /Do not paste the full artifact body/);
    assert.match(artifactBuilderSkill, /prefer a web\s+artifact/);
    assert.match(artifactBuilderSkill, /artifacts\/<artifact-id>\/<entry>/);
    assert.match(artifactBuilderSkill, /POSIX-safe heredocs/);
    assert.match(artifactBuilderSkill, /empty add-file patch/);
    assert.match(artifactBuilderSkill, /sandbox-skills/);
    assert.match(artifactBuilderSkill, /Do not spend time searching the whole filesystem/);
    assert.match(skillDeploymentDoc, /workspace\/agent `AGENTS\.md`/);
    assert.match(skillDeploymentDoc, /sandbox-skills\/skills\/workspace-artifact-builder\/SKILL\.md/);
    assert.match(skillDeploymentDoc, /do not search the whole filesystem/);
    assert.match(skillDeploymentDoc, /\/workspace\/canvas\/<artifact-id>\//);
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
