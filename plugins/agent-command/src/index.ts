import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  definePluginEntry,
  type OpenClawPluginDefinition,
  type PluginCommandContext,
  type PluginCommandResult,
} from "openclaw/plugin-sdk/core";
import { getSessionBindingService, type SessionBindingRecord, type SessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import { listSessionEntries, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";

const PLUGIN_ID = "agent-command";
const ROUTER_AGENT_ID = "router-agent";
const DEFAULT_SESSION_LIST_LIMIT = 10;
const MAX_SESSION_LIST_LIMIT = 25;
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
> & {
  isAuthorizedSender?: boolean;
};

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

type SessionConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

type SessionCommandRuntime = Pick<SessionBindingService, "bind" | "getCapabilities" | "resolveByConversation" | "unbind">;

type SessionCommandDependencies = {
  getBindingService?: () => SessionCommandRuntime;
  listSessionEntries?: typeof listSessionEntries;
  now?: () => number;
};

type ListedSession = {
  agentId: string;
  entry: SessionEntry;
  index: number;
  label: string;
  sessionKey: string;
  updatedAt: number;
};

type ParsedSessionCommand =
  | { action: "clear" }
  | { action: "current" }
  | { action: "invalid"; input: string }
  | { action: "list"; limit: number }
  | { action: "missing-target" }
  | { action: "switch"; selector: string };

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampSessionListLimit(value: number | undefined): number {
  if (!value) return DEFAULT_SESSION_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_SESSION_LIST_LIMIT, Math.floor(value)));
}

function parseSessionListLimit(value: string | undefined): number {
  if (!value) return DEFAULT_SESSION_LIST_LIMIT;
  const parsed = Number.parseInt(value, 10);
  return clampSessionListLimit(Number.isFinite(parsed) ? parsed : undefined);
}

export function parseSessionCommand(args: string | undefined): ParsedSessionCommand {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) return { action: "list", limit: DEFAULT_SESSION_LIST_LIMIT };

  const [rawVerb = "", ...rest] = trimmed.split(/\s+/u);
  const verb = rawVerb.toLowerCase();
  if (/^(list|ls|help|\?)$/u.test(verb)) return { action: "list", limit: parseSessionListLimit(rest[0]) };
  if (/^(current|status|where)$/u.test(verb)) return { action: "current" };
  if (/^(clear|detach|reset|unfocus)$/u.test(verb)) return { action: "clear" };

  if (/^(use|switch|select|bind)$/u.test(verb)) {
    const selector = rest.join(" ").trim();
    if (!selector) return { action: "missing-target" };
    return { action: "switch", selector };
  }

  if (/^\d+$/u.test(trimmed) || trimmed.startsWith("agent:")) return { action: "switch", selector: trimmed };
  return { action: "invalid", input: trimmed };
}

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const match = readString(sessionKey)?.match(/^agent:([^:]+):/u);
  return match?.[1];
}

export function resolveSessionListAgentId(ctx: Pick<AgentCommandContext, "sessionKey">): string {
  return resolveAgentIdFromSessionKey(ctx.sessionKey) ?? ROUTER_AGENT_ID;
}

function buildTopicConversationId(baseConversationId: string, threadId: string): string {
  return baseConversationId.includes(":topic:") ? baseConversationId : `${baseConversationId}:topic:${threadId}`;
}

export function buildSessionConversationRef(
  ctx: Pick<AgentCommandContext, "accountId" | "channel" | "channelId" | "from" | "messageThreadId" | "senderId" | "threadParentId" | "to">,
): SessionConversationRef | undefined {
  const channel = readString(ctx.channel);
  if (!channel) return undefined;
  const accountId = readString(ctx.accountId) ?? DEFAULT_ACCOUNT_ID;
  const threadId = stringifyThreadId(ctx.messageThreadId);
  const baseConversationId =
    readString(ctx.threadParentId) ?? readString(ctx.channelId) ?? readString(ctx.senderId) ?? readString(ctx.from) ?? readString(ctx.to);
  if (!baseConversationId) return undefined;
  if (!threadId) return { channel, accountId, conversationId: baseConversationId };

  return {
    channel,
    accountId,
    conversationId: buildTopicConversationId(baseConversationId, threadId),
    parentConversationId: baseConversationId,
  };
}

function compactSessionKey(sessionKey: string, agentId?: string): string {
  const prefix = agentId ? `agent:${agentId}:` : "agent:";
  const compacted = sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : sessionKey;
  if (compacted.length <= 72) return compacted;
  return `${compacted.slice(0, 34)}...${compacted.slice(-34)}`;
}

function readSessionLabel(sessionKey: string, entry: SessionEntry, agentId: string): string {
  return (
    readString(entry.displayName) ??
    readString(entry.label) ??
    readString(entry.subject) ??
    readString(entry.origin?.label) ??
    compactSessionKey(sessionKey, agentId)
  );
}

function readSessionModel(entry: SessionEntry): string | undefined {
  const override = readString(entry.modelOverride);
  if (override) return override;
  const provider = readString(entry.modelProvider);
  const model = readString(entry.model);
  if (provider && model && !model.includes("/")) return `${provider}/${model}`;
  return model ?? provider;
}

