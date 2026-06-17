import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import { definePluginEntry, type OpenClawPluginDefinition, type PluginCommandContext, type PluginCommandResult } from "openclaw/plugin-sdk/core";

const PLUGIN_ID = "agent-command";
const ROUTER_AGENT_ID = "router-agent";
const ROUTER_BLOCKED_TOOL_NAMES = new Set([
  "apply_patch",
  "browser",
  "edit",
  "exec",
  "image",
  "process",
  "read",
  "sandbox_exec",
  "sandbox_process",
  "sessions_send",
  "web_fetch",
  "web_search",
  "write",
]);

type AgentConfig = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  model?: {
    primary?: unknown;
  };
  subagents?: {
    allowAgents?: unknown;
  };
};

type OpenClawConfigLike = {
  agents?: {
    list?: unknown;
  };
};

type ListedAgent = {
  id: string;
  name: string;
  description: string;
  model?: string;
};

export function normalizeAgentId(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

function normalizeToolName(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function shouldBlockRouterTool(agentId: string | undefined, toolName: string | undefined): boolean {
  return normalizeAgentId(agentId ?? "") === ROUTER_AGENT_ID && ROUTER_BLOCKED_TOOL_NAMES.has(normalizeToolName(toolName));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readAgentList(config: OpenClawConfigLike): AgentConfig[] {
  const list = config.agents?.list;
  if (!Array.isArray(list)) return [];
  return list.filter(isRecord) as AgentConfig[];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizeDescription(value: unknown): string {
  const raw = readString(value);
  if (!raw) return "";
  const firstSentence = raw.split(/(?<=\.)\s+/u)[0]?.trim() ?? raw;
  return firstSentence.length > 120 ? `${firstSentence.slice(0, 117)}...` : firstSentence;
}

export function listPurposeAgents(config: OpenClawConfigLike): ListedAgent[] {
  const agents = readAgentList(config);
  const router = agents.find((agent) => readString(agent.id) === ROUTER_AGENT_ID);
  const allowed = Array.isArray(router?.subagents?.allowAgents)
    ? router.subagents.allowAgents.map((value) => readString(value)).filter((value): value is string => Boolean(value))
    : [];
  const allowedSet = new Set(allowed.map(normalizeAgentId));
  const listedAgents: ListedAgent[] = [];
  for (const agent of agents) {
    const id = readString(agent.id);
    if (!id || !allowedSet.has(normalizeAgentId(id))) continue;
    const listed: ListedAgent = {
      id,
      name: readString(agent.name) ?? id,
      description: summarizeDescription(agent.description),
    };
    const model = readString(agent.model?.primary);
    if (model) listed.model = model;
    listedAgents.push(listed);
  }
  return listedAgents;
}

export function formatAgentList(agents: ListedAgent[]): string {
  if (agents.length === 0) {
    return [
      "目的別 agent が見つかりません。",
      "",
      "router-agent.subagents.allowAgents を確認してください。",
    ].join("\n");
  }
  return [
    "使える agent:",
    ...agents.map((agent) => {
      const summary = agent.description ? ` - ${agent.description}` : "";
      const model = agent.model ? ` (${agent.model})` : "";
      return `- ${agent.id}${model}${summary}`;
    }),
    "",
    "使い方:",
    "/agent",
    "/agent list",
    "/agent <agent-id> <依頼内容>",
    "例: /agent personal レストランを予約して",
  ].join("\n");
}

type ParsedAgentCommand =
  | { action: "list" }
  | { action: "invalid"; target: string }
  | { action: "missing-task"; target: string }
  | { action: "route"; target: string; task: string };

export function parseAgentCommand(args: string | undefined, agents: ListedAgent[]): ParsedAgentCommand {
  const trimmed = args?.trim() ?? "";
  if (!trimmed || /^(list|ls|help|\?)$/i.test(trimmed)) return { action: "list" };

  const [rawTarget = "", ...rest] = trimmed.split(/\s+/u);
  const target = normalizeAgentId(rawTarget);
  const allowed = new Set(agents.map((agent) => normalizeAgentId(agent.id)));
  if (!allowed.has(target)) return { action: "invalid", target: rawTarget };
  const task = rest.join(" ").trim();
  if (task.length === 0) return { action: "missing-task", target };
  return { action: "route", target, task };
}

function buildInvalidTargetReply(target: string, agents: ListedAgent[]): string {
  return [
    `未知の agent: ${target}`,
    "",
    formatAgentList(agents),
  ].join("\n");
}

function buildMissingTaskReply(target: string): string {
  return `/agent ${target} の後に依頼内容を続けてください。`;
}

type AgentCommandContext = Pick<
  PluginCommandContext,
  | "accountId"
  | "args"
  | "channel"
  | "channelId"
  | "config"
  | "from"
  | "messageThreadId"
  | "senderId"
  | "senderIsOwner"
  | "sessionKey"
  | "threadParentId"
  | "to"
>;

type DirectAgentRunner = (ctx: AgentCommandContext, target: string, task: string) => Promise<void>;

type AgentCommandIngressRuntime = Parameters<typeof agentCommandFromIngress>[1];
type AgentCommandDeliveryResult = Awaited<ReturnType<typeof agentCommandFromIngress>>;

export function resolveTargetSessionKey(ctx: Pick<AgentCommandContext, "channel" | "senderId" | "sessionKey">, target: string): string {
  const current = readString(ctx.sessionKey);
  const currentMatch = current?.match(/^agent:[^:]+:(.+)$/u);
  if (currentMatch?.[1]) return `agent:${target}:${currentMatch[1]}`;

  const channel = normalizeAgentId(ctx.channel || "command");
  const sender = readString(ctx.senderId)?.replaceAll(/[^a-zA-Z0-9._@:-]+/gu, "_") ?? "unknown";
  return `agent:${target}:${channel}:direct:${sender}`;
}

function readPayloadText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return readString(value.text);
}

export function formatAgentRunResult(result: AgentCommandDeliveryResult, target: string): PluginCommandResult {
  const payloadTexts = Array.isArray(result.payloads) ? result.payloads.map(readPayloadText).filter((value): value is string => Boolean(value)) : [];
  const messagingToolTexts = Array.isArray(result.messagingToolSentTexts)
    ? result.messagingToolSentTexts.map(readString).filter((value): value is string => Boolean(value))
    : [];
  const text = [...payloadTexts, ...messagingToolTexts].join("\n").trim();
  if (text) return { text };
  return {
    text: `${target} は実行されましたが、返答テキストが空でした。`,
    isError: true,
  };
}

function stringifyThreadId(value: string | number | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function resolveReplyTarget(ctx: Pick<AgentCommandContext, "channelId" | "from" | "senderId" | "to">): string | undefined {
  return readString(ctx.channelId) ?? readString(ctx.senderId) ?? readString(ctx.from) ?? readString(ctx.to);
}

function buildDispatchReply(target: string): string {
  return `${target} に渡しました。完了したらここに返します。`;
}

function logBackgroundAgentError(target: string, error: unknown): void {
  const details = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[agent-command] ${target} background run failed: ${details}`);
}

function createDirectAgentRunner(runtime: AgentCommandIngressRuntime): DirectAgentRunner {
  return async (ctx, target, task) => {
    const replyTarget = resolveReplyTarget(ctx);
    await agentCommandFromIngress(
      {
        message: task,
        transcriptMessage: task,
        agentId: target,
        sessionKey: resolveTargetSessionKey(ctx, target),
        channel: ctx.channel,
        messageChannel: ctx.channel,
        messageProvider: ctx.channel,
        to: replyTarget,
        replyTo: replyTarget,
        replyChannel: ctx.channel,
        accountId: ctx.accountId,
        replyAccountId: ctx.accountId,
        threadId: stringifyThreadId(ctx.messageThreadId),
        deliver: true,
        allowModelOverride: false,
        senderIsOwner: ctx.senderIsOwner === true,
        runContext: {
          messageChannel: ctx.channel,
          accountId: ctx.accountId,
          currentChannelId: ctx.channelId,
          currentThreadTs: stringifyThreadId(ctx.messageThreadId),
          senderId: ctx.senderId ?? null,
        },
      },
      runtime,
    );
  };
}

export async function handleAgentCommand(ctx: AgentCommandContext, runner?: DirectAgentRunner): Promise<PluginCommandResult> {
  const agents = listPurposeAgents(ctx.config as OpenClawConfigLike);
  const parsed = parseAgentCommand(ctx.args, agents);
  if (parsed.action === "list") return { text: formatAgentList(agents) };
  if (parsed.action === "invalid") return { text: buildInvalidTargetReply(parsed.target, agents), isError: true };
  if (parsed.action === "missing-task") return { text: buildMissingTaskReply(parsed.target), isError: true };
  if (!runner) {
    return {
      text: "agent-command の direct runner が初期化されていません。",
      isError: true,
    };
  }
  void runner(ctx, parsed.target, parsed.task).catch((error) => logBackgroundAgentError(parsed.target, error));
  return { text: buildDispatchReply(parsed.target) };
}

const commandGuidance = [
  {
    text: "When the current user message is `/agent <agent-id> <request>`, treat it as an explicit single-agent command. Normalize underscores in the agent id to hyphens, verify the id is one of the configured purpose agents, then run the remaining request on that agent. This command is the intentional exception to router-agent's normal broadcast orchestration flow.",
    surfaces: ["openclaw_main" as const],
  },
];

const routerGuardGuidance = [
  "Router guard: router-agent is the Telegram/Slack user-facing orchestration agent.",
  "For normal user work, broadcast with sessions_spawn to the configured purpose agents, then call sessions_yield when available.",
  "Do not wait for every subagent before helping the user; stream useful child results as they arrive and finish with a clearly labeled integrated answer.",
  "Treat user comments before the integrated answer as updates to the active orchestration and forward them to named or relevant subagents.",
  "Do not inspect repositories, files, diffs, logs, web pages, or command output in router-agent.",
  "If a blocked direct-work tool would be useful, delegate the work to subagents instead of retrying that tool.",
].join(" ");

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: PLUGIN_ID,
  name: "Agent Command",
  description: "List configured purpose agents and run explicit /agent requests on the selected agent.",
  register(api) {
    const runDirectAgent = createDirectAgentRunner(api.runtime as unknown as AgentCommandIngressRuntime);

    api.registerCommand({
      name: "agent",
      description: "List purpose agents or run a request on one.",
      acceptsArgs: true,
      agentPromptGuidance: commandGuidance,
      handler: (ctx) => handleAgentCommand(ctx, runDirectAgent),
    });

    api.on(
      "before_prompt_build",
      (_event, ctx) => {
        if (normalizeAgentId(ctx.agentId ?? "") !== ROUTER_AGENT_ID) return;
        return { appendSystemContext: routerGuardGuidance };
      },
      { priority: 80 },
    );

    api.on(
      "before_tool_call",
      (event, ctx) => {
        if (!shouldBlockRouterTool(ctx.agentId, event.toolName)) return;
        return {
          block: true,
          blockReason:
            "router-agent must orchestrate this work through sessions_spawn instead of using direct file, shell, web, or media tools.",
        };
      },
      { priority: 100 },
    );
  },
});

export default entry;
