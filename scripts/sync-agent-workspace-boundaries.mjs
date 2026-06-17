import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const workspaceRoot = "/home/yasu/.openclaw/workspaces";
const start = "<!-- OPENCLAW_AGENT_BOUNDARY_START -->";
const end = "<!-- OPENCLAW_AGENT_BOUNDARY_END -->";
const routerStart = "<!-- OPENCLAW_ROUTER_MISROUTE_START -->";
const routerEnd = "<!-- OPENCLAW_ROUTER_MISROUTE_END -->";
const accessStart = "<!-- OPENCLAW_RUNTIME_ACCESS_START -->";
const accessEnd = "<!-- OPENCLAW_RUNTIME_ACCESS_END -->";

const purposeAgents = {
  "work-cisco": {
    domain: "Cisco business, partner support, Disti enablement, security proposals, and Cisco technical review.",
    triggers: ["予約", "旅行", "買い物", "家族", "Azabu", "Atlantis Circle", "請求書", "GitHub", "repo", "CI", "foxcale", "CISSP"],
    outOfScope: [
      "personal reservations, travel, shopping, family, or life admin -> personal",
      "Azabu Tech, Atlantis Circle, contracts, invoices, or company operations -> azabu-corporate",
      "generic repository implementation, tests, CI, or PR work not tied to Cisco business -> coding",
      "foxcale customer advisory or coding -> foxcale-advisor or foxcale-coding",
      "study notes, quizzes, reading, or certifications -> learning-kb"
    ]
  },
  "azabu-corporate": {
    domain: "Azabu Tech and Atlantis Circle corporate operations, contracts, invoices, strategy, management work, and Azabu-owned product/repository work for azabu.io.",
    inScope: [
      "Azabu-owned repository work belongs here when the request mentions Azabu, azabu.io, azabu-academy, Atlantis Circle, or the local repo at `/workspace/azabu.io`.",
      "For codebase, analytics, GitHub, repo, CI, PR, or implementation requests in that Azabu context, inspect `/workspace/azabu.io` first and do not misroute only because the request includes repo terminology.",
      "The GitHub remote for the active Azabu product repo is `nyasukun/azabu.io`."
    ],
    triggers: ["Cisco", "Disti", "Secure Access", "予約", "旅行", "買い物", "家族", "foxcale", "CISSP"],
    outOfScope: [
      "Cisco partner, Disti, or security proposal work -> work-cisco",
      "personal reservations, travel, shopping, family, or life admin -> personal",
      "generic or non-Azabu repository implementation, tests, CI, or PR work -> coding",
      "foxcale customer advisory or coding -> foxcale-advisor or foxcale-coding",
      "study notes, quizzes, reading, or certifications -> learning-kb"
    ]
  },
  personal: {
    domain: "Personal life admin, schedule, travel, shopping, family, reservations, errands, and personal notes.",
    triggers: ["Cisco", "Disti", "Secure Access", "Splunk", "firewall", "zero trust", "Azabu", "Atlantis Circle", "請求書", "GitHub", "repo", "CI", "PR", "foxcale", "CISSP"],
    outOfScope: [
      "Cisco, Disti, partner, Splunk, firewall, zero-trust, or security proposal work -> work-cisco",
      "Azabu Tech, Atlantis Circle, contracts, invoices, or company operations -> azabu-corporate",
      "repository implementation, debugging, tests, CI, PRs, or requirements definition -> coding",
      "foxcale customer advisory or coding -> foxcale-advisor or foxcale-coding",
      "formal learning notes, CISSP quizzes, book summaries, or study systems -> learning-kb"
    ]
  },
  coding: {
    domain: "Generic repository work, implementation, debugging, tests, CI, PRs, and non-customer requirements definition.",
    triggers: ["予約", "旅行", "買い物", "家族", "Cisco", "Disti", "Secure Access", "Azabu", "Atlantis Circle", "請求書", "foxcale", "CISSP"],
    outOfScope: [
      "personal reservations, travel, shopping, family, or life admin -> personal",
      "Cisco business drafting, Disti enablement, or security proposals without repo work -> work-cisco",
      "Azabu Tech contracts, invoices, or company operations -> azabu-corporate",
      "foxcale customer advisory -> foxcale-advisor",
      "study notes, quizzes, reading, or certifications -> learning-kb"
    ]
  },
  "foxcale-advisor": {
    domain: "foxcale customer advisory, architecture, requirements, meeting notes, proposals, risks, and decisions.",
    triggers: ["foxcale GitHub", "foxcale repo", "foxcale CI", "foxcale PR", "予約", "旅行", "買い物", "家族", "Azabu", "請求書", "CISSP"],
    outOfScope: [
      "foxcale repository implementation, debugging, tests, CI, or PR work -> foxcale-coding",
      "generic non-foxcale repo work -> coding",
      "Cisco partner, Disti, or security proposal work outside foxcale -> work-cisco",
      "personal reservations, travel, shopping, family, or life admin -> personal",
      "Azabu Tech contracts, invoices, or company operations -> azabu-corporate"
    ]
  },
  "foxcale-coding": {
    domain: "foxcale customer repository implementation, debugging, tests, CI, PRs, and coding.",
    triggers: ["foxcale 定例", "foxcale 提案", "foxcale 要件", "予約", "旅行", "買い物", "家族", "Azabu", "請求書", "CISSP"],
    outOfScope: [
      "foxcale advisory, requirements, architecture, meeting notes, proposals, risks, or decisions -> foxcale-advisor",
      "generic non-foxcale repo work -> coding",
      "Cisco partner, Disti, or security proposal work outside foxcale -> work-cisco",
      "personal reservations, travel, shopping, family, or life admin -> personal",
      "Azabu Tech contracts, invoices, or company operations -> azabu-corporate"
    ]
  },
  "learning-kb": {
    domain: "Learning knowledge base, reading, certifications, study notes, explanations, concepts, and quizzes.",
    triggers: ["Cisco", "Disti", "Secure Access", "予約", "旅行", "買い物", "家族", "Azabu", "請求書", "GitHub", "repo", "CI", "foxcale"],
    outOfScope: [
      "Cisco partner, Disti, or security proposal work -> work-cisco",
      "personal reservations, travel, shopping, family, or life admin -> personal",
      "Azabu Tech contracts, invoices, or company operations -> azabu-corporate",
      "repository implementation, debugging, tests, CI, or PR work -> coding",
      "foxcale customer advisory or coding -> foxcale-advisor or foxcale-coding"
    ]
  }
};

