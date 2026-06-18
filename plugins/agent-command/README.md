# Agent Command

Registers `/agent` and `/session` for OpenClaw chat channels.

- `/agent` or `/agent list` lists the purpose agents configured under
  `router-agent.subagents.allowAgents`.
- `/agent <agent-id> <request>` validates the target agent, immediately
  acknowledges the handoff, and runs the request directly in that agent's
  channel-scoped session. The selected agent's final answer is delivered back
  to the same channel target.

OpenClaw already owns `/agents` for thread-bound session agents, so this plugin
uses `/agent` for purpose-agent discovery and explicit routing.

The command intentionally does not replace OpenClaw's session or model
selection state for the current chat. It creates or resumes the selected
purpose agent's channel-scoped session for that request.

## `/session`

- `/session` or `/session list` lists recent sessions for the current agent.
- `/session list 20` shows up to 20 recent sessions.
- `/session use <number>` binds the current channel conversation to the listed
  session. The next user message enters that session.
- `/session <number>` is shorthand for `/session use <number>`.
- `/session current` shows the active session key and any current binding.
- `/session clear` removes the current channel conversation binding and returns
  the chat to normal routing.

The command uses OpenClaw's runtime session-binding service, so it is scoped to
the current channel/account/conversation tuple. For Telegram topics, the topic
thread id is included in the conversation id.
