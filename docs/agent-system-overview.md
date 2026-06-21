# Agent System Overview

The whole-system view of the deployed OpenClaw concern-lane setup on this host:
channel ingress, the orchestrator, the concern lanes, the per-agent sandboxes,
and the per-vault authorization boundary.

- Routing/contracts: [`config/openclaw-concern-lanes/README.md`](../config/openclaw-concern-lanes/README.md)
- Authorization model: [`agent-authz-vault-model.md`](agent-authz-vault-model.md)
- Source of truth: [`vault-access-map.json`](../config/openclaw-concern-lanes/vault-access-map.json)

## Orchestration & routing

```mermaid
flowchart TD
    tg([Telegram]) --> R
    sl([Slack]) --> R

    subgraph host["OpenClaw gateway host"]
        R["router-agent<br/>orchestrator (gpt-5.5)<br/>broadcast / synthesize<br/>no domain credentials"]

        subgraph lanes["Concern lanes (router delegates to exactly one)"]
            SR["security-research<br/>read · write · web<br/>no exec"]
            PP["presales-proposal<br/>read · write · apply_patch<br/>no exec"]
            IO["infra-ops<br/>full exec · bridge net<br/>pre-authorized PR workflow"]
            TF["telegram-fable<br/>artifact builder<br/>sandbox exec"]
        end

        subgraph sys["System agents (not user-routed)"]
            MN[main]
            HD[hard]
            LG[long]
            HB[heartbeat]
        end

        retired["retired-kept purpose agents<br/>work-cisco · azabu-corporate · personal<br/>coding · foxcale-advisor · foxcale-coding · learning-kb<br/>(defined, not delegated to)"]
    end

    R -->|sessions_spawn| SR
    R -->|sessions_spawn| PP
    R -->|sessions_spawn| IO
    R -->|sessions_spawn| TF
    SR -.->|MISROUTE / result| R
    PP -.->|MISROUTE / result| R
    IO -.->|MISROUTE / result| R
    TF -.->|preview URL| R
    R ==>|統合回答| tg

    classDef priv fill:#fde2e2,stroke:#c0392b;
    classDef safe fill:#e2f0d9,stroke:#27ae60;
    classDef dim fill:#eeeeee,stroke:#999999,color:#666666;
    class IO priv;
    class SR,PP,TF safe;
    class retired,MN,HD,LG,HB dim;
```

Leaf lanes deny `sessions_send`/`sessions_spawn` so they cannot form delegation
loops; only `router-agent` orchestrates. `tools.agentToAgent` is disabled
globally.

## Authorization: per-agent sandbox ← per 1Password vault

Each agent's sandbox mounts **only its own** runtime-secret snapshot, materialized
from **only the vaults that agent is authorized for**. Authorization is enforced
at the host boundary (mount + materializer), not by prompt text.

```mermaid
flowchart LR
    subgraph op["1Password vaults"]
        POD[("openclaw-pod<br/>common")]
        VRT[("openclaw-router")]
        VIO[("openclaw-infra-ops")]
        VSR[("openclaw-security-research")]
        VPP[("openclaw-presales-proposal")]
        VTF[("openclaw-telegram-fable")]
    end

    MAT["materialize-runtime-secrets.js<br/>resolves each agent's authorized vaults<br/>→ runtime-secrets/&lt;agent&gt;/local.json"]

    POD --> MAT
    VRT --> MAT
    VIO --> MAT
    VSR --> MAT
    VPP --> MAT
    VTF --> MAT

    MAT -->|"_common (no secrets)"| Rb["router-agent sandbox"]
    MAT -->|"infra-ops (GITHUB_TOKEN)"| IOb["infra-ops sandbox"]
    MAT -->|"_common (no secrets)"| SRb["security-research sandbox"]
    MAT -->|"_common (no secrets)"| PPb["presales-proposal sandbox"]
    MAT -->|"telegram-fable (no secrets yet)"| TFb["telegram-fable sandbox"]

    classDef vault fill:#e8eaf6,stroke:#3f51b5;
    classDef priv fill:#fde2e2,stroke:#c0392b;
    classDef safe fill:#e2f0d9,stroke:#27ae60;
    class POD,VRT,VIO,VSR,VPP,VTF vault;
    class IOb priv;
    class Rb,SRb,PPb,TFb safe;
```

Before hardening, a single aggregate snapshot was mounted into **every** sandbox,
so the GitHub credentials reached every lane. Now `infra-ops` is the only lane
holding a GitHub token; `router-agent` and the non-coding lanes mount the empty
`_common` snapshot. See the rationale and sources in
[`agent-authz-vault-model.md`](agent-authz-vault-model.md).
