# ADR catalog

This is the complete chronological index. Start with the
[current decision map and historical summary](README.md) unless you need to audit
an individual decision or supersession chain.

Statuses are historical notes, not implementation claims. [TASK.md](../../TASK.md)
records current implementation and activation.

| ADR | Decision | Recorded relationship / supersession |
| --- | --- | --- |
| [0001](0001-phase-1-core-processing.md) | Clean architecture, Telegram -> redaction -> tasks -> Notion MCP | Historical foundation |
| [0002](0002-phase-1-5-validation-observability.md) | Per-step audit records, task validation, metrics port | Historical foundation |
| [0003](0003-phase-2-structured-memory.md) | Six structured memory record types and local retrieval | Extended by 0008; historical implementation |
| [0004](0004-live-buffering-history-import-ai-context.md) | Live buffering, history import, bounded AI context | Buffer replaced by 0013; later rebuilt from 0018 |
| [0005](0005-sqlite-vps-persistence.md) | SQLite as the only runtime store, encrypted payload columns | Superseded by 0014 on engine and encryption; later storage boundary in 0053 |
| [0006](0006-setup-dashboard.md) | React dashboard at `/app` for setup, simulation, inspection | Historical UI foundation |
| [0007](0007-personal-ai-brain-roadmap.md) | Product direction: personal AI brain, not a task bot | Product direction retained; sequencing lives in `TASK.md` |
| [0008](0008-memory-graph-architecture.md) | Memory graph nodes and edges, expanded payloads, suggestions | Historical memory design |
| [0009](0009-bootstrap-and-env-source-of-truth.md) | Bind-mounted `.env` as one configuration source and scripted VPS bootstrap | Extended 0005; deployment target later changed by 0019 |
| [0010](0010-multimodal-ingestion-model-roles-secret-guard.md) | Image and voice ingestion, content-specific model roles, model-backed secret guard | Historical preparation and guarding design |
| [0011](0011-embedding-backed-recall.md) | Embedding role, hybrid recall, vectors in SQLite | Historical recall design; storage superseded |
| [0012](0012-wiring-recall-into-analysis.md) | Recalled memory grounds analysis | Historical recall integration |
| [0013](0013-importer-core-message-log-projections.md) | Guarded append-only message log with replayable projections | Replaced 0004 buffer; later rebuilt from 0018 |
| [0014](0014-postgres-plaintext-at-rest-owner-column.md) | PostgreSQL and pgvector, plaintext payloads, owner identifiers | Superseded 0005 on engine and encryption; storage boundary refined by 0053 |
| [0015](0015-not-adopting-honcho-as-memory-layer.md) | Reject Honcho as the memory layer pending evidence | Superseded by 0018 and 0033 |
| [0016](0016-answer-path-outbound-delivery-approval-rule.md) | Reply contract, audited egress, scheduler, bounded autonomous sending | Historical delivery foundation |
| [0017](0017-memory-backend-evidence-gate.md) | Freeze and compare owned, Honcho-primary, and hybrid memory | Amended 0015 sequencing; resolved by 0033 |
| [0018](0018-hermes-owned-archive-subscription-rebuild.md) | Hermes rebuild, owned originals, optional guard, subscription production, isolated Honcho trial | Rebuild baseline; later ADRs supersede specific policies |
| [0019](0019-local-compose-development-and-acceptance.md) | Local Compose for development, automation, and acceptance | Active deployment target |
| [0020](0020-mandatory-outgoing-request-guard.md) | Mandatory per-attempt guard at the pinned HTTPX boundary | Active guard boundary |
| [0021](0021-scoped-native-assistant-processes.md) | Per-profile native assistants with scoped capabilities and owner-DM approval | Current process isolation foundation |
| [0022](0022-isolated-metered-honcho-experiment.md) | Synthetic Honcho comparison and persistent embedding budget | Historical optional experiment; memory choice resolved by 0033 |
| [0023](0023-consistent-backups-and-inactive-restore.md) | Quiesced snapshots, verified restore, inactive recovered credentials | Current recovery foundation |
| [0024](0024-single-environment-configuration.md) | One editable `.env`, native OAuth state, inactive environment restores | Active configuration boundary |
| [0025](0025-owner-dashboard-and-management-cli.md) | Native dashboard extension and shared owner operations | Current owner-interface foundation |
| [0026](0026-three-dimensional-evidence-view.md) | Local 3D evidence space with accessible source inspection | Current Evidence view; separate from Memory map |
| [0027](0027-native-hermes-dashboard-integration.md) | Nocheh owns the product; Hermes is replaceable | Active product direction |
| [0028](0028-isolated-native-browser-turns.md) | Captured native browser turns with scoped sessions | Active turn isolation |
| [0029](0029-controlled-tool-execution.md) | Exact approvals, isolated execution, bounded revocable permissions | Active controlled-execution boundary |
| [0030](0030-configurable-space-memory.md) | Owner-wide recall and versioned group or topic sharing | Current audience-memory direction |
| [0031](0031-native-managed-schedules.md) | One supervised native scheduler and durable captured fires | Current scheduling foundation; workflow execution later consolidated in Inngest |
| [0032](0032-isolated-upgrades-and-portable-memory.md) | Isolated candidate checks, complete restore holds, portable native memory | Active upgrade and portability boundary |
| [0033](0033-guarded-projections-and-honcho-memory.md) | Durable editable guarding and Honcho primary memory | Current guarding and memory baseline |
| [0034](0034-explicit-embedding-environment.md) | Explicit dedicated embedding provider, model, and capped key | Extends 0033 |
| [0035](0035-shared-cliproxy-provider-and-monitoring.md) | One CLIProxyAPI login for Hermes and Honcho with monitoring | Active provider direction |
| [0036](0036-one-compose-project.md) | All local containers in one Compose project | Active local packaging |
| [0037](0037-external-security-plugin-service.md) | Configurable external security service and bounded autonomy | Active security-service boundary |
| [0038](0038-observed-telegram-health-and-local-oauth-callback.md) | Observed Telegram polling, recovery supervision, local OAuth callback | Active health and OAuth direction |
| [0039](0039-main-refactor-consolidation.md) | Integrate refactor into main separately from release acceptance | Supersedes earlier merge sequencing |
| [0040](0040-specifications-and-agent-workflow.md) | Canonical specification, agent workflow, and separate status evidence | Active documentation and integration workflow |
| [0041](0041-local-inngest-workflows.md) | Local Inngest product workflows with owned outbox and receipts | Current workflow baseline |
| [0042](0042-host-workflow-archive-coordination.md) | Host Connect through the archive listener with protected checkpoints | Implements 0041 |
| [0043](0043-owner-workflow-inspection.md) | Owner workflow controls and authenticated inspection-only history | Implements 0041 |
| [0044](0044-automatic-honcho-context.md) | Automatic primary Honcho context with protected generation cache | Current memory-context direction |
| [0045](0045-honcho-in-installation-compose.md) | Production Honcho in the installation Compose project | Current installation direction |
| [0046](0046-consolidated-inngest-installation.md) | Consolidated applications and Inngest-only workflow execution | Extends 0041 installation design |
| [0047](0047-receipted-event-handoff.md) | Retry one event identity until a fenced workflow records receipt | Durability implementation of 0041 |
| [0048](0048-containerized-management.md) | Dashboard and executor as separate Compose services | Current management packaging |
| [0049](0049-application-database-bootstrap.md) | Initialize Inngest storage during application startup | Current workflow bootstrap |
| [0050](0050-dashboard-components-and-workflow-metrics.md) | Shared dashboard components, adaptive themes, persisted workflow aggregates | Current dashboard system |
| [0051](0051-platform-independent-sources.md) | Platform-independent source identities, observations, and relationships | Current source model |
| [0052](0052-pure-source-archive.md) | Archive contains source data and guarded versions | Superseded by 0053 on guarded-data placement |
| [0053](0053-original-only-archive.md) | Original-only archive, derived guarded records, separate control database | Current storage boundary; supersedes 0052 guarded placement |
| [0054](0054-postgres-owned-store-bootstrap.md) | Provision separated owned stores in PostgreSQL startup | Implements 0053 packaging |
| [0055](0055-concise-core-service-names.md) | `hermes`, `hermes-agent-sb`, and `nocheh-db` service identities | Current service names |
| [0056](0056-connected-entity-memory.md) | Stable people and project peers with attributed entity evidence | Current connected-memory direction |
| [0057](0057-memory-relationship-access-map.md) | Human relationship map with fact-level conversation access | Current access model; relationships never grant access |
| [0058](0058-semantic-react-flow-memory-map-editing.md) | React Flow Memory map with semantic revision-checked editing | Current Memory map interaction model |
| [0059](0059-elk-layered-memory-map-layout.md) | ELK layered positioning for the Memory map | Current Memory map layout |
| [0060](0060-context-entity-evidence-graph.md) | Limit the 3D evidence graph to users, projects, groups, and messages | Supersedes ADR-0026's broad node taxonomy and unchanged-export clause |
| [0061](0061-retire-isolated-honcho-comparison.md) | Retire optional Honcho comparison; keep production support and legacy data identities | Current Honcho repository boundary; supersedes 0045 experiment retention |
