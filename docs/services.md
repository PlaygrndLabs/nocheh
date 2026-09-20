<deployment>

# Nocheh services

[ADR-0048](adr/0048-containerized-management.md) defines the container migration.
Docker administration access is explicitly owner-authorized.
[TASK.md](../TASK.md) records implementation and activation evidence.

<layout>

One Compose project contains 17 continuously running containers when Honcho is
enabled, or 18 with pgweb. In the original-only layout, database initialization
runs inside `nocheh-postgres` before it reports healthy. The legacy layout retains
its application startup initialization.
Temporary isolated agent containers are additional.

| Service | Tool and purpose | Location / expected state |
| --- | --- | --- |
| `nocheh-dashboard` | Owner dashboard, configuration, monitoring and recovery | Docker / running |
| `nocheh-executor` | Inngest executor workflows and independent receipt recovery | Docker / running |
| `nocheh-app` | API, source capture, durable event publisher and ordinary Inngest handlers | Docker / running |
| `nocheh-postgres` | Separate Nocheh and Inngest databases and roles | Docker / running |
| `nocheh-security` | Security broker, guard and exact authorization checks | Docker / running |
| `hermes-runtime` | Managed Hermes runtime and native dashboard | Docker / running |
| `hermes-agent-launcher` | Launch isolated agents; only agent infrastructure container mounting the Docker socket | Docker / running |
| `chatgpt-speech` | Subscription transcription; read-only shared login | Docker / running |
| `cliproxy-api` | Shared model provider; sole OAuth refresh authority | Docker / running |
| `cliproxy-monitor` | CPA Manager Plus full request history and analytics | Docker / running |
| `inngest-server` | Workflow scheduling, retries, waits and inspection UI | Docker / running |
| `inngest-redis` | Durable workflow queue and run state | Docker / running |
| `honcho-api` | Memory API | Docker / running when enabled |
| `honcho-deriver` | Honcho's internal background processing | Docker / running when enabled |
| `honcho-postgres` | Memory, vectors and derivation jobs | Docker / running when enabled |
| `honcho-redis` | Memory cache | Docker / running when enabled |
| `honcho-provider-gateway` | Controlled model access and embedding spending records | Docker / running when enabled |
| `pgweb-archive` | Read-only database viewer | Docker / optional-stopped |
| `honcho-cli` | One-shot memory inspection | Docker / optional-stopped |

`./scripts/nocheh status` and Monitoring show each service's tool, purpose,
location, observed state and expected state. The Honcho metrics probe establishes
process availability; memory backlog and receipt observations establish progress.
API, capture and Inngest connectivity are separate observations.

</layout>

<relationships>

```mermaid
flowchart TB
    Owner[Owner] --> Dashboard
    Telegram[Telegram] --> Hermes
    subgraph Docker["Local Docker Compose · 17 services"]
        Dashboard["nocheh-dashboard :8783"]
        Executor["nocheh-executor<br/>imports · approved tools · receipt recovery"]
        App["nocheh-app<br/>API · capture · publisher · workflow handlers"]
        PG["nocheh-postgres<br/>separate Nocheh and Inngest databases"]
        Engine[inngest-server]
        Queue[inngest-redis]
        Hermes["hermes-runtime<br/>managed runtime and native dashboard"]
        Launcher[hermes-agent-launcher]
        Security["nocheh-security<br/>broker and guard"]
        Speech[chatgpt-speech]
        Provider["cliproxy-api<br/>shared provider and sole login refresh"]
        Monitor[cliproxy-monitor]
        Memory[honcho-api]
        Deriver[honcho-deriver]
        MemoryDB[honcho-postgres]
        Cache[honcho-redis]
        Gateway["honcho-provider-gateway<br/>controlled model access and spending ledger"]
    end
    Dashboard --> App
    Dashboard --> Hermes
    Dashboard --> Monitor
    Dashboard -.->|maintenance| DockerAPI[Local Docker engine]
    Executor -.->|approved tool sandboxes| DockerAPI
    Executor <-->|authenticated Connect via app| App
    Hermes -->|capture| App
    App --> PG
    App <--> Engine
    Engine --> PG
    Engine --> Queue
    App -->|prepared work| Hermes
    Hermes --> Launcher
    Launcher --> Agents[Temporary isolated Docker agents]
    Agents --> Security
    Security --> App
    Security --> Provider
    Hermes --> Speech
    Speech -->|read only| Login[Shared OAuth file]
    Provider -->|sole writer| Login
    Provider --> Subscription[ChatGPT subscription]
    Speech --> Subscription
    App --> Memory
    Memory --> MemoryDB
    Deriver --> MemoryDB
    Memory --> Cache
    Deriver --> Gateway
    Memory --> Gateway
    Gateway --> Provider
    Gateway --> Embeddings[Dedicated capped embeddings provider]
    Monitor --> Provider
```

Ordinary functions share one application and concurrency four. Executor functions use
concurrency two. The application gives API/capture and workflow handlers separate
PostgreSQL pools, each capped at eight. SDK reconnection does not gate API startup.
Inngest Redis uses AOF, `appendfsync always` and `noeviction`.

Startup in the original-only layout: PostgreSQL and store provisioning →
application healthy → Inngest (also waits for Redis). Initialization preserves
existing data. Inngest retains its restricted database role and cannot connect to
the archive. See [ADR-0054](adr/0054-postgres-owned-store-bootstrap.md). The
legacy layout follows [ADR-0049](adr/0049-application-database-bootstrap.md).

</relationships>

<workflow>

Telegram → capture and save → durable event publication → Inngest → prepare files,
transcripts and guarded copies → Hermes reasoning → security and exact approvals →
deliver and save receipt → sync authorized Honcho memory.

Preparation is a prerequisite. Workflow events carry opaque references and approved
metadata; originals, transcripts, arguments and credentials remain protected.
Telegram reception, synchronous security, Hermes reasoning and Honcho's internal
PostgreSQL derivation queue stay with their respective tools.

</workflow>

<dashboards>

- Owner dashboard: <http://localhost:8783/>. Start with `./scripts/nocheh dashboard`.
  It is independent of application and Inngest availability; it requires Docker.
- Hermes: <http://localhost:8783/hermes/nocheh>, through the owner session and the
  existing managed administration server. No separate frontend container or stock
  gateway/scheduler startup runs. Presentation preferences live in
  `data/local/admin/dashboard/home/`, separately from runtime profiles.
- Inngest inspection: <http://localhost:8783/inngest/runs>.
- Provider monitoring: <http://localhost:8783/providers/management.html>.
- Optional pgweb: <http://localhost:8782/>, after `./scripts/nocheh db`.

React, React DOM, Three.js, GraphQL, pg, TypeScript and esbuild are libraries or
build tools, not additional production services. The management image contains Node 24.x, Python, and pinned Docker CLI tools.
It mounts installation paths at the same absolute locations for maintenance and
approved tool bind mounts. Docker-socket access for these two trusted services is explicitly owner-authorized.

</dashboards>
</deployment>
