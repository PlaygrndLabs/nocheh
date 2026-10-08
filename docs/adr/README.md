# Architecture decisions

Current setup: [0075 — Clean development setup](0075-clean-development-setup.md).
Physical Telegram delivery boundary: [0089](0089-physical-telegram-delivery-boundary.md).
Durable Telegram rate-limit recovery: [0090](0090-durable-telegram-rate-limit-retries.md).
Exact topic action destinations: [0092](0092-exact-topic-action-destinations.md).
Atomic memory approval follow-ups: [0093](0093-atomic-memory-approval-followups.md).
Current memory authority at delivery: [0094](0094-current-memory-authority-at-delivery.md).
Unstarted memory handoff recovery: [0095](0095-recover-unstarted-memory-handoffs.md).
Concurrent memory decision receipts: [0096](0096-serialize-memory-decision-replays.md).
Durable native review handoff: [0097](0097-durable-native-review-handoff.md).
Isolated native lease recovery: [0098](0098-isolated-native-lease-recovery.md).
Historical recall eligibility: [0099](0099-independent-evidence-for-historical-recall.md).
Honcho service default: [0076](0076-honcho-enabled-local-default.md).
Exhausted-pilot acceptance budget: [0077](0077-exhausted-pilot-honcho-acceptance-budget.md).
Owner Honcho budget control: [0078](0078-owner-honcho-budget-control.md).
Separated Honcho budgets and settlement: [0079](0079-separated-honcho-budgets-and-settlement.md).
Durable embedding outage cooldown: [0100](0100-durable-embedding-egress-cooldown.md).
Honcho terminal-error readiness: [0101](0101-honcho-terminal-queue-errors-block-readiness.md).
Background admission handoff: [0087](0087-live-background-admission-handoff.md),
superseding the retry-order hints in [0085](0085-fair-background-workflow-admission.md).
Primary ingestion before new native notes:
[0088](0088-primary-ingestion-before-native-note-review.md).
Reply admission and Honcho derivation: [0080](0080-reply-admission-and-honcho-derivation.md).
Contextual learning deduplication: [0082](0082-evidence-based-learning-deduplication.md).
Scoped reaction discovery: [0084](0084-scoped-reaction-discovery.md), extended with
guarded evidence in [0086](0086-reaction-discovery-evidence.md).
Automatic publication during replies: [0083](0083-defer-automatic-memory-publication-during-replies.md).
Bounded workflow backup verification: [0081](0081-bounded-workflow-backup-fingerprints.md).

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
| Product and runtime ownership | [0018](0018-hermes-owned-archive-subscription-rebuild.md), [0027](0027-native-hermes-dashboard-integration.md), [0039](0039-main-refactor-consolidation.md), [0040](0040-specifications-and-agent-workflow.md), [0071](0071-local-only-acceptance-evidence.md) | Nocheh owns source data, memory, policy, and its product surface. Hermes is the first replaceable runtime. Integration into `main`, release acceptance, and activation are separate concerns. Live acceptance output stays outside Git. |
| Local installation and recovery | [0019](0019-local-compose-development-and-acceptance.md), [0023](0023-consistent-backups-and-inactive-restore.md), [0024](0024-single-environment-configuration.md), [0032](0032-isolated-upgrades-and-portable-memory.md), [0036](0036-one-compose-project.md), [0045](0045-honcho-in-installation-compose.md), [0048](0048-containerized-management.md), [0054](0054-postgres-owned-store-bootstrap.md), [0055](0055-concise-core-service-names.md), [0064](0064-isolated-source-watched-development-preview.md), [0065](0065-single-stack-source-mounted-development.md), [0066](0066-fixed-name-standard-port-development.md), [0067](0067-exact-revision-app-rollout.md), [0073](0073-live-data-source-watched-development.md), [0074](0074-root-development-compose-layout.md), [0081](0081-bounded-workflow-backup-fingerprints.md) | Local Compose is the acceptance target. Configuration has one editable source, upgrades are isolated, backups restore inactive credentials, and the installation preserves owned data across replaceable services. One running development stack serves source edits against the operating data and bot without image rebuilds. Existing VPS checkouts can receive exact-revision app rollouts. |
| Guarding, security, and controlled effects | [0020](0020-mandatory-outgoing-request-guard.md), [0021](0021-scoped-native-assistant-processes.md), [0028](0028-isolated-native-browser-turns.md), [0098](0098-isolated-native-lease-recovery.md), [0029](0029-controlled-tool-execution.md), [0033](0033-guarded-projections-and-honcho-memory.md), [0037](0037-external-security-plugin-service.md), [0062](0062-owner-managed-telegram-group-participants.md), [0089](0089-physical-telegram-delivery-boundary.md), [0090](0090-durable-telegram-rate-limit-retries.md), [0092](0092-exact-topic-action-destinations.md) | Guarded projections are durable and editable. Every physical model attempt is checked at the outbound boundary. Agent processes remain scoped; broader effects use exact approvals, isolated execution, and revocable permissions. Selected Telegram groups allow only the owner by default, with explicit participant decisions. |
| Providers and observed health | [0034](0034-explicit-embedding-environment.md), [0035](0035-shared-cliproxy-provider-and-monitoring.md), [0038](0038-observed-telegram-health-and-local-oauth-callback.md), [0068](0068-detached-honcho-acceptance-workspace.md), [0077](0077-exhausted-pilot-honcho-acceptance-budget.md), [0078](0078-owner-honcho-budget-control.md), [0079](0079-separated-honcho-budgets-and-settlement.md), [0100](0100-durable-embedding-egress-cooldown.md), [0102](0102-separate-embedding-error-holds-from-spending.md), [0103](0103-relay-every-provider-oauth-login.md) | Reasoning uses a separate subscription request bound; embeddings use a durable dollar cap with confirmed usage settlement and a durable admission cooldown after provider failure. HTTP error holds are excluded from cap spending while uncertain transport holds remain counted. An exhausted pilot can enter its monthly window for detached live acceptance; the accepted owner can then adjust that cap and see usage. Polling, OAuth ownership, recovery, and provider health are observed explicitly; every redirect provider login has its own temporary host callback. |
| Memory and audience access | [0030](0030-configurable-space-memory.md), [0033](0033-guarded-projections-and-honcho-memory.md), [0044](0044-automatic-honcho-context.md), [0056](0056-connected-entity-memory.md), [0057](0057-memory-relationship-access-map.md), [0072](0072-validated-honcho-context-renewal.md), [0076](0076-honcho-enabled-local-default.md), [0080](0080-reply-admission-and-honcho-derivation.md), [0093](0093-atomic-memory-approval-followups.md), [0094](0094-current-memory-authority-at-delivery.md), [0095](0095-recover-unstarted-memory-handoffs.md), [0101](0101-honcho-terminal-queue-errors-block-readiness.md) | Honcho is primary long-term memory and its service is enabled for fresh local setups; live acceptance still gates attachment. Nocheh owns evidence, policy, and rebuildability. Recall is entity-aware and audience-scoped; terminal derivation errors cannot make new memory ready. |
| Workflows and schedules | [0031](0031-native-managed-schedules.md), [0041](0041-local-inngest-workflows.md), [0042](0042-host-workflow-archive-coordination.md), [0043](0043-owner-workflow-inspection.md), [0046](0046-consolidated-inngest-installation.md), [0047](0047-receipted-event-handoff.md), [0049](0049-application-database-bootstrap.md), [0080](0080-reply-admission-and-honcho-derivation.md), [0104](0104-telegram-update-order-and-untransmitted-sends.md), [0105](0105-shared-background-engine-queue.md) | Local Inngest owns product workflow execution. Nocheh retains durable event identity, receipts, checkpoints, inspection, and independent host recovery. Conversation turns start in Telegram update order, and a send never transmitted is retried. Background memory work waits in one shared engine queue instead of polling. |
| Owned source and derived storage | [0051](0051-platform-independent-sources.md), [0053](0053-original-only-archive.md), [0054](0054-postgres-owned-store-bootstrap.md) | The archive contains platform-independent original source data only. Guarded and generated material lives in derived storage; authority and operational control live in a separate control store. |
| Agent-led organization and supervision | [0091](0091-bounded-agent-knowledge-organization.md) | Explicit owner delegation permits project creation and exact conversation assignments. Durable proposals apply after turns and learning complete, with revision checks and receipts. One Decisions inbox and conversation context expose organization, knowledge access, and external-action authority separately. |
| Owner interface and source layout | [0025](0025-owner-dashboard-and-management-cli.md), [0026](0026-three-dimensional-evidence-view.md), [0050](0050-dashboard-components-and-workflow-metrics.md), [0058](0058-semantic-react-flow-memory-map-editing.md), [0059](0059-elk-layered-memory-map-layout.md), [0060](0060-context-entity-evidence-graph.md), [0063](0063-owner-database-browser.md), [0069](0069-role-based-source-layout.md), [0070](0070-single-agent-support-root.md) | The dashboard and CLI expose owner operations and evidence. The 3D graph is limited to users, projects, groups, and messages and stays separate from the editable React Flow Memory map. `bin/nocheh` is the owner launcher, `tools/` holds tooling, `services/` holds Hermes and Honcho, `dashboard/` holds the owner UI, and `.agent/` holds agent support. |

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
