import { describe, expect, it } from "vitest";
import {
  buildSessionConversationRef,
  buildSwitchableSessions,
  formatAgentList,
  formatAgentRunResult,
  formatSessionList,
  handleAgentCommand,
  handleSessionCommand,
  listPurposeAgents,
  normalizeAgentId,
  parseAgentCommand,
  parseSessionCommand,
  resolveReplyTarget,
  resolveSessionListAgentId,
  resolveTargetSessionKey,
  selectSessionTarget,
  shouldBlockRouterTool,
} from "./index.js";

const config = {
  agents: {
    list: [
      {
        id: "router-agent",
        subagents: {
          allowAgents: ["personal", "foxcale-coding"],
        },
      },
      {
        id: "personal",
        name: "personal",
        description: "Personal life admin agent for schedule, travel, shopping, family, and personal notes. Extra text.",
        model: {
          primary: "openai/gpt-5.5",
        },
      },
      {
        id: "foxcale-coding",
        name: "foxcale-coding",
        description: "foxcale customer coding agent for implementation and repository work.",
      },
      {
        id: "main",
        name: "main",
      },
    ],
  },
};

describe("agent-command", () => {
  it("normalizes Telegram-safe underscore aliases", () => {
    expect(normalizeAgentId("foxcale_coding")).toBe("foxcale-coding");
  });

  it("lists only router-allowed purpose agents", () => {
    expect(listPurposeAgents(config).map((agent) => agent.id)).toEqual(["personal", "foxcale-coding"]);
  });

  it("formats /agent output with usage", () => {
    const output = formatAgentList(listPurposeAgents(config));
    expect(output).toContain("使える agent:");
    expect(output).toContain("/agent list");
    expect(output).toContain("/agent <agent-id> <依頼内容>");
    expect(output).not.toContain("main");
  });

  it("treats empty or list args as list", () => {
    const agents = listPurposeAgents(config);
    expect(parseAgentCommand(undefined, agents)).toEqual({ action: "list" });
    expect(parseAgentCommand("list", agents)).toEqual({ action: "list" });
  });

  it("runs the explicitly targeted agent with the task", async () => {
    const calls: Array<{ target: string; task: string }> = [];
    const result = await handleAgentCommand(
      {
        args: "personal レストランを予約して",
        channel: "telegram",
        config,
      },
      async (_ctx, target, task) => {
        calls.push({ target, task });
      },
    );
    expect(result).toEqual({ text: "personal に渡しました。完了したらここに返します。" });
    expect(calls).toEqual([{ target: "personal", task: "レストランを予約して" }]);
  });

  it("accepts underscore target aliases", async () => {
    const calls: Array<{ target: string; task: string }> = [];
    const result = await handleAgentCommand(
      {
        args: "foxcale_coding repoを確認して",
        channel: "telegram",
        config,
      },
      async (_ctx, target, task) => {
        calls.push({ target, task });
      },
    );
    expect(result).toEqual({ text: "foxcale-coding に渡しました。完了したらここに返します。" });
    expect(calls).toEqual([{ target: "foxcale-coding", task: "repoを確認して" }]);
  });

  it("rejects unknown targets before invoking the agent", async () => {
    const result = await handleAgentCommand({ args: "web 検索して", channel: "telegram", config });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("未知の agent: web");
  });

  it("requires a task after an explicit target", async () => {
    const result = await handleAgentCommand({ args: "personal", channel: "telegram", config });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("/agent personal の後に依頼内容");
  });

  it("derives target session keys from the current channel session", () => {
    expect(
      resolveTargetSessionKey(
        {
          channel: "telegram",
          senderId: "5089072082",
          sessionKey: "agent:router-agent:telegram:direct:5089072082",
        },
        "azabu-corporate",
      ),
    ).toBe("agent:azabu-corporate:telegram:direct:5089072082");
  });

  it("prefers channel id for explicit reply delivery targets", () => {
    expect(
      resolveReplyTarget({
        channelId: "group-123",
        senderId: "user-456",
        from: "from-789",
        to: "bot",
      }),
    ).toBe("group-123");
    expect(resolveReplyTarget({ senderId: "5089072082" })).toBe("5089072082");
  });

  it("formats agent run payload text for command replies", () => {
    expect(
      formatAgentRunResult(
        {
          payloads: [{ text: "hello" }],
          meta: {},
        } as never,
        "personal",
      ),
    ).toEqual({ text: "hello" });
  });

  it("blocks direct work tools only for router-agent", () => {
    expect(shouldBlockRouterTool("router-agent", "exec")).toBe(true);
    expect(shouldBlockRouterTool("router_agent", "read")).toBe(true);
    expect(shouldBlockRouterTool("router-agent", "sessions_send")).toBe(true);
    expect(shouldBlockRouterTool("router-agent", "sessions_spawn")).toBe(false);
    expect(shouldBlockRouterTool("foxcale-coding", "exec")).toBe(false);
  });

  it("parses /session list, switch, current, and clear commands", () => {
    expect(parseSessionCommand(undefined)).toEqual({ action: "list", limit: 10 });
    expect(parseSessionCommand("list 20")).toEqual({ action: "list", limit: 20 });
    expect(parseSessionCommand("use 2")).toEqual({ action: "switch", selector: "2" });
    expect(parseSessionCommand("2")).toEqual({ action: "switch", selector: "2" });
    expect(parseSessionCommand("switch agent:router-agent:telegram:direct:5089072082")).toEqual({
      action: "switch",
      selector: "agent:router-agent:telegram:direct:5089072082",
    });
    expect(parseSessionCommand("current")).toEqual({ action: "current" });
    expect(parseSessionCommand("clear")).toEqual({ action: "clear" });
  });

  it("resolves the session-list agent from the current session key", () => {
    expect(resolveSessionListAgentId({ sessionKey: "agent:router-agent:telegram:direct:5089072082" })).toBe("router-agent");
    expect(resolveSessionListAgentId({})).toBe("router-agent");
  });

  it("builds Telegram conversation refs for DMs and topics", () => {
    expect(
      buildSessionConversationRef({
        accountId: "default",
        channel: "telegram",
        channelId: "5089072082",
      }),
    ).toEqual({
      accountId: "default",
      channel: "telegram",
      conversationId: "5089072082",
    });

    expect(
      buildSessionConversationRef({
        channel: "telegram",
        channelId: "-100123",
        messageThreadId: 42,
      }),
    ).toEqual({
      accountId: "default",
      channel: "telegram",
      conversationId: "-100123:topic:42",
      parentConversationId: "-100123",
    });
  });

  it("sorts switchable sessions and selects by list index", () => {
    const sessions = buildSwitchableSessions(
      [
        {
          sessionKey: "agent:router-agent:telegram:direct:old",
          entry: { sessionId: "old", updatedAt: 1_000, model: "gpt-old" } as never,
        },
        {
          sessionKey: "agent:router-agent:telegram:direct:new",
          entry: { sessionId: "new", updatedAt: 2_000, model: "gpt-new", totalTokens: 12_345 } as never,
        },
        {
          sessionKey: "agent:other:telegram:direct:hidden",
          entry: { sessionId: "hidden", updatedAt: 3_000 } as never,
        },
      ],
      "router-agent",
      3_000,
    );
    expect(sessions.map((session) => session.sessionKey)).toEqual([
      "agent:router-agent:telegram:direct:new",
      "agent:router-agent:telegram:direct:old",
    ]);
    expect(selectSessionTarget("2", sessions)?.sessionKey).toBe("agent:router-agent:telegram:direct:old");
    const output = formatSessionList(sessions, {
      currentSessionKey: "agent:router-agent:telegram:direct:new",
      limit: 10,
      now: 3_000,
    });
    expect(output).toContain("最近のセッション:");
    expect(output).toContain("[現在]");
    expect(output).toContain("12k tok");
  });

  it("can filter switchable sessions to the current channel", () => {
    const sessions = buildSwitchableSessions(
      [
        {
          sessionKey: "agent:router-agent:telegram:direct:5089072082",
          entry: { sessionId: "telegram", updatedAt: 3_000 } as never,
        },
        {
          sessionKey: "agent:router-agent:contextfix-route-smoke-20260617",
          entry: { sessionId: "smoke", updatedAt: 4_000 } as never,
        },
      ],
      "router-agent",
      5_000,
      "telegram",
    );
    expect(sessions.map((session) => session.sessionKey)).toEqual(["agent:router-agent:telegram:direct:5089072082"]);
  });

  it("binds the current Telegram conversation to the selected session", async () => {
    const binds: unknown[] = [];
    const result = await handleSessionCommand(
      {
        args: "use 2",
        channel: "telegram",
        channelId: "5089072082",
        config,
        isAuthorizedSender: true,
        senderId: "5089072082",
        sessionKey: "agent:router-agent:telegram:direct:current",
      },
      {
        now: () => 3_000,
        listSessionEntries: () => [
          {
            sessionKey: "agent:router-agent:telegram:direct:current",
            entry: { sessionId: "current", updatedAt: 3_000 } as never,
          },
          {
            sessionKey: "agent:router-agent:telegram:direct:target",
            entry: { sessionId: "target", updatedAt: 2_000 } as never,
          },
        ],
        getBindingService: () => ({
          bind: async (input) => {
            binds.push(input);
            return {
              bindingId: "binding-1",
              boundAt: 3_000,
              conversation: input.conversation,
              status: "active",
              targetKind: input.targetKind,
              targetSessionKey: input.targetSessionKey,
            };
          },
          getCapabilities: () => ({
            adapterAvailable: true,
            bindSupported: true,
            placements: ["current"],
            unbindSupported: true,
          }),
          resolveByConversation: () => null,
          unbind: async () => [],
        }),
      },
    );
    expect(result.text).toContain("セッションを切り替えました");
    expect(binds).toMatchObject([
      {
        conversation: {
          accountId: "default",
          channel: "telegram",
          conversationId: "5089072082",
        },
        placement: "current",
        targetKind: "session",
        targetSessionKey: "agent:router-agent:telegram:direct:target",
      },
    ]);
  });
});
