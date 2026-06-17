import { describe, expect, it } from "vitest";
import {
  formatAgentList,
  formatAgentRunResult,
  handleAgentCommand,
  listPurposeAgents,
  normalizeAgentId,
  parseAgentCommand,
  resolveReplyTarget,
  resolveTargetSessionKey,
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
});
