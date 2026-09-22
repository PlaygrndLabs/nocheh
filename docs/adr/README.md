# Architecture decisions

[SPECS.md](../../SPECS.md) is the authoritative product definition;
[AGENTS.md](../../AGENTS.md) defines agent workflow; and [TASK.md](../../TASK.md)
records implementation, evidence, and activation state. ADRs explain why decisions
were made. They do not replace any of those sources.

Read this summary first. Open an individual ADR when its rationale, rejected
alternatives, or exact boundary matters. The [complete catalog](CATALOG.md) retains
the chronological index of every ADR.

Accepted ADR files are historical records and remain unchanged. A later accepted
ADR supersedes only the conflicting parts of an earlier decision. Status wording
inside an ADR or the catalog describes history; current progress belongs in
`TASK.md`.

## Current decision map

| Area | Current decisions | Resulting direction |
| --- | --- | --- |
| Product and runtime ownership | [0018](0018-hermes-owned-archive-subscription-rebuild.md), [0027](0027-native-hermes-dashboard-integration.md), [0039](0039-main-refactor-consolidation.md), [0040](0040-specifications-and-agent-workflow.md) | Nocheh owns source data, memory, policy, and its product surface. Hermes is the first replaceable runtime. Integration into `main`, release acceptance, and activation are separate concerns. |
| Local installation and recovery | [0019](0019-local-compose-development-and-acceptance.md), [0023](0023-consistent-backups-and-inactive-restore.md), [0024](0024-single-environment-configuration.md), [0032](0032-isolated-upgrades-and-portable-memory.md), [0036](0036-one-compose-project.md), [0045](0045-honcho-in-installation-compose.md), [0048](0048-containerized-management.md), [0054](0054-postgres-owned-store-bootstrap.md), [0055](0055-concise-core-service-names.md) | Local Compose is the acceptance target. Configuration has one editable source, upgrades are isolated, backups restore inactive credentials, and the installation preserves owned data across replaceable services. |
| Guarding, security, and controlled effects | [0020](0020-mandatory-outgoing-request-guard.md), [0021](0021-scoped-native-assistant-processes.md), [0028](0028-isolated-native-browser-turns.md), [0029](0029-controlled-tool-execution.md), [0033](0033-guarded-projections-and-honcho-memory.md), [0037](0037-external-security-plugin-service.md) | Guarded projections are durable and editable. Every physical model attempt is checked at the outbound boundary. Agent processes remain scoped; broader effects use exact approvals, isolated execution, and revocable permissions. |
| Providers and observed health | [0034](0034-explicit-embedding-environment.md), [0035](0035-shared-cliproxy-provider-and-monitoring.md), [0038](0038-observed-telegram-health-and-local-oauth-callback.md) | Reasoning uses the shared subscription provider, embeddings use an explicit capped provider, and polling, OAuth ownership, recovery, and provider health are observed explicitly. |
| Memory and audience access | [0030](0030-configurable-space-memory.md), [0033](0033-guarded-projections-and-honcho-memory.md), [0044](0044-automatic-honcho-context.md), [0056](0056-connected-entity-memory.md), [0057](0057-memory-relationship-access-map.md) | Honcho is primary long-term memory, while Nocheh owns evidence, policy, and rebuildability. Recall is entity-aware and audience-scoped; relationships and project membership never grant access. |
| Workflows and schedules | [0031](0031-native-managed-schedules.md), [0041](0041-local-inngest-workflows.md), [0042](0042-host-workflow-archive-coordination.md), [0043](0043-owner-workflow-inspection.md), [0046](0046-consolidated-inngest-installation.md), [0047](0047-receipted-event-handoff.md), [0049](0049-application-database-bootstrap.md) | Local Inngest owns product workflow execution. Nocheh retains durable event identity, receipts, checkpoints, inspection, and independent host recovery. |
| Owned source and derived storage | [0051](0051-platform-independent-sources.md), [0053](0053-original-only-archive.md), [0054](0054-postgres-owned-store-bootstrap.md) | The archive contains platform-independent original source data only. Guarded and generated material lives in derived storage; authority and operational control live in a separate control store. |
| Owner interface | [0025](0025-owner-dashboard-and-management-cli.md), [0026](0026-three-dimensional-evidence-view.md), [0050](0050-dashboard-components-and-workflow-metrics.md), [0058](0058-semantic-react-flow-memory-map-editing.md), [0059](0059-elk-layered-memory-map-layout.md), [0060](0060-context-entity-evidence-graph.md) | The dashboard and CLI expose owner operations and evidence. The 3D graph is limited to users, projects, groups, and messages and stays separate from the editable React Flow Memory map, whose changes are semantic, reviewed commands rather than diagram mutations. |

