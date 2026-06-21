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
const azabuContract = readFileSync(path.join(contractsDir, "azabu-corporate.AGENTS.md"), "utf8");
const foxcaleCodingContract = readFileSync(path.join(contractsDir, "foxcale-coding.AGENTS.md"), "utf8");
const workCiscoContract = readFileSync(path.join(contractsDir, "work-cisco.AGENTS.md"), "utf8");
const artifactBuilderSkill = readFileSync(
  path.join(root, "skills/workspace-artifact-builder/SKILL.md"),
  "utf8"
);
const skillDeploymentDoc = readFileSync(
  path.join(root, "docs/openclaw-skill-deployment.md"),
  "utf8"
);

// The operator's five concerns, expressed as concern agents (foxcale is split
// into advisor + coding). telegram-fable is the artifact lane, also delegable.
const concernAgents = [
  "work-cisco",
  "azabu-corporate",
  "foxcale-advisor",
  "foxcale-coding",
  "learning-kb",
  "personal"
];
const routerAllowedAgents = [...concernAgents, "telegram-fable"];
const DELETED_AGENTS = ["coding", "security-research", "presales-proposal", "infra-ops"];

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

  it("keeps router-agent constrained to the concern agents and artifact lane", () => {
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

  it("retires the abstract lanes and the generic coding agent", () => {
    const ids = config.agents.list.map((a) => a.id);
    for (const gone of DELETED_AGENTS) {
      assert.ok(!ids.includes(gone), `${gone} must be removed from agents.list`);
    }
    const router = agent("router-agent");
    for (const gone of DELETED_AGENTS) {
      assert.ok(
        !router.subagents.allowAgents.includes(gone),
        `router-agent must not delegate to removed agent ${gone}`
      );
    }
  });

  it("keeps every concern agent able to return to router-agent without forming loops", () => {
    for (const id of concernAgents) {
      const current = agent(id);
      assert.ok(current.tools.deny.includes("sessions_send"), `${id} must deny sessions_send`);
      assert.deepEqual(
        current.subagents.allowAgents,
        ["router-agent"],
        `${id} may only delegate back to router-agent`
      );
      assert.ok(
        current.skills.includes("agent-scope-guard"),
        `${id} must carry the scope guard skill`
      );
    }
  });

  it("gives azabu-corporate (★1) GitHub repo authority scoped to its own secret snapshot", () => {
    const azabu = agent("azabu-corporate");
    assert.ok(azabu.skills.includes("github"), "azabu-corporate must expose GitHub repo tools");
    assert.match(azabu.description, /azabu\.io/);
    assert.match(azabu.description, /Never touch foxcale/i);
    assert.deepEqual(
      azabu.sandbox.docker.binds,
      ["/home/yasu/.openclaw/runtime-secrets/azabu-corporate:/run/openclaw-secrets:ro"],
      "azabu-corporate must mount only its own secret snapshot"
    );
  });

  it("gives foxcale-coding (★2) its own GitHub auth + secret snapshot, isolated from Azabu", () => {
    const foxcale = agent("foxcale-coding");
    assert.equal(
      foxcale.sandbox.docker.setupCommand,
      "if [ -f /workspace/.openclaw/bootstrap-runtime-secrets.sh ]; then sh /workspace/.openclaw/bootstrap-runtime-secrets.sh; fi\nsh /workspace/.openclaw/foxcale-github-auth.sh"
    );
    assert.deepEqual(
      foxcale.sandbox.docker.binds,
      ["/home/yasu/.openclaw/runtime-secrets/foxcale-coding:/run/openclaw-secrets:ro"],
      "foxcale-coding must mount only its own secret snapshot"
    );
    assert.match(foxcale.description, /Never touch Azabu/i);
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

  it("documents concern isolation and PR authorization in the lane contracts", () => {
    // Router taxonomy + the hard isolation rules.
    assert.match(routerContract, /For follow-up requests such as "PRして"/);
    assert.match(routerContract, /prior user intent/);
    assert.match(routerContract, /Never route Azabu and foxcale[\s\S]*?repository work to the same subagent/);
    assert.match(routerContract, /Cisco partner-SE work must carry no Azabu element/);
    assert.match(routerContract, /route only to `telegram-fable`/);
    assert.match(routerContract, /Do not co-spawn/);
    assert.match(routerContract, /return the Local and Tailscale preview URLs/);
    assert.match(routerContract, /do not paste the full artifact body/);
    assert.match(routerSoul, /`telegram-fable`/);
    assert.match(routerSoul, /never bring Azabu context into `work-cisco`/);
    // Azabu (★1): owns azabu.io PR workflow, holds only the Azabu token.
    assert.match(azabuContract, /PR workflow is pre-authorized/);
    assert.match(azabuContract, /Azabu GitHub token only/);
    assert.match(azabuContract, /Never touch a foxcale repository/);
    // foxcale (★2): owns foxcale PR workflow, holds only the foxcale token.
    assert.match(foxcaleCodingContract, /PR workflow is pre-authorized/);
    assert.match(foxcaleCodingContract, /foxcale project GitHub token only/);
    assert.match(foxcaleCodingContract, /Never touch[\s\S]*?an Azabu repository/);
    assert.match(foxcaleCodingContract, /must never mix/);
    // Cisco: no Azabu element.
    assert.match(workCiscoContract, /no Azabu element/);
  });

  it("runs the unattended heartbeat agent with a full sandbox exec policy so it never blocks on approval", () => {
    const heartbeat = agent("heartbeat");
    assert.deepEqual(heartbeat.tools.exec, { host: "sandbox", mode: "full" });
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
    assert.equal(config.plugins.entries["workspace-artifacts"].enabled, true);
    assert.equal(config.plugins.entries["agent-command"].enabled, true);
  });
});
