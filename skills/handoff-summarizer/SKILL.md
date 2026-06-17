---
name: handoff-summarizer
description: Create compact OpenClaw orchestration payloads for router-agent broadcast, targeted follow-up, progressive updates, and final synthesis.
---

# Handoff Summarizer

Create broadcast and follow-up payloads in this shape:

```json
{
  "orchestration_id": "...",
  "source_channel": "telegram|slack|cli|web",
  "source_thread_id": "...",
  "user_id": "...",
  "original_message": "...",
  "latest_user_comment": null,
  "normalized_intent": "...",
  "broadcast_agents": [
    "work-cisco",
    "azabu-corporate",
    "personal",
    "coding",
    "foxcale-advisor",
    "foxcale-coding",
    "learning-kb"
  ],
  "selected_agents": [],
  "routing_reason": "broadcast self-selection",
  "sensitivity": "low|medium|high",
  "context_summary": "...",
  "known_subagent_results": [],
  "attachments": [],
  "requested_action": "answer|draft|execute|schedule|search|other",
  "response_contract": "CLAIM|CLAIM_PARTIAL|NO_CLAIM plus STREAM_UPDATE|FINAL_RESULT|BLOCKED"
}
```

For a targeted follow-up, include:

```json
{
  "orchestration_id": "...",
  "target_agent": "...",
  "follow_up_reason": "conflict|incomplete|user_comment|assumption_check|blocked",
  "prior_result_summary": "...",
  "latest_user_comment": "...",
  "question": "..."
}
```

Keep summaries short and factual. Do not include secrets. Include only
attachment metadata unless a target agent needs the attachment content.

When user comments arrive before final synthesis, preserve the original message
and add the comment as `latest_user_comment`. Do not rewrite history as if the
comment had been present from the start; mark earlier subagent results as
superseded when needed.