## Historical eras

### Foundation: ADR-0001 through ADR-0017

The first architecture established a Telegram processing pipeline, audit records,
structured local memory, buffering and import, SQLite persistence, a setup
dashboard, and a personal-AI-brain direction. It then added graph memory,
multimodal preparation, embedding-backed recall, a guarded append-only message
log, PostgreSQL, outbound delivery rules, and an evidence gate for choosing a
memory backend.

Treat this era as rationale, not as a description of the current system. Its main
replacement chains are:

- [0004](0004-live-buffering-history-import-ai-context.md) buffering was replaced
  by the guarded append-only log in [0013](0013-importer-core-message-log-projections.md),
  then by the owned-source rebuild beginning with [0018](0018-hermes-owned-archive-subscription-rebuild.md).
- [0005](0005-sqlite-vps-persistence.md) SQLite and encrypted payload columns were
  superseded by PostgreSQL in [0014](0014-postgres-plaintext-at-rest-owner-column.md)
  and later by the three-store boundary in [0053](0053-original-only-archive.md).
- [0015](0015-not-adopting-honcho-as-memory-layer.md) and
  [0017](0017-memory-backend-evidence-gate.md) record the earlier Honcho rejection
  and bake-off. [0033](0033-guarded-projections-and-honcho-memory.md) is the accepted
  current choice of Honcho as primary memory under Nocheh-owned evidence and policy.
- The early product direction in [0007](0007-personal-ai-brain-roadmap.md) survives,
  but its roadmap sequencing does not. `TASK.md` owns sequencing and activation.

### Rebuild and product ownership: ADR-0018 through ADR-0040

[0018](0018-hermes-owned-archive-subscription-rebuild.md) reset the implementation
baseline around Hermes, owned originals, subscription reasoning, and an isolated
Honcho trial. This era established local Compose, scoped native assistants,
controlled execution, configurable space privacy, native schedules, portable
recovery, durable guarded projections, provider and security boundaries, and
Nocheh's ownership of the dashboard and product surface.

[0040](0040-specifications-and-agent-workflow.md) closed the era by making
`SPECS.md` the consolidated product definition and separating durable
requirements, historical decisions, working instructions, and implementation
evidence.

### Current expansion: ADR-0041 onward

The current era moves product workflows to local Inngest, makes automatic Honcho
context part of normal turns, consolidates installation services, and strengthens
durable handoff and owner inspection. It also introduces platform-independent
source identities, the original-only archive boundary, connected entity memory,
fact-level audience access, the interactive Memory map, and a context-entity-only
3D evidence graph.

Within this era, [0053](0053-original-only-archive.md) supersedes
[0052](0052-pure-source-archive.md) on guarded-data placement: the archive holds
originals only, not guarded copies.

## How to add or interpret an ADR

- Use `SPECS.md` to determine the intended product and `TASK.md` to determine what
  is implemented or active.
- Add an ADR only for a durable architectural choice whose rationale or rejected
  alternatives will matter later. Do not use ADRs as progress logs.
- State exactly which earlier decision is extended or superseded. Do not mark an
  entire ADR obsolete when only one boundary changed.
- Add the new ADR to the current decision map and to the
  [complete catalog](CATALOG.md). Move an older decision into the appropriate
  historical summary when it is no longer current.
- Preserve accepted ADR files unchanged. Correct the current specification,
  summary, catalog relationship, or a new superseding ADR instead.
