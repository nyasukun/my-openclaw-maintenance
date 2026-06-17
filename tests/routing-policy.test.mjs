import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const policyPath = path.resolve(__dirname, "../config/openclaw-agent-project/routing-policy.json");
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const configPatchPath = path.resolve(__dirname, "../config/openclaw-agent-project/openclaw.patch.json");
const configPatch = JSON.parse(readFileSync(configPatchPath, "utf8"));
const channelRouterSkill = readFileSync(
  path.resolve(__dirname, "../skills/channel-router/SKILL.md"),
  "utf8"
);
const scopeGuardSkill = readFileSync(
  path.resolve(__dirname, "../skills/agent-scope-guard/SKILL.md"),
  "utf8"
);
const handoffSkill = readFileSync(
  path.resolve(__dirname, "../skills/handoff-summarizer/SKILL.md"),
  "utf8"
);
const auditSkill = readFileSync(
  path.resolve(__dirname, "../skills/audit-logger/SKILL.md"),
  "utf8"
);

const purposeAgentIds = [
  "work-cisco",
  "azabu-corporate",
  "personal",
  "coding",
  "foxcale-advisor",
  "foxcale-coding",
  "learning-kb"
];

function normalize(value) {
  return String(value ?? "").toLowerCase();
}

function route(sourceChannel, message) {
  const text = normalize(`${sourceChannel}\n${message}`);
  const routes = [...policy.routes].sort((a, b) => a.priority - b.priority);
  for (const candidate of routes) {
    const keywords = candidate.match?.any_keywords ?? [];
    const allKeywords = candidate.match?.all_keywords ?? [];
    const allMatch = allKeywords.every((keyword) => text.includes(normalize(keyword)));
    const anyMatch = keywords.length === 0 || keywords.some((keyword) => text.includes(normalize(keyword)));
    if (allMatch && anyMatch) {
      return {
        selected_agent: candidate.selected_agent,
        ambiguous: false,
        routing_reason: candidate.routing_reason
      };
    }
  }
  return {
    selected_agent: policy.ambiguous.selected_agent,
    ambiguous: true,
    question: policy.ambiguous.question
  };
}

function normalizeAgentId(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
}

