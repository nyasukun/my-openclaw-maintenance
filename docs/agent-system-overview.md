# Agent System Overview

The whole-system view of the deployed OpenClaw concern-lane setup on this host:
channel ingress, the orchestrator, the operator's five concern lanes, the
per-agent sandboxes, and the per-vault authorization boundary.

This is now the **single** active design. The lanes are the operator's real
concerns ("関心事"):

| Concern | Agent(s) | GitHub token |
| --- | --- | --- |
| ★1 Azabu corporate ops + `azabu.io` site maintenance | `azabu-corporate` | **token A** (`GITHUB_TOKEN`, `openclaw-azabu-corporate`) |
| ★2 foxcale customer work | `foxcale-advisor` (advisory), `foxcale-coding` (repo) | **token B** (`GITHUB_PAT_F_PROJECT`, `openclaw-foxcale-coding`) |
| Cisco partner-SE | `work-cisco` | none (no Azabu element) |
| self-study | `learning-kb` | none |
| personal | `personal` | none |

Plus the artifact lane `telegram-fable`, the orchestrator `router-agent`, and the
system agents `main`/`hard`/`long`/`heartbeat`.

- Whole-of-host view (operate/maintain planes, container lifecycle): [`host-topology.md`](host-topology.md)
- Routing/contracts: [`config/openclaw-concern-lanes/README.md`](../config/openclaw-concern-lanes/README.md)
- Routing policy (keywords, broadcast, slash commands): [`routing-policy.json`](../config/openclaw-concern-lanes/routing-policy.json)
- Authorization model: [`agent-authz-vault-model.md`](agent-authz-vault-model.md)
- Source of truth: [`vault-access-map.json`](../config/openclaw-concern-lanes/vault-access-map.json)

## Orchestration & routing

`router-agent` is the only user-facing agent. It understands the request, routes
to exactly one concern lane (or broadcasts and self-selects), streams partial
results back, and synthesizes a final `統合回答`. Leaf concern agents may only
delegate back to `router-agent` (`subagents.allowAgents: ["router-agent"]`) and
deny `sessions_send`, so they cannot form delegation loops. `tools.agentToAgent`
is disabled globally.

```mermaid
flowchart TD
    tg([Telegram]) --> R
    sl([Slack]) --> R

    subgraph host["OpenClaw gateway host"]
        R["router-agent<br/>orchestrator (gpt-5.5)<br/>route / broadcast / synthesize<br/>no domain credentials"]

        subgraph lanes["Concern lanes (router delegates to exactly one)"]
            AZ["azabu-corporate ★1<br/>corp + azabu.io<br/>GitHub token A"]
            FA["foxcale-advisor ★2<br/>advisory · no code"]
            FC["foxcale-coding ★2<br/>repo work<br/>GitHub token B"]
            WC["work-cisco<br/>partner-SE · no Azabu"]
            LK["learning-kb<br/>self-study"]
            PE["personal<br/>life admin"]
            TF["telegram-fable<br/>artifact builder"]
        end

        subgraph sys["System agents (not user-routed)"]
            MN[main]
            HD[hard]
            LG[long]
            HB[heartbeat]
        end
    end

    R -->|sessions_spawn| AZ
    R -->|sessions_spawn| FA
    R -->|sessions_spawn| FC
    R -->|sessions_spawn| WC
    R -->|sessions_spawn| LK
    R -->|sessions_spawn| PE
    R -->|sessions_spawn| TF
    AZ -.->|MISROUTE / result| R
    FC -.->|MISROUTE / result| R
    TF -.->|preview URL| R
    R ==>|統合回答| tg

    classDef priv fill:#fde2e2,stroke:#c0392b;
    classDef safe fill:#e2f0d9,stroke:#27ae60;
    classDef dim fill:#eeeeee,stroke:#999999,color:#666666;
    class AZ,FC priv;
    class FA,WC,LK,PE,TF safe;
    class MN,HD,LG,HB dim;
```

The router keeps `exec`/`process` in its allowlist on purpose: OpenClaw applies
the requester's tool restrictions to spawned children, so the coding lanes need
those tools present on the router to retain shell access. The router holds **no**
domain credentials (empty `_common` secret mount), which bounds the blast radius.

## Authorization: per-agent sandbox ← per 1Password vault

Each agent's sandbox mounts **only its own** runtime-secret snapshot, materialized
from **only the vaults that agent is authorized for**
(`materialize-runtime-secrets.js`). Authorization is enforced at the host boundary
(mount + materializer), not by prompt text.

The two customer GitHub tokens are the critical case: ★1 (Azabu) and ★2 (foxcale)
live in **disjoint vaults** and never mix. `azabu-corporate` mounts only its own
snapshot (token A); `foxcale-coding` mounts only its own (token B). `work-cisco`
is authorized for neither and holds no GitHub token, so Cisco work carries no
Azabu element.

```mermaid
flowchart LR
    subgraph op["1Password vaults"]
        POD[("openclaw-pod<br/>common")]
        VRT[("openclaw-router")]
        VAZ[("openclaw-azabu-corporate<br/>token A")]
        VFC[("openclaw-foxcale-coding<br/>token B")]
        VWC[("openclaw-work-cisco")]
    end

    MAT["materialize-runtime-secrets.js<br/>resolves each agent's authorized vaults<br/>→ runtime-secrets/&lt;agent&gt;/local.json"]

    POD --> MAT
    VRT --> MAT
    VAZ --> MAT
    VFC --> MAT
    VWC --> MAT

    MAT -->|"_common (no secrets)"| Rb["router-agent sandbox"]
    MAT -->|"azabu-corporate (GITHUB_TOKEN = A)"| AZb["azabu-corporate sandbox"]
    MAT -->|"foxcale-coding (GITHUB_PAT_F_PROJECT = B)"| FCb["foxcale-coding sandbox"]
    MAT -->|"_common (no secrets)"| WCb["work-cisco sandbox"]

    classDef vault fill:#e8eaf6,stroke:#3f51b5;
    classDef priv fill:#fde2e2,stroke:#c0392b;
    classDef safe fill:#e2f0d9,stroke:#27ae60;
    class POD,VRT,VAZ,VFC,VWC vault;
    class AZb,FCb priv;
    class Rb,WCb safe;
```

`foxcale-coding` uses `foxcale-github-auth.sh` as its sandbox setup command so
`GITHUB_PAT_F_PROJECT` becomes the effective git/`gh` token. Its fallback to a
generic `GITHUB_TOKEN` is harmless because the foxcale snapshot only ever contains
token B — the isolation is enforced by the mount, not by the script. The router,
advisory, Cisco, learning, and personal lanes mount the empty `_common` snapshot.

The credential-isolation invariants are locked by
[`tests/vault-access-map.test.mjs`](../tests/vault-access-map.test.mjs); the
routing/contract invariants by
[`tests/concern-lanes-config.test.mjs`](../tests/concern-lanes-config.test.mjs)
and [`tests/routing-policy.test.mjs`](../tests/routing-policy.test.mjs). See the
rationale and sources in [`agent-authz-vault-model.md`](agent-authz-vault-model.md).