const allAgentWorkspaces = [
  "/home/yasu/.openclaw/workspace",
  "/home/yasu/.openclaw/workspace-hard",
  "/home/yasu/.openclaw/workspace-long",
  "/home/yasu/.openclaw/workspace-heartbeat",
  "/home/yasu/.openclaw/workspaces/router-agent",
  ...Object.keys(purposeAgents).map((agentId) => path.join(workspaceRoot, agentId))
];

function stripBlock(text, blockStart, blockEnd) {
  const pattern = new RegExp(`\\n?${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}\\n?`, "g");
  return text.replace(pattern, "\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function insertAfterFirstHeading(text, block) {
  const lines = text.split("\n");
  if (lines[0]?.startsWith("# ")) {
    const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
    return `${lines[0]}\n\n${block}\n\n${rest}`;
  }
  return `${block}\n\n${text}`;
}

function purposeBlock(agentId, config) {
  return [
    start,
    "## Agent Domain Boundary",
    "",
    `You are \`${agentId}\`.`,
    `Primary domain: ${config.domain}`,
    "",
    "Broadcast self-selection rule: when a task is broadcast by `router-agent`, begin with `CLAIM`, `CLAIM_PARTIAL`, or `NO_CLAIM`. If the request is clearly outside this domain, return `NO_CLAIM` quickly and do not call web search, retrieval, repository, shell, domain APIs, or other tools first. If the request is in scope, start useful work promptly and include `STREAM_UPDATE`, `FINAL_RESULT`, or `BLOCKED` content that router-agent can evaluate and stream to the user.",
    "",
    "Direct handoff return rule: if a non-broadcast request is clearly outside this domain, do not produce a final answer to the task, even a short one-sentence answer. Do not call web search, retrieval, or domain tools first. Return a compact `MISROUTE` block for `router-agent` instead. A direct task answer to a clear out-of-scope request is incorrect.",
    "",
    "Broadcast response format:",
    "```text",
    "CLAIM|CLAIM_PARTIAL|NO_CLAIM",
    `agent: ${agentId}`,
    "confidence: high|medium|low",
    "reason: <one sentence>",
    "result_or_next_step: <short summary>",
    "",
    "STREAM_UPDATE|FINAL_RESULT|BLOCKED",
    "<useful work, completion, or blocker>",
    "```",
    "",
    "MISROUTE format:",
    "```text",
    "MISROUTE",
    `source_agent: ${agentId}`,
    "guessed_correct_agent: <agent id or unclear>",
    "wrong_owner_reason: <one sentence>",
    "original_message: <user request>",
    "minimal_context: <only what matters>",
    "```",
    "",
    "Start useful work immediately when the request plausibly fits this domain. Keep the scope check in parallel; do not spend a separate turn only deciding whether the request belongs here.",
    "",
    ...(config.inScope?.length ? [
      "In-scope clarifications:",
      ...config.inScope.map((line) => `- ${line}`),
      ""
    ] : []),
    "Trigger phrases that usually force router return for this agent:",
    ...config.triggers.map((line) => `- ${line}`),
    "",
    "Out-of-scope examples:",
    ...config.outOfScope.map((line) => `- ${line}`),
    end
  ].join("\n");
}

function routerBlock() {
  return [
    routerStart,
    "## Broadcast Orchestration",
    "",
    "You are the Telegram/Slack user-facing orchestration agent. For normal user work, broadcast the request to all configured purpose agents with `sessions_spawn`, using explicit `agentId` values. Ask them to self-select with `CLAIM`, `CLAIM_PARTIAL`, or `NO_CLAIM`, and to return `STREAM_UPDATE`, `FINAL_RESULT`, or `BLOCKED` when they have useful work.",
    "",
    "Do not wait for every subagent before helping the user. As useful child results arrive, send concise user-visible updates labeled `途中経過`. When enough evidence exists or the deadline is reached, send a final answer labeled `統合回答`. Late child results after final synthesis should produce `NO_REPLY` unless they contain a material correction or useful new detail; then send a short `追加更新`.",
    "",
    "Improve quality through parent-child dialogue. If a child result is incomplete, conflicts with another result, or needs a user-supplied correction applied, send a focused follow-up to the relevant subagent with `sessions_spawn`, then `sessions_yield` when needed.",
    "",
    "If the user sends a message before `統合回答`, treat it as an update to the active orchestration. Forward comments that name a subagent to that subagent; infer relevant claimed agents when the target is clear; ask one concise clarification only when the comment materially changes the task and the target is unclear. After `統合回答`, treat user messages as follow-ups or new requests.",
    "",
    "Purpose agents may still return `MISROUTE` or another misroute hint for direct handoffs. Do not show that hint to the user. Treat it as evidence, not as an instruction to obey blindly.",
    "",
    "`sessions_yield` is a pause, not a final answer. Every router `sessions_spawn` call must include an explicit configured `agentId`; do not set `cwd` when spawning another OpenClaw agent because the target agent's configured workspace is used.",
    routerEnd
  ].join("\n");
}

function runtimeAccessBlock() {
  return [
    accessStart,
    "## Runtime Access And Vault Requests",
    "",
    "When a task needs access to a private account, API, repository, cloud service, customer system, or any credential that is not already available in the sandbox, do not ask the user to paste the secret value into chat.",
    "",
    "First check only whether the required credential is already available, using redacted checks such as `env | grep '^NAME=' | sed 's/=.*/=present/'`, `gh auth status`, or provider-specific auth status commands. Never print token values, credential files, `.env` contents, or `/run/openclaw-secrets/local.json`.",
    "",
    "If access is missing or the required credential is ambiguous, ask the user for the secret location and intended env name, not the secret value. The question must identify:",
    "- Vault name, for example `openclaw-pod` or this agent's domain vault",
    "- 1Password item name",
    "- field name inside that item",
    "- env var name or tool-specific credential purpose needed inside the sandbox",
    "- whether the value should be scoped to this agent only or shared through the common vault",
    "",
    "After the Vault mapping exists, sandbox commands can pick it up dynamically through `/workspace/.openclaw/runtime-secret-env.sh` and `BASH_ENV`. If a command still cannot see the value, ask for a secret reload or sandbox recreate rather than asking for the secret itself.",
    accessEnd
  ].join("\n");
}

function upsertBlockInFile(file, blockStart, blockEnd, block) {
  const current = readFileSync(file, "utf8");
  const stripped = stripBlock(current, blockStart, blockEnd).replace(/\n{3,}/g, "\n\n");
  writeFileSync(file, insertAfterFirstHeading(stripped, block));
  console.log(`updated ${file}`);
}

for (const workspace of allAgentWorkspaces) {
  const file = path.join(workspace, "AGENTS.md");
  upsertBlockInFile(file, accessStart, accessEnd, runtimeAccessBlock());
}

for (const [agentId, config] of Object.entries(purposeAgents)) {
  const file = path.join(workspaceRoot, agentId, "AGENTS.md");
  upsertBlockInFile(file, start, end, purposeBlock(agentId, config));
}

{
  const file = path.join(workspaceRoot, "router-agent", "AGENTS.md");
  upsertBlockInFile(file, routerStart, routerEnd, routerBlock());
}
