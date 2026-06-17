# Agent Command

Registers `/agent` for OpenClaw chat channels.

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
