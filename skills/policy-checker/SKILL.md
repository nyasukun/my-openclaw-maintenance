---
name: policy-checker
description: Enforce agent workspace, vault, customer, corporate, personal, and high-sensitivity routing boundaries before handoff.
---

# Policy Checker

Before handoff, check these boundaries:

- Router-agent may use only common or router policy context.
- Router-agent must not read purpose-agent vault secrets directly.
- foxcale customer information stays in the foxcale workspace and vault.
- Cisco work and Azabu corporate work must not be mixed.
- Personal content must not be mixed with business or customer work.
- High-sensitivity content requires a clear target domain or a confirmation question.

If a request crosses boundaries, split it into separate handoffs or ask the user
which domain should own the work.
