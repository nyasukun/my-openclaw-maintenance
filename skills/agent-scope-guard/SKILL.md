---
name: agent-scope-guard
description: Hard rule for every purpose-agent turn. In broadcast tasks from router-agent, self-select with CLAIM, CLAIM_PARTIAL, or NO_CLAIM before doing domain work. If clearly outside this agent's domain, return NO_CLAIM quickly without web/search/repo/domain tools. If in scope, produce useful work promptly and accept targeted router-agent follow-up in the same orchestration. Do not answer out-of-domain requests just because you can.
---

# Agent Scope Guard

Use this skill in purpose-specific agents, not in `router-agent`.

Purpose agents may receive both explicit handoffs and broadcast self-selection
tasks. In both modes, keep the domain boundary strict.

## Broadcast Self-Selection

When the task says it is a broadcast from `router-agent`, begin your reply with
one of these statuses:

```text
CLAIM
agent: <this agent id>
confidence: high|medium|low
reason: <one sentence>
result_or_next_step: <short summary>
```

```text
CLAIM_PARTIAL
agent: <this agent id>
confidence: high|medium|low
reason: <what part is in scope and what part is not>
result_or_next_step: <short summary>
```

```text
NO_CLAIM
agent: <this agent id>
confidence: high|medium|low
reason: <one sentence>
result_or_next_step: none
```

Use `NO_CLAIM` when the request is clearly outside your domain. For `NO_CLAIM`,
do not call web search, retrieval, repository, shell, domain APIs, or other
tools first. Return quickly so router-agent can continue without waiting for
you.

Use `CLAIM` when the task belongs to your domain. Start useful work promptly.
If the task is long, include the earliest useful result or next action in the
same reply so router-agent can stream progress to the user.

Use `CLAIM_PARTIAL` when you own only part of the request. Complete the in-scope
part and identify the boundary. Do not send work directly to another purpose
agent; router-agent owns coordination.

## Work Updates

After the claim line, use these labels when useful:

```text
STREAM_UPDATE
<brief progress, evidence, or intermediate answer router-agent may show the user>
```

```text
FINAL_RESULT
<your completed in-scope result>
```

```text
BLOCKED
<what is missing, what you tried, and the exact input needed>
```

Router-agent may use your `STREAM_UPDATE`, `FINAL_RESULT`, or `BLOCKED` text in
progressive user-visible updates. Keep it concise, factual, and free of raw
secrets.

## Follow-Up From Router-Agent

Router-agent may ask you a targeted follow-up within the same orchestration.
Treat that as continuation context, not as a new unrelated task.

- Apply user comments forwarded by router-agent.
- Correct or supersede your earlier result when the user or another agent found
  a problem.
- Answer only the follow-up when the scope is narrow.
- If the follow-up is outside your domain, return `NO_CLAIM` or `BLOCKED`
  rather than improvising.

If the user commented before final synthesis and the comment names this agent,
incorporate it explicitly in your next result.

## Explicit Handoffs And Misroutes

For non-broadcast direct handoffs, begin from the assumption that router-agent
probably selected you correctly. Start the user's task immediately when any
meaningful part fits your domain.

Do not answer out-of-domain requests merely because you know a short answer. A
direct final answer to a clear out-of-scope request is incorrect. For example,
`personal` must not answer Cisco/Disti business prompts, `work-cisco` must not
handle personal reservations, `coding` must not take over personal life admin,
and `learning-kb` must not execute business or repo tasks.

For a clear mismatch in direct handoff mode, hand back to `router-agent` with a
short `MISROUTE` result. Do not call web search, retrieval, or domain-specific
tools before returning the misroute.

```text
MISROUTE
source_agent: <this agent id>
guessed_correct_agent: <agent id or unclear>
wrong_owner_reason: <one sentence>
original_message: <user request>
minimal_context: <only what matters>
```

Do not continue the wrong-domain task after returning `MISROUTE`.

## Domain Boundary

While working, keep a lightweight scope check active:

- If the request is in scope, continue normally.
- If the request is partly in scope, complete the in-scope part and clearly
  identify the boundary.
- If the request is clearly outside this agent's domain, stop before using
  unrelated context or tools.

Do not send work directly to another purpose agent. Router-agent owns
coordination, user-visible streaming, final synthesis, and audit logging.
