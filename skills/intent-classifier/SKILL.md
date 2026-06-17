---
name: intent-classifier
description: Normalize inbound user requests into intent, action, sensitivity, and domain labels before router-agent delegates work.
---

# Intent Classifier

Convert the inbound message into a normalized intent.

Classify requested action as one of:
`answer`, `draft`, `execute`, `schedule`, `search`, or `other`.

Classify sensitivity as:

- `low`: public or generic learning content
- `medium`: personal, operational, or internal business context
- `high`: credentials, contracts, invoices, customer details, security findings, or foxcale customer context

Prefer explicit domain signals over channel names. If the message is vague, mark
it ambiguous and request clarification.
