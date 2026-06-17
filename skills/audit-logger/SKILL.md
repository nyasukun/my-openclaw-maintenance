---
name: audit-logger
description: Log router-agent orchestration decisions, broadcast targets, subagent responses, user interruptions, progressive updates, and final synthesis metadata as JSONL without copying secret values or unnecessary private content.
---

# Audit Logger

For router-agent, append orchestration events to
`routing/routing-decisions.jsonl` in the router workspace when filesystem tools
are available.

Log only metadata needed to audit coordination:

- timestamp
- orchestration id
- source channel and thread id
- user id when available
- event type: `broadcast_started`, `subagent_claimed`, `subagent_declined`,
  `progressive_update_sent`, `follow_up_sent`, `user_comment_attached`,
  `final_synthesis_sent`, or `late_update_sent`
- broadcast agents
- responding agents
- selected or claimed agents
- routing or orchestration reason
- sensitivity
- requested action
- whether final synthesis has been sent

Do not log secret values. For high-sensitivity messages, summarize content
instead of copying the full message unless the user explicitly asks for an audit
record containing it.

When the user comments before final synthesis, log that the comment was attached
to the active orchestration and which agent, if any, received the follow-up. Do
not log the full comment if it contains secrets or private account details.
