# ADRs

Decision history, oldest first. Accepted ADRs are not rewritten — a later ADR
supersedes an earlier one. **ADR-0018 is the active rebuild direction and supersedes
conflicting decisions and sequencing below; ADR-0019 makes local Compose the current
deployment target. Older status entries describe their
status before the rebuild.**

| ADR | Decision | Recorded relationship (historical for 0001–0017) |
| --- | --- | --- |
| [0001](0001-phase-1-core-processing.md) | Clean architecture, Telegram -> redaction -> tasks -> Notion MCP | Yes |
| [0002](0002-phase-1-5-validation-observability.md) | Per-step audit records, task validation, metrics port | Yes |
| [0003](0003-phase-2-structured-memory.md) | 6 structured memory record types + local retrieval | Yes, extended by 0008 |
| [0004](0004-live-buffering-history-import-ai-context.md) | Live buffering, history import, bounded AI context | Yes |
| [0005](0005-sqlite-vps-persistence.md) | SQLite as the only runtime store, encrypted payload columns | Yes |
| [0006](0006-setup-dashboard.md) | React dashboard at `/app` for setup, simulation, inspection | Yes |
| [0007](0007-personal-ai-brain-roadmap.md) | Product direction: personal AI brain, not a task bot | Direction only; sequencing lives in `TASK.md` |
| [0008](0008-memory-graph-architecture.md) | Memory graph nodes/edges, expanded payloads, suggestions | Yes |
| [0009](0009-bootstrap-and-env-source-of-truth.md) | Bind-mounted `.env` as one config source of truth, scripted VPS bootstrap | Yes, extends 0005 |
| [0010](0010-multimodal-ingestion-model-roles-secret-guard.md) | Image/voice ingestion, per-content-type model roles, model-backed secret guard | Yes |
| [0011](0011-embedding-backed-recall.md) | Embedding role, hybrid vector + word-overlap recall, vectors in SQLite | Yes, extends 0003 |
| [0012](0012-wiring-recall-into-analysis.md) | Recall grounds analysis: context built post-guard, graph seeded from recalled memory | Yes, extends 0011 and 0004 |
| [0013](0013-importer-core-message-log-projections.md) | Importer core: one guarded append-only message log, replayable projections with cursors | Yes, replaces the buffer from 0004 |
| [0014](0014-postgres-plaintext-at-rest-owner-column.md) | Postgres + pgvector, plaintext `jsonb` payloads, encryption kept only for credentials, `owner_id` everywhere | Yes, supersedes 0005 on engine and encryption |
| [0015](0015-not-adopting-honcho-as-memory-layer.md) | Honcho rejected as the memory layer on evidence; own recall and own consolidation; spike gated by a named test | Current safe default; evaluation timing amended by 0017 |
| [0016](0016-answer-path-outbound-delivery-approval-rule.md) | Reply contract, single audited egress, scheduler, rule 3 amended to bounded autonomous sending | Yes, amends rule 3 |
| [0017](0017-memory-backend-evidence-gate.md) | Choose owned, Honcho-primary, or hybrid memory from an early frozen bake-off; the guarded log remains owned in every outcome | Yes, amends 0015 sequencing |
| [0018](0018-hermes-owned-archive-subscription-rebuild.md) | Hermes rebuild, owned originals, optional guard, subscription production, isolated Honcho trial | Active direction |
| [0019](0019-local-compose-development-and-acceptance.md) | Local Compose for development, automation and acceptance; VPS deferred | Active deployment target |
| [0020](0020-mandatory-outgoing-request-guard.md) | Mandatory per-attempt guard at pinned HTTPX boundary, explicit trust and unsupported-transport rejection | Active guard implementation |
| [0021](0021-scoped-native-assistant-processes.md) | Native per-profile assistant processes, scoped capabilities and owner-DM approval | Implemented; live Telegram acceptance pending |
| [0022](0022-isolated-metered-honcho-experiment.md) | Synthetic Honcho comparison, separate subscription bridge and persistent $5 embedding budget | Optional experiment; live evaluation pending |
| [0023](0023-consistent-backups-and-inactive-restore.md) | Quiesced snapshots, verified restore and inactive recovered credentials | Local rehearsal verified; cutover remains gated |
| [0024](0024-single-environment-configuration.md) | One editable `.env`, native OAuth state and inactive environment restores | Active configuration |
| [0025](0025-owner-dashboard-and-management-cli.md) | Native dashboard extension, shared owner operations and configuration ownership | Implementation in phases |
| [0026](0026-three-dimensional-evidence-view.md) | Local 3D evidence space with accessible source inspection | Active dashboard presentation |
| [0027](0027-native-hermes-dashboard-integration.md) | Nocheh product ownership and replaceable Hermes runtime, native dashboard and controlled operations | Active direction; see TASK.md |
| [0028](0028-isolated-native-browser-turns.md) | Captured native browser turns, scoped sessions and one refresh authority | Implemented |
| [0029](0029-controlled-tool-execution.md) | Exact approvals, isolated execution and bounded revocable permissions | Implemented |
| [0030](0030-configurable-space-memory.md) | Owner-wide native recall, manual import review and versioned group/topic sharing | Current memory direction; see space-memory-plan.md for gates |
| [0031](0031-native-managed-schedules.md) | One supervised native scheduler and durable captured fires | Implemented |
| [0032](0032-isolated-upgrades-and-portable-memory.md) | Isolated candidate checks, complete restore holds and portable native memory | Tooling implemented; live release gates remain separate |
| [0033](0033-guarded-projections-and-honcho-memory.md) | Durable editable guarding and Honcho primary memory | Implemented; live Honcho activation pending |
| [0034](0034-explicit-embedding-environment.md) | Explicit dedicated OpenAI embedding provider, model and capped key | Configured; live embedding acceptance pending |
| [0035](0035-shared-cliproxy-provider-and-monitoring.md) | One CLIProxyAPI login for Hermes and Honcho, with CPA Manager Plus monitoring | Active implementation plan |
| [0036](0036-one-compose-project.md) | All local containers in one Compose project while the owner server stays host-managed | Active local packaging |
