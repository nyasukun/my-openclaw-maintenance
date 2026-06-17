# OpenClaw Agent Project Architecture

This document records the purpose-separated OpenClaw agent layout for Telegram,
Slack, CLI, and web ingress.

## Existing Design Confirmed

- Agent config lives in `~/.openclaw/openclaw.json` under `agents.defaults` and `agents.list`.
- Workspace isolation is per agent through the `workspace` field. If omitted, OpenClaw derives a workspace from the state directory.
- Channel routing lives in top-level `bindings`. A route binding points a channel/account/peer match to one `agentId`.
- Slack and Telegram credentials are configured under `channels.slack` and `channels.telegram` through SecretRefs.
- Secret resolution uses `secrets.providers.onepassword` with an exec provider at `~/.openclaw/secrets/op-secret-provider.js`.
- Agent skill allowlists use `agents.list[].skills`. Existing managed skills live in `~/.openclaw/skills`; bundled skills live under the OpenClaw package.
- Model selection uses `agents.defaults.model` and `agents.list[].model` with provider/model refs such as `openai/gpt-5.5`.
- Handoff/delegation is already available through OpenClaw subagents/session tools. Router-agent is configured to orchestrate only the purpose-specific agents.

## Agents

| Agent | Role | Workspace | Default model |
| --- | --- | --- | --- |
| `router-agent` | External channel ingress, broadcast orchestration, progressive updates, final synthesis | `~/.openclaw/workspaces/router-agent` | `openai/gpt-5.5` |
| `work-cisco` | Cisco work, partner support, Disti, security proposals | `~/.openclaw/workspaces/work-cisco` | `openai/gpt-5.5` |
| `azabu-corporate` | Azabu Tech, Atlantis Circle, contracts, invoices, management | `~/.openclaw/workspaces/azabu-corporate` | `openai/gpt-5.5` |
| `personal` | Personal schedule, travel, shopping, life admin | `~/.openclaw/workspaces/personal` | `openai/gpt-5.5` |
| `coding` | Generic repository coding, implementation, debugging, tests, CI, PRs, and requirements definition | `~/.openclaw/workspaces/coding` | `claude-cli/claude-opus-4-8` |
| `foxcale-advisor` | foxcale technical advisory, requirements, architecture, meetings, risks, and recommendations | `~/.openclaw/workspaces/foxcale-advisor` | `openai/gpt-5.5` |
| `foxcale-coding` | foxcale customer coding and repository work with foxcale project skills | `~/.openclaw/workspaces/foxcale-coding` | `claude-cli/claude-opus-4-8` |
| `learning-kb` | Study notes, reading, certifications, knowledge base | `~/.openclaw/workspaces/learning-kb` | `openai/gpt-5.5` |

Existing agents `main`, `hard`, `long`, `heartbeat`, and `telegram-fable` are
kept. The Telegram direct binding that previously pointed at `telegram-fable`
is replaced by a channel-level `router-agent` binding.

## Vault Mapping

`openclaw-pod` is the common vault. It may hold shared provider credentials and
non-domain-specific OpenClaw secrets. Each purpose agent has a separate vault for
domain secrets:

| Agent | Agent vault | Common vault |
| --- | --- | --- |
| `router-agent` | `openclaw-router` | `openclaw-pod` |
| `work-cisco` | `openclaw-work-cisco` | `openclaw-pod` |
| `azabu-corporate` | `openclaw-azabu-corporate` | `openclaw-pod` |
| `personal` | `openclaw-personal` | `openclaw-pod` |
| `coding` | `openclaw-coding` | `openclaw-pod` |
| `foxcale-advisor` | `openclaw-foxcale-advisor` | `openclaw-pod` |
| `foxcale-coding` | `openclaw-foxcale-coding` | `openclaw-pod` |
| `learning-kb` | `openclaw-learning-kb` | `openclaw-pod` |

The current OpenClaw agent schema does not have an agent-level `vault` field.
The minimal extension is a vault-aware 1Password exec provider. It supports
namespaced SecretRef IDs:

- `common/<item>/<field>` reads `op://openclaw-pod/<item>/<field>`.
- `work-cisco/<item>/<field>` reads `op://openclaw-work-cisco/<item>/<field>`.
- `coding/<item>/<field>` reads `op://openclaw-coding/<item>/<field>`.
- `foxcale-advisor/<item>/<field>` reads `op://openclaw-foxcale-advisor/<item>/<field>`.
- `foxcale-coding/<item>/<field>` reads `op://openclaw-foxcale-coding/<item>/<field>`.
- Equivalent namespaces exist for the other agents.

Legacy IDs such as `openai/api_key` and `telegram/bot_token` remain supported so
existing credentials do not break during migration.

Legacy secret IDs are now resolved to the separated vaults rather than
`openclaw-prod`:

- Non-GitHub OpenClaw/provider items (`telegram`, `google`, `openclaw-gateway`,
  `ollama`, `slack`, `openai`, `1password`, `anthropic`) resolve from
  `openclaw-pod`.