function formatTokenCount(value: number | undefined): string | undefined {
  if (typeof value !== "number") return undefined;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k tok`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k tok`;
  return `${value} tok`;
}

function formatRelativeAge(updatedAt: number, now: number): string {
  const deltaMs = Math.max(0, now - updatedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (deltaMs < minute) return "1分未満前";
  if (deltaMs < hour) return `${Math.floor(deltaMs / minute)}分前`;
  if (deltaMs < day) return `${Math.floor(deltaMs / hour)}時間前`;
  if (deltaMs < 14 * day) return `${Math.floor(deltaMs / day)}日前`;
  return new Date(updatedAt).toISOString().slice(0, 10);
}

export function buildSwitchableSessions(
  entries: Array<{ sessionKey: string; entry: SessionEntry }>,
  agentId: string,
  now = Date.now(),
  channel?: string,
): ListedSession[] {
  const channelPrefix = channel ? `agent:${agentId}:${channel}:` : undefined;
  return entries
    .filter(({ sessionKey, entry }) => {
      if (!sessionKey.startsWith(`agent:${agentId}:`)) return false;
      if (channelPrefix && !sessionKey.startsWith(channelPrefix)) return false;
      if (entry.heartbeatIsolatedBaseSessionKey) return false;
      if (entry.pluginOwnerId) return false;
      return true;
    })
    .map(({ sessionKey, entry }) => ({
      agentId,
      entry,
      index: 0,
      label: readSessionLabel(sessionKey, entry, agentId),
      sessionKey,
      updatedAt: readNumber(entry.updatedAt) ?? now,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session, index) => ({ ...session, index: index + 1 }));
}

export function selectSessionTarget(selector: string, sessions: ListedSession[]): ListedSession | undefined {
  const trimmed = selector.trim();
  if (/^\d+$/u.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    return sessions.find((session) => session.index === index);
  }
  return sessions.find((session) => session.sessionKey === trimmed || compactSessionKey(session.sessionKey, session.agentId) === trimmed);
}

function formatSessionLine(session: ListedSession, now: number, currentSessionKey?: string, binding?: SessionBindingRecord | null): string {
  const markers = [
    session.sessionKey === currentSessionKey ? "現在" : "",
    binding?.targetSessionKey === session.sessionKey ? "固定中" : "",
  ].filter(Boolean);
  const markerText = markers.length > 0 ? ` [${markers.join("/")}]` : "";
  const model = readSessionModel(session.entry);
  const tokens = formatTokenCount(readNumber(session.entry.totalTokens));
  const details = [formatRelativeAge(session.updatedAt, now), model, tokens].filter(Boolean).join(" / ");
  return `${session.index}. ${session.label}${markerText}\n   ${details}`;
}

export function formatSessionList(
  sessions: ListedSession[],
  params: { binding?: SessionBindingRecord | null; currentSessionKey?: string; limit: number; now?: number },
): string {
  if (sessions.length === 0) {
    return [
      "過去セッションが見つかりません。",
      "",
      "新しい会話は /new で作れます。",
    ].join("\n");
  }

  const now = params.now ?? Date.now();
  const visible = sessions.slice(0, params.limit);
  return [
    "最近のセッション:",
    ...visible.map((session) => formatSessionLine(session, now, params.currentSessionKey, params.binding)),
    "",
    "切り替え:",
    "/session use <番号>",
    "/session current",
    "/session clear",
  ].join("\n");
}

function buildSessionHelp(input: string): string {
  return [
    `未知の /session 操作: ${input}`,
    "",
    "使い方:",
    "/session または /session list",
    "/session use <番号>",
    "/session current",
    "/session clear",
  ].join("\n");
}

function formatCurrentSession(ctx: AgentCommandContext, ref?: SessionConversationRef, binding?: SessionBindingRecord | null): string {
  return [
    "現在のセッション:",
    `active: ${readString(ctx.sessionKey) ? compactSessionKey(String(ctx.sessionKey), resolveSessionListAgentId(ctx)) : "不明"}`,
    `binding: ${binding ? compactSessionKey(binding.targetSessionKey, resolveAgentIdFromSessionKey(binding.targetSessionKey)) : "なし"}`,
    `conversation: ${ref ? `${ref.channel}/${ref.accountId}/${ref.conversationId}` : "不明"}`,
  ].join("\n");
}

function resolveCurrentBinding(runtime: SessionCommandRuntime, ref: SessionConversationRef | undefined): SessionBindingRecord | null {
  if (!ref) return null;
  try {
    return runtime.resolveByConversation(ref);
  } catch {
    return null;
  }
}

function isSessionCommandAuthorized(ctx: AgentCommandContext): boolean {
  return ctx.isAuthorizedSender !== false;
}

async function bindSelectedSession(
  runtime: SessionCommandRuntime,
  ref: SessionConversationRef,
  session: ListedSession,
  ctx: AgentCommandContext,
): Promise<void> {
  const capabilities = runtime.getCapabilities({ channel: ref.channel, accountId: ref.accountId });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported || !capabilities.placements.includes("current")) {
    throw new Error(`このチャネルでは session binding が使えません: ${ref.channel}/${ref.accountId}`);
  }
  await runtime.bind({
    targetKind: "session",
    targetSessionKey: session.sessionKey,
    conversation: ref,
    placement: "current",
    metadata: {
      source: PLUGIN_ID,
      command: "session",
      selectedBy: readString(ctx.senderId) ?? readString(ctx.from) ?? "unknown",
      selectedAt: new Date().toISOString(),
    },
  });
}

async function clearSessionBinding(runtime: SessionCommandRuntime, binding: SessionBindingRecord): Promise<void> {
  const capabilities = runtime.getCapabilities({
    channel: binding.conversation.channel,
    accountId: binding.conversation.accountId,
  });
  if (!capabilities.adapterAvailable || !capabilities.unbindSupported) {
    throw new Error(`このチャネルでは session binding 解除が使えません: ${binding.conversation.channel}/${binding.conversation.accountId}`);
  }
  await runtime.unbind({ bindingId: binding.bindingId, reason: "session-command-clear" });
}

export async function handleSessionCommand(ctx: AgentCommandContext, deps: SessionCommandDependencies = {}): Promise<PluginCommandResult> {
  if (!isSessionCommandAuthorized(ctx)) {
    return { text: "このコマンドは許可済みユーザーだけが実行できます。", isError: true };
  }

  const parsed = parseSessionCommand(ctx.args);
  if (parsed.action === "invalid") return { text: buildSessionHelp(parsed.input), isError: true };
  if (parsed.action === "missing-target") return { text: "/session use の後に番号か session key を指定してください。", isError: true };

  const agentId = resolveSessionListAgentId(ctx);
  const readEntries = deps.listSessionEntries ?? listSessionEntries;
  const now = deps.now?.() ?? Date.now();
  const sessions = buildSwitchableSessions(readEntries({ agentId }), agentId, now, readString(ctx.channel));
  const runtime = deps.getBindingService?.() ?? getSessionBindingService();
  const ref = buildSessionConversationRef(ctx);
  const binding = resolveCurrentBinding(runtime, ref);

  if (parsed.action === "list") {
    return { text: formatSessionList(sessions, { binding, currentSessionKey: ctx.sessionKey, limit: parsed.limit, now }) };
  }
  if (parsed.action === "current") {
    return { text: formatCurrentSession(ctx, ref, binding) };
  }
  if (parsed.action === "clear") {
    if (!binding) return { text: "この会話には session 固定はありません。" };
    await clearSessionBinding(runtime, binding);
    return { text: "セッション固定を解除しました。次のメッセージから通常ルーティングに戻ります。" };
  }

  const selected = selectSessionTarget(parsed.selector, sessions);
  if (!selected) {
    return {
      text: [
        `該当する session が見つかりません: ${parsed.selector}`,
        "",
        formatSessionList(sessions, { binding, currentSessionKey: ctx.sessionKey, limit: DEFAULT_SESSION_LIST_LIMIT, now }),
      ].join("\n"),
      isError: true,
    };
  }
  if (!ref) return { text: "このチャネルの conversation id を解決できないため、切り替えできません。", isError: true };
  if (binding?.targetSessionKey === selected.sessionKey) {
    return { text: `すでにこの会話は ${selected.index}. ${selected.label} に固定されています。` };
  }

  await bindSelectedSession(runtime, ref, selected, ctx);
  return {
    text: [
      "セッションを切り替えました。次のメッセージからこの session に入ります。",
      "",
      formatSessionLine(selected, now, ctx.sessionKey, { targetSessionKey: selected.sessionKey } as SessionBindingRecord),
    ].join("\n"),
  };
}

const commandGuidance = [
  {
    text: "When the current user message is `/agent <agent-id> <request>`, treat it as an explicit single-agent command. Normalize underscores in the agent id to hyphens, verify the id is one of the configured purpose agents, then run the remaining request on that agent. This command is the intentional exception to router-agent's normal broadcast orchestration flow.",
    surfaces: ["openclaw_main" as const],
  },
  {
    text: "When the current user message is `/session`, `/session list`, `/session use <number>`, `/session current`, or `/session clear`, treat it as a channel session-management command handled by the agent-command plugin. Do not answer it as normal user work.",
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
  description: "List purpose agents, run explicit /agent requests, and switch channel sessions with /session.",
  register(api) {
    const runDirectAgent = createDirectAgentRunner(api.runtime as unknown as AgentCommandIngressRuntime);

    api.registerCommand({
      name: "agent",
      description: "List purpose agents or run a request on one.",
      acceptsArgs: true,
      agentPromptGuidance: commandGuidance,
      handler: (ctx) => handleAgentCommand(ctx, runDirectAgent),
    });

    api.registerCommand({
      name: "session",
      description: "List, inspect, switch, or clear the current channel session binding.",
      acceptsArgs: true,
      agentPromptGuidance: commandGuidance,
      handler: (ctx) => handleSessionCommand(ctx),
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