function parseExplicitAgentCommand(message) {
  const trimmed = String(message ?? "").trim();
  if (/^\/agent(?:\s+)?$/i.test(trimmed)) {
    return { action: "list" };
  }
  const match = trimmed.match(/^\/agent\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const rawAgentId = match[1];
  if (/^(list|ls|help|\?)$/i.test(rawAgentId)) {
    return { action: "list" };
  }
  const agentId = normalizeAgentId(policy.slash_commands.agent_id_aliases[rawAgentId] ?? rawAgentId);
  const task = (match[2] ?? "").trim();
  if (!policy.slash_commands.purpose_agent_ids.includes(agentId)) {
    return { action: "invalid", agentId };
  }
  if (!task) {
    return { action: "missing-task", agentId };
  }
  return { action: "route", agentId, task };
}

function classifyUserCommentBeforeSynthesis(message, finalSynthesisSent = false) {
  if (finalSynthesisSent) {
    return {
      attachToActiveOrchestration: false,
      treatAsFollowUp: policy.user_interruption_policy.after_final_synthesis.treat_as_follow_up_or_new_request,
      targetAgents: []
    };
  }

  const text = normalize(message).replaceAll("_", "-");
  const targetAgents = purposeAgentIds.filter((agentId) => text.includes(normalize(agentId)));
  const isMaterialUpdate = /(違う|伝えて|条件|追加|反映|修正|予算|違います|wrong|instead|tell|update)/i.test(message);
  const beforeFinal = policy.user_interruption_policy.before_final_synthesis;

  return {
    attachToActiveOrchestration: beforeFinal.attach_to_active_orchestration,
    treatAsNewRequest: beforeFinal.treat_as_new_request,
    targetAgents,
    forwardNamed: targetAgents.length > 0 && beforeFinal.forward_named_comments_to_target_agent,
    inferOrClarify: targetAgents.length === 0 && isMaterialUpdate && beforeFinal.ask_clarification_when_target_unclear_and_comment_changes_task,
    reuseExistingPartialResults: beforeFinal.reuse_existing_partial_results,
    reopenSynthesis: beforeFinal.reopen_synthesis
  };
}

describe("OpenClaw broadcast orchestration policy", () => {
  it("configures router-agent as the high-capability user-facing orchestrator", () => {
    const routerAgent = configPatch.agents.list.find((agent) => agent.id === "router-agent");
    assert.ok(routerAgent, "router-agent must be configured");
    assert.match(routerAgent.description, /user-facing orchestration agent/);
    assert.match(routerAgent.description, /broadcast normal work/);
    assert.match(routerAgent.description, /stream useful subagent results/);
    assert.match(routerAgent.description, /integrated answer/);
    assert.match(routerAgent.description, /user comments before the integrated answer/);
    assert.equal(routerAgent.model.primary, "openai/gpt-5.5");
    assert.deepEqual(routerAgent.model.fallbacks, ["openai/gpt-5.4-mini"]);
    assert.equal(routerAgent.thinkingDefault, "medium");
    assert.deepEqual(routerAgent.subagents.allowAgents, purposeAgentIds);
    assert.equal(routerAgent.subagents.model, undefined);
    assert.deepEqual(
      ["sessions_spawn", "sessions_yield", "subagents", "agents_list"].filter(
        (tool) => !routerAgent.tools.alsoAllow.includes(tool)
      ),
      []
    );
    assert.equal(routerAgent.tools.profile, undefined, "router-agent must not narrow inherited tools for delegated subagents");
    assert.equal(routerAgent.tools.deny, undefined, "router-agent deny rules must not strip delegated subagent tools");
  });

  it("raises subagent concurrency enough for full broadcast", () => {
    const subagents = configPatch.agents.defaults.subagents;
    assert.ok(subagents, "subagent defaults must be configured");
    assert.ok(subagents.maxConcurrent >= purposeAgentIds.length);
    assert.ok(subagents.maxChildrenPerAgent >= purposeAgentIds.length);
    assert.ok(subagents.runTimeoutSeconds > 0);
  });

  it("defines broadcast self-selection and streaming behavior", () => {
    assert.equal(policy.orchestration_mode, "broadcast_self_select_streaming");
    assert.equal(policy.broadcast_policy.entry_agent, "router-agent");
    assert.deepEqual(policy.broadcast_policy.target_agents, purposeAgentIds);
    assert.equal(policy.broadcast_policy.do_not_wait_for_all, true);
    assert.ok(policy.broadcast_policy.claim_window_ms < policy.broadcast_policy.soft_synthesis_deadline_ms);
    assert.ok(policy.broadcast_policy.soft_synthesis_deadline_ms < policy.broadcast_policy.final_synthesis_deadline_ms);
    assert.equal(policy.broadcast_policy.streaming.progressive_user_updates, true);
    assert.equal(policy.broadcast_policy.streaming.token_level_subagent_streaming, false);
    assert.ok(policy.broadcast_policy.streaming.stream_on_status.includes("FINAL_RESULT"));
    assert.ok(policy.broadcast_policy.streaming.hide_status.includes("NO_CLAIM"));
    assert.equal(policy.aggregation_policy.final_answer_label, "統合回答");
    assert.equal(policy.aggregation_policy.must_mention_user_comments_reflected, true);
  });

  it("documents the runtime orchestration contract in skills", () => {
    assert.match(channelRouterSkill, /Do not wait for every subagent/);
    assert.match(channelRouterSkill, /途中経過/);
    assert.match(channelRouterSkill, /統合回答/);
    assert.match(channelRouterSkill, /latest_user_comment/);
    assert.match(channelRouterSkill, /Parent-Child Dialogue/);
    assert.match(scopeGuardSkill, /CLAIM_PARTIAL/);
    assert.match(scopeGuardSkill, /NO_CLAIM/);
    assert.match(scopeGuardSkill, /do not call web search, retrieval, repository, shell, domain APIs/);
    assert.match(handoffSkill, /known_subagent_results/);
    assert.match(auditSkill, /user_comment_attached/);
  });

  it("configures the agent-command plugin for explicit single-agent exceptions", () => {
    assert.equal(configPatch.plugins.entries["agent-command"].enabled, true);
    assert.ok(configPatch.plugins.load.paths.includes("/home/yasu/work/my-openclaw-maintenance/plugins/agent-command"));
    assert.equal(policy.slash_commands.plugin, "agent-command");
    assert.deepEqual(policy.slash_commands.purpose_agent_ids, purposeAgentIds);
    assert.match(policy.slash_commands.route_behavior, /single-agent exception/);
  });

  it("parses explicit /agent target commands", () => {
    assert.deepEqual(parseExplicitAgentCommand("/agent personal レストランを予約して"), {
      action: "route",
      agentId: "personal",
      task: "レストランを予約して"
    });
    assert.deepEqual(parseExplicitAgentCommand("/agent foxcale_coding repoを確認して"), {
      action: "route",
      agentId: "foxcale-coding",
      task: "repoを確認して"
    });
    assert.deepEqual(parseExplicitAgentCommand("/agent"), { action: "list" });
    assert.deepEqual(parseExplicitAgentCommand("/agent list"), { action: "list" });
    assert.equal(parseExplicitAgentCommand("/agents list"), null);
    assert.deepEqual(parseExplicitAgentCommand("/agent web 検索して"), { action: "invalid", agentId: "web" });
    assert.deepEqual(parseExplicitAgentCommand("/agent personal"), { action: "missing-task", agentId: "personal" });
  });

  it("lets purpose agents respond to router-agent and keeps scope guard enabled", () => {
    assert.equal(policy.misroute_return_policy.return_agent, "router-agent");
    assert.equal(policy.misroute_return_policy.purpose_agents_should_start_when_plausibly_in_scope, true);
    assert.equal(policy.misroute_return_policy.purpose_agents_stop_on_clear_mismatch, true);

    for (const agentId of purposeAgentIds) {
      const agent = configPatch.agents.list.find((candidate) => candidate.id === agentId);
      assert.ok(agent, `${agentId} must be configured`);
      assert.ok(agent.skills.includes("agent-scope-guard"), `${agentId} must use agent-scope-guard`);
      assert.deepEqual(agent.subagents.allowAgents, ["router-agent"]);
      assert.ok(agent.tools.deny.includes("sessions_send"), `${agentId} must not use sessions_send for direct user replies`);
      assert.deepEqual(
        ["sessions_spawn", "sessions_yield", "subagents", "agents_list"].filter(
          (tool) => !agent.tools.alsoAllow.includes(tool)
        ),
        []
      );
    }
  });

  it("routes user comments before final synthesis to named subagents", () => {
    const result = classifyUserCommentBeforeSynthesis("coding 側にこの条件も伝えて");
    assert.equal(result.attachToActiveOrchestration, true);
    assert.equal(result.treatAsNewRequest, false);
    assert.deepEqual(result.targetAgents, ["coding"]);
    assert.equal(result.forwardNamed, true);
    assert.equal(result.reopenSynthesis, true);
  });

  it("applies user corrections to existing partial results before synthesis", () => {
    const result = classifyUserCommentBeforeSynthesis("personal の案は違う。予約は夕方ではなく昼にして");
    assert.equal(result.attachToActiveOrchestration, true);
    assert.deepEqual(result.targetAgents, ["personal"]);
    assert.equal(result.reuseExistingPartialResults, true);
    assert.equal(result.reopenSynthesis, true);
  });

  it("requires inference or clarification when a pre-final user comment changes the task without a clear target", () => {
    const result = classifyUserCommentBeforeSynthesis("それは違う。予算は10万円までで反映して");
    assert.equal(result.attachToActiveOrchestration, true);
    assert.deepEqual(result.targetAgents, []);
    assert.equal(result.inferOrClarify, true);
    assert.equal(result.reuseExistingPartialResults, true);
  });

  it("treats user comments after final synthesis as follow-ups", () => {
    const result = classifyUserCommentBeforeSynthesis("coding 側にこれも伝えて", true);
    assert.equal(result.attachToActiveOrchestration, false);
    assert.equal(result.treatAsFollowUp, true);
    assert.deepEqual(result.targetAgents, []);
  });

  it("uses a stronger personal model for scope and reservation reliability", () => {
    const personalAgent = configPatch.agents.list.find((agent) => agent.id === "personal");
    assert.ok(personalAgent, "personal must be configured");
    assert.equal(personalAgent.model.primary, "openai/gpt-5.5");
    assert.deepEqual(personalAgent.model.fallbacks, ["openai/gpt-5.4-mini"]);
  });

  it("uses the foxcale project PAT for foxcale-coding sandbox GitHub auth", () => {
    const foxcaleCodingAgent = configPatch.agents.list.find((agent) => agent.id === "foxcale-coding");
    const foxcalePolicy = policy.agents["foxcale-coding"];
    const setupScriptPath = path.resolve(__dirname, "../config/openclaw-agent-project/foxcale-github-auth.sh");
    const setupScript = readFileSync(setupScriptPath, "utf8");
    assert.ok(foxcaleCodingAgent, "foxcale-coding must be configured");
    assert.equal(
      foxcaleCodingAgent.sandbox?.docker?.setupCommand,
      "if [ -f /workspace/.openclaw/bootstrap-runtime-secrets.sh ]; then sh /workspace/.openclaw/bootstrap-runtime-secrets.sh; fi\nsh /workspace/.openclaw/foxcale-github-auth.sh"
    );
    assert.match(setupScript, /GITHUB_PAT_F_PROJECT/);
    assert.match(setupScript, /effective_token="\$f_project_token"/);
    assert.deepEqual(foxcalePolicy.active_repos, [
      {
        name: "fairscope-mock",
        remote: "fy26q2-azabu-f/fairscope-mock.git",
        workspace_hint: "repos/fairscope-mock"
      }
    ]);
  });

  it("injects runtime secrets dynamically through sandbox BASH_ENV", () => {
    const dockerDefaults = configPatch.agents.defaults.sandbox.docker;
    const bootstrapPath = path.resolve(__dirname, "../config/openclaw-agent-project/bootstrap-runtime-secrets.sh");
    const setupScriptPath = path.resolve(__dirname, "../config/openclaw-agent-project/foxcale-github-auth.sh");
    const writerPath = path.resolve(__dirname, "../config/openclaw-agent-project/write-runtime-local-json.js");
    const bootstrapScript = readFileSync(bootstrapPath, "utf8");
    const setupScript = readFileSync(setupScriptPath, "utf8");
    const writerScript = readFileSync(writerPath, "utf8");

    assert.equal(dockerDefaults.env.BASH_ENV, "/workspace/.openclaw/runtime-secret-env.sh");
    assert.equal(
      dockerDefaults.setupCommand,
      "if [ -f /workspace/.openclaw/bootstrap-runtime-secrets.sh ]; then sh /workspace/.openclaw/bootstrap-runtime-secrets.sh; fi"
    );
    assert.ok(dockerDefaults.binds.includes("/home/yasu/.openclaw/runtime-secrets:/run/openclaw-secrets:ro"));
    assert.match(bootstrapScript, /OPENCLAW_RUNTIME_SECRET_KEYS/);
    assert.match(bootstrapScript, /GH_TOKEN/);
    assert.match(bootstrapScript, /runtime-secret-overrides\.sh/);
    assert.match(bootstrapScript, /runtime-secret-env\.sh/);
    assert.match(setupScript, /runtime-secret-overrides\.sh/);
    assert.match(writerScript, /runtime-secret-requests\.json/);
    assert.match(writerScript, /vault .* is not allowed/);
  });

  it("keeps Azabu-owned repo work in azabu-corporate route hints", () => {
    const azabuAgent = configPatch.agents.list.find((agent) => agent.id === "azabu-corporate");
    const azabuPolicy = policy.agents["azabu-corporate"];
    assert.ok(azabuAgent, "azabu-corporate must be configured");
    assert.ok(azabuAgent.skills.includes("github"), "azabu-corporate must expose GitHub repo tools");
    assert.deepEqual(azabuPolicy.active_repos, [
      {
        name: "azabu.io",
        remote: "nyasukun/azabu.io.git",
        workspace_hint: "azabu.io"
      }
    ]);
    assert.equal(route("telegram", "azabu.io の GitHub repo にアナリティクスを入れる余地を見て").selected_agent, "azabu-corporate");
    assert.equal(route("telegram", "azabu-academy の実装を確認して").selected_agent, "azabu-corporate");
  });

  it("keeps route hints for Cisco Disti work", () => {
    assert.equal(route("slack", "Cisco Secure Access のDisti向け説明を作って").selected_agent, "work-cisco");
  });

  it("keeps route hints for Azabu Tech invoices", () => {
    assert.equal(route("telegram", "Azabu Techの請求書ドラフト作って").selected_agent, "azabu-corporate");
  });

  it("keeps route hints for weekend travel planning", () => {
    assert.equal(route("telegram", "週末の旅行計画を立てて").selected_agent, "personal");
  });

  it("keeps route hints for personal reservation phone-call requests", () => {
    assert.equal(
      route("telegram", "予約の電話をして、Telegramで文字起こしをストリームしながらリアルタイムに指示を聞いて").selected_agent,
      "personal"
    );
  });

  it("keeps route hints for foxcale meeting notes", () => {
    assert.equal(route("slack", "foxcale様の定例議事録を整理して").selected_agent, "foxcale-advisor");
  });

  it("keeps route hints for foxcale coding work", () => {
    assert.equal(route("slack", "foxcaleのGitHub repoのバグ修正を進めて").selected_agent, "foxcale-coding");
  });

  it("keeps route hints for generic coding work", () => {
    assert.equal(route("slack", "このrepoのテストを修正して").selected_agent, "coding");
  });

  it("keeps route hints for CISSP review quizzes", () => {
    assert.equal(route("telegram", "CISSPの復習クイズを出して").selected_agent, "learning-kb");
  });

  it("asks for clarification when route-only classification is ambiguous", () => {
    const result = route("slack", "これお願い");
    assert.equal(result.selected_agent, "router-agent");
    assert.equal(result.ambiguous, true);
    assert.match(result.question, /agent/);
  });
});