- General GitHub credentials (`github/token` and `github-workspace-long/*`)
  resolve from `openclaw-azabu-corporate`.
- The f-project GitHub credential (`github/pat_f_project`) resolves from
  `openclaw-foxcale-coding`.
- `foxcale-coding` uses
  `config/openclaw-agent-project/foxcale-github-auth.sh` as its sandbox setup
  command so `GITHUB_PAT_F_PROJECT` becomes the effective `GITHUB_TOKEN`,
  `GH_TOKEN`, `git credential-store`, and `gh` token for that workspace. If the
  f-project token is missing, the script falls back to the general
  `GITHUB_TOKEN`.

## Channel Routing

Top-level route bindings send Telegram and Slack ingress to `router-agent`.
Router-agent then applies `config/openclaw-agent-project/routing-policy.json`.
Router-agent is the user-facing orchestrator: it uses `openai/gpt-5.5`, broadcasts
normal work to all configured purpose agents with `sessions_spawn`, streams
useful subagent results back to the user as they arrive, asks targeted follow-up
questions when results are incomplete or conflicting, and finishes with a
clearly labeled `統合回答`.

Router-agent does not wait for every subagent before helping the user. It
synthesizes when enough evidence exists or the policy deadline is reached. Late
subagent results after the integrated answer produce no user-visible reply
unless they contain a material correction or useful new detail.

Router-agent keeps `exec` and `process` in its allowed tool surface even though
it should not do repo work itself. OpenClaw stores the requester's effective
tool allowlist on spawned subagents, so coding targets need these tools present
on router-agent in order for delegated `coding` and `foxcale-coding` workers to
retain shell access after model fallback.

Purpose agents use `agent-scope-guard`. In broadcast mode they self-select with
`CLAIM`, `CLAIM_PARTIAL`, or `NO_CLAIM`. A clear `NO_CLAIM` must return quickly
without web/search/repo/domain tool use. Claimed agents return `STREAM_UPDATE`,
`FINAL_RESULT`, or `BLOCKED` content for router-agent to evaluate and stream.
For direct handoffs, purpose agents may still return compact `MISROUTE` hints;
router-agent treats those as evidence and does not show the raw block to the
user.

Domain hints used for follow-up targeting, clarification, and route-only
questions:

- Cisco, partner, Disti, Splunk, firewall, zero-trust, security proposal -> `work-cisco`
- Azabu Tech, Atlantis Circle, corporate, contract, invoice, management -> `azabu-corporate`
- Personal schedule, life, shopping, travel, family, personal notes -> `personal`
- Generic repository coding, implementation, debugging, tests, CI, PRs -> `coding`
- foxcale customer advisory, meetings, proposals, requirements, risks -> `foxcale-advisor`
- foxcale customer coding, implementation, bugs, tests, CI, repository work -> `foxcale-coding`
- Learning, reading, certifications, CISSP, study notes -> `learning-kb`
- Ambiguous route-only requests stay with `router-agent`, which asks a clarification question.

For high-sensitivity requests, router-agent must avoid exposing raw content in
logs and should ask before acting when the relevant domain or target subagent is
unclear.

Slash command routing:

- `/agent` and `/agent list` are owned by the local `agent-command` plugin and
  list the purpose agents in `router-agent.subagents.allowAgents`.
- `/agent <agent-id> <request>` validates `<agent-id>` and runs the stripped
  task on that selected agent. This explicit command is the single-agent
  exception to the default broadcast orchestration flow.
- Underscore aliases such as `foxcale_coding` are normalized to hyphenated
  agent IDs for Telegram-friendly typing.
- OpenClaw's built-in `/agents` command remains reserved for thread-bound
  session agents, so purpose-agent discovery uses `/agent`.

## Handoff Payload

Router-agent uses this payload shape when broadcasting or sending targeted
follow-up to purpose agents:

