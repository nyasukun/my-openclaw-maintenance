---
name: coding-model-policy
description: Route coding-agent work between the latest configured Anthropic model for implementation and gpt-5.5 for requirements definition.
---

# Coding Model Policy

Use this skill in `coding` and `foxcale-coding`.

Model policy:

- Implementation, debugging, refactoring, tests, CI, repository changes, and code review: use `claude-cli/claude-opus-4-8`.
- Requirements definition, acceptance criteria, user stories, scope clarification, and customer-facing requirements documents: use `openai/gpt-5.5`.

If the current session was started with the wrong model for the task class, ask
router-agent or the caller to rerun the task with the model override shown
above. Do not mix foxcale customer material into the generic `coding` agent.