```json
{
  "orchestration_id": "...",
  "source_channel": "telegram|slack|cli|web",
  "source_thread_id": "...",
  "user_id": "...",
  "original_message": "...",
  "latest_user_comment": null,
  "normalized_intent": "...",
  "broadcast_agents": ["work-cisco", "azabu-corporate", "personal", "coding", "foxcale-advisor", "foxcale-coding", "learning-kb"],
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

Orchestration events are logged as JSONL in the router workspace at
`routing/routing-decisions.jsonl`.

## Enabled Skills

| Agent | Skills |
| --- | --- |
| `router-agent` | `channel-router`, `intent-classifier`, `policy-checker`, `handoff-summarizer`, `audit-logger` |
| `work-cisco` | `agent-scope-guard`, `security-presales`, `cisco-security`, `proposal-writing`, `meeting-summary`, `threat-analysis`, `splunk-spl-helper`, `firewall-policy-review`, `zero-trust-advisor` |
| `azabu-corporate` | `agent-scope-guard`, `corporate-admin`, `contract-review`, `invoice-support`, `proposal-writing`, `strategy-planning`, `customer-discovery`, `meeting-summary` |
| `personal` | `agent-scope-guard`, `personal-assistant`, `calendar-helper`, `travel-planner`, `shopping-helper`, `household-admin`, `note-organizer` |
| `coding` | `agent-scope-guard`, `coding-agent`, `coding-model-policy`, `github`, `gh-issues`, `spike`, `python-debugpy`, `node-inspect-debugger`, `requirements-analysis` |
| `foxcale-advisor` | `agent-scope-guard`, `project-management`, `customer-delivery`, `meeting-summary`, `proposal-writing`, `requirements-analysis`, `risk-log`, `decision-log`, `pm-tailoring` |
| `foxcale-coding` | `agent-scope-guard`, `coding-agent`, `coding-model-policy`, `github`, `gh-issues`, `spike`, `python-debugpy`, `node-inspect-debugger`, `project-management`, `customer-delivery`, `meeting-summary`, `requirements-analysis`, `risk-log`, `decision-log`, `pm-tailoring` |
| `learning-kb` | `agent-scope-guard`, `learning-kb`, `spaced-repetition`, `book-summary`, `concept-map`, `quiz-generator`, `note-linker` |

`openclaw skills search learning-kb --json` returned no installed or ClawHub
match, so a minimal local `learning-kb` skill was added.

## Model Selection

- Router-agent uses `openai/gpt-5.5`, with `openai/gpt-5.4-mini` fallback, because it is user-facing and responsible for evaluating, improving, and synthesizing subagent work.
- Work-cisco, azabu-corporate, foxcale-advisor, and learning-kb default to `openai/gpt-5.5`.
- Personal defaults to `openai/gpt-5.5` for instruction-following reliability around reservations and misroute boundaries, with `openai/gpt-5.4-mini` fallback.
- Coding and foxcale-coding default to `claude-cli/claude-opus-4-8`, the latest configured Anthropic model currently available in this OpenClaw install.
- Coding and foxcale-coding use `openai/gpt-5.5` for requirements definition. Because OpenClaw's agent schema has no native task-class model-routing field, this is recorded in `config/openclaw-agent-project/model-selection-policy.json`, exposed as per-agent model aliases (`coding`, `requirements`), and enforced through router handoff/model override policy.
- Domain agents use `openai/gpt-5.4-mini` as fallback where a cheaper or faster retry is acceptable.

## Operations

To add a new domain agent:

1. Add a workspace under `~/.openclaw/workspaces/<agent-id>`.
2. Add a vault in 1Password and a namespace in `config/openclaw-agent-project/vault-map.json`.
3. Add local skills under `skills/<skill-name>/SKILL.md` and install them globally.
4. Add the agent to `agents.list` with a dedicated workspace, model, and skill allowlist.
5. Add route rules to `config/openclaw-agent-project/routing-policy.json`.
6. Run `node --test tests/routing-policy.test.mjs` and `openclaw config validate`.

Manual 1Password work remains: create or populate the vaults listed above before
using namespaced SecretRefs for domain-specific credentials.

## Runtime Access Requests

All agents must avoid asking for secret values in chat. When a task needs access
to a private repo, API, cloud account, customer system, or any credential that is
not already visible in the sandbox, the agent asks for the secret location and
purpose instead:

- Vault name, such as `openclaw-pod` or the agent's domain vault
- 1Password item name
- field name inside the item
- env var name or tool-specific credential purpose needed in the sandbox
- whether the value is agent-scoped or common/shared

Operators add approved mappings to:

```text
/home/yasu/.openclaw/secrets/runtime-secret-requests.json
```

The tracked template is:

```text
config/openclaw-agent-project/runtime-secret-requests.json
```

Example shape:

```json
{
  "version": 1,
  "agents": {
    "work-cisco": {
      "env": {
        "CISCO_API_TOKEN": {
          "vault": "openclaw-work-cisco",
          "item": "cisco-api",
          "field": "token",
          "purpose": "Cisco API access"
        }
      }
    }
  }
}
```

The runtime writer validates each mapping against `vault-map.json`, resolves the
1Password values into `/home/yasu/.openclaw/runtime-secrets/local.json`, and
records only non-secret source metadata alongside the env names.

## Runtime Secret Mount

The Docker sandbox bootstrap reads runtime credentials from
`/run/openclaw-secrets/local.json` inside the container. The host-side source
must not live under `/run`; OpenClaw sandbox validation blocks host bind sources
under system runtime paths. The current host source is
`/home/yasu/.openclaw/runtime-secrets`, generated by
`~/.openclaw/secrets/write-runtime-local-json.js` during gateway startup and
mounted read-only as:

```text
/home/yasu/.openclaw/runtime-secrets:/run/openclaw-secrets:ro
```

Each sandbox runs `/workspace/.openclaw/bootstrap-runtime-secrets.sh` during
setup. That writes `/workspace/.openclaw/runtime-secret-env.sh`, and
`BASH_ENV` points there so every new shell re-reads the mounted JSON. After a
new Vault mapping is added, run:

```sh
openclaw secrets reload
openclaw sandbox recreate --all --force
```

Existing shell commands must redact checks, for example by reporting
`TOKEN=present` rather than printing values.
