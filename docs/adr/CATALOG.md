# ADR catalog

Current setup: [0075 — Clean development setup](0075-clean-development-setup.md).
Honcho service default: [0076](0076-honcho-enabled-local-default.md).
Exhausted-pilot acceptance budget: [0077](0077-exhausted-pilot-honcho-acceptance-budget.md).
Owner Honcho budget control: [0078](0078-owner-honcho-budget-control.md).

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
| [0056](0056-connected-entity-memory.md) | Stable people and project peers with attributed entity evidence | Current connected-memory direction; 0091 permits bounded delegation for discovered project creation, preserving identity review |
| [0057](0057-memory-relationship-access-map.md) | Human relationship map with fact-level conversation access | Current access model; relationships never grant access |
| [0058](0058-semantic-react-flow-memory-map-editing.md) | React Flow Memory map with semantic revision-checked editing | Current Memory map interaction model |
| [0059](0059-elk-layered-memory-map-layout.md) | ELK layered positioning for the Memory map | Current Memory map layout |
| [0060](0060-context-entity-evidence-graph.md) | Limit the 3D evidence graph to users, projects, groups, and messages | Supersedes ADR-0026's broad node taxonomy and unchanged-export clause |
| [0061](0061-retire-isolated-honcho-comparison.md) | Retire optional Honcho comparison; keep production support and legacy data identities | Current Honcho repository boundary; supersedes 0045 experiment retention |
| [0062](0062-owner-managed-telegram-group-participants.md) | Owner-only group replies by default with per-group participant grants and denies | Extends 0021 group scope and 0024 configuration; separate from memory sharing |
| [0063](0063-owner-database-browser.md) | Read-only inspection of configured installation tables | Extends 0025 owner inspection and 0053 separate stores |
| [0064](0064-isolated-source-watched-development-preview.md) | Checkout-scoped Compose Watch full core stack | Extends 0019 local development and 0024 configuration |
| [0065](0065-single-stack-source-mounted-development.md) | One running stack with source-mounted development | Supersedes 0064 concurrent-project and rebuild-on-edit behavior |
| [0066](0066-fixed-name-standard-port-development.md) | Development uses one named stack and normal ports | Supersedes 0065 development name, ports, and builder details |
| [0067](0067-exact-revision-app-rollout.md) | Exact-revision app rollout for local and VPS Compose installations | Extends 0019 with deployment tooling; local acceptance remains separate |
| [0068](0068-detached-honcho-acceptance-workspace.md) | Time-bound guarded synthetic workspace for preattachment Honcho checks | Extends 0033 and 0034 without authorizing attachment |
| [0069](0069-role-based-source-layout.md) | Role-based tooling, services, dashboard, and one owner launcher | Extends 0025 and 0067 on code ownership and launcher placement |
| [0070](0070-single-agent-support-root.md) | One `.agent/` directory for project agent support | Extends 0069 on agent skill and support placement |
| [0071](0071-local-only-acceptance-evidence.md) | Track source and synthetic fixtures; keep runtime output and live evidence local | Extends 0040 on evidence retention and privacy |
| [0072](0072-validated-honcho-context-renewal.md) | Revalidate unchanged Honcho context without repeated representation calls | Supersedes 0044's unconditional representation refresh; retains five-minute freshness |
| [0073](0073-live-data-source-watched-development.md) | Source-watched development reuses the operating Compose project, bot, data, and provider login | Supersedes 0066's separate project, state, and credential boundary |
| [0074](0074-root-development-compose-layout.md) | Root development override and acceptance test overlay in their role-based locations | Refines 0073 on file placement; retires the isolated preview entrypoint |
| [0075](0075-clean-development-setup.md) | Clean development reset with Compose-owned stores and one source-watched stack | Refines 0073 and 0074; release acceptance remains separate |
| [0076](0076-honcho-enabled-local-default.md) | Enable and prepare Honcho for fresh local installations | Extends 0033 and 0045; live acceptance still gates attachment |
| [0077](0077-exhausted-pilot-honcho-acceptance-budget.md) | Permit monthly spending after exhausted pilot to finish detached live acceptance | Extends 0034 and 0068; preserves attachment gate |
| [0078](0078-owner-honcho-budget-control.md) | Let the owner adjust the accepted monthly embedding cap and inspect usage | Extends 0034 and 0077; preserves pilot and attachment gates |
| [0079](0079-separated-honcho-budgets-and-settlement.md) | Separate embedding dollars from subscription requests and settle reported embedding usage | Supersedes permanent per-request reservations in 0034; extends 0078 |
| [0080](0080-reply-admission-and-honcho-derivation.md) | Reserve reply admission and use two Honcho deriver workers | Extends 0041 and 0076 without changing memory readiness or provider limits |
| [0081](0081-bounded-workflow-backup-fingerprints.md) | Bound workflow verification storage with versioned row hashes | Extends 0023 and 0041; preserves existing snapshot compatibility |
| [0082](0082-evidence-based-learning-deduplication.md) | Deduplicate learning with original convention evidence and owner revisions | Extends 0053 and 0056; generated rule wording is not new evidence |
| [0083](0083-defer-automatic-memory-publication-during-replies.md) | Defer automatic learned publication while an admitted reply is active | Extends 0080 and 0082; owner and privacy revocations remain immediate |
| [0084](0084-scoped-reaction-discovery.md) | Discover bounded current reaction sources within the caller’s audience | Extends 0051 and 0053; handles never grant access and observations remain incomplete |
| [0085](0085-fair-background-workflow-admission.md) | Preserve bounded background retry order without occupying reply capacity | Extends 0080; Inngest remains the execution and retry authority |
| [0086](0086-reaction-discovery-evidence.md) | Include guarded reaction observations and bounded target excerpts in discovery | Extends 0084; a separate model-selected read is no longer required to inspect the observation |
| [0087](0087-live-background-admission-handoff.md) | Hand a free background slot to one bounded live callback | Supersedes 0085 retry-order hints; retains 0080 operation and foreground-capacity limits |
| [0088](0088-primary-ingestion-before-native-note-review.md) | Give primary-memory writes a first attempt before starting new native note reviews | Extends 0080 and 0087; running and uncertain reviews keep their receipt-reconciliation paths |
| [0089](0089-physical-telegram-delivery-boundary.md) | Bind every physical Telegram request to its authorized audience and current authority | Extends 0029 and 0030; native fallback cannot widen a topic and partial delivery keeps its receipts |
| [0090](0090-durable-telegram-rate-limit-retries.md) | Preserve rejected rate-limit attempts while permitting bounded native recovery | Extends 0018 and 0089; confirmed and uncertain sends retain their no-resend boundary |
| [0091](0091-bounded-agent-knowledge-organization.md) | Typed knowledge proposals, bounded organization authority, deferred application, and one owner decision inbox | Extends 0041, 0053, 0057, and 0083; narrowly supersedes 0056 on confirmation of delegated discovered project creation |
| [0092](0092-exact-topic-action-destinations.md) | Bind approved Telegram destinations to their concrete chat and topic | Extends 0029 and 0089; retains numeric destinations and existing immutable approvals |
| [0093](0093-atomic-memory-approval-followups.md) | Commit memory grants, exact follow-ups and outbox work atomically | Extends 0041 and 0057; exact command replay repairs a current older handoff without repeating delivery |
| [0094](0094-current-memory-authority-at-delivery.md) | Recheck the exact memory grant and fact at physical delivery | Extends 0089 and 0093; stale authority stops new sends while confirmed receipts remain reconcilable |
| [0095](0095-recover-unstarted-memory-handoffs.md) | Recover an unstarted withheld memory action on exact owner replay | Extends 0093 and 0094; current authority and atomic policy checks exclude automatic retries and prior effects |
| [0096](0096-serialize-memory-decision-replays.md) | Serialize memory decision replays and preserve expiration | Extends 0057 and 0093; preserves existing receipt identities |
| [0097](0097-durable-native-review-handoff.md) | Release workflow admission while a bounded native review runs | Extends 0087 and 0088; durable launch and completion receipts preserve the original effect identity |
| [0098](0098-isolated-native-lease-recovery.md) | Reclaim abandoned native admission leases under the profile file lock | Extends 0028 and 0097; retains native transcript fencing and effect receipts |
| [0099](0099-independent-evidence-for-historical-recall.md) | Require independent source evidence for foreground historical recall | Extends 0044 and 0056; background learning retains the current source |
| [0100](0100-durable-embedding-egress-cooldown.md) | Bound paid embedding admissions after provider failure | Extends 0079; preserves failed holds and separate subscription reasoning |
| [0101](0101-honcho-terminal-queue-errors-block-readiness.md) | Reject processed-with-error Honcho work as ready memory | Extends 0044 and 0100; keeps failure details inside the workspace boundary |
| [0102](0102-separate-embedding-error-holds-from-spending.md) | Separate embedding error holds from cap spending | Supersedes 0079 failed-call hold and 0100 historical-hold consequence; retains pre-egress reservation and cooldown |
| [0103](0103-relay-every-provider-oauth-login.md) | Relay every provider OAuth login | Extends 0038 from Codex to all redirect providers; reasoning stays on the ChatGPT login |
| [0104](0104-telegram-update-order-and-untransmitted-sends.md) | Start turns in Telegram update order and retry untransmitted sends | Extends 0047 and 0089; transmitted requests remain uncertain and approved actions are unchanged |
| [0105](0105-shared-background-engine-queue.md) | Queue background workflow steps in one shared Inngest concurrency key | Extends 0080 and 0087; existing Inngest rows remain until an approved retention policy |
| [0106](0106-configurable-workflow-history-retention.md) | Configurable Inngest telemetry retention, off by default | Extends 0046 and 0105; receipts, registry and queue state are never expired |
| [0107](0107-daily-workflow-history-retention.md) | Run workflow telemetry retention daily | Supersedes the hourly interval in 0106 |
| [0108](0108-first-derivative-selection-does-not-revoke.md) | A first derivative selection does not revoke authorized contexts | Extends the first-representation guard exemption; replacements keep the barrier |
| [0110](0110-default-workflow-history-retention.md) | Inngest telemetry retention on by default with 14 days | Supersedes the off default in 0106; installations that set a value keep it |
| [0109](0109-standard-honcho-entity-model.md) | Use Honcho through its documented entity model (proposed) | Would supersede per-generation workspaces in 0033, 0044, 0056 and timer refresh in 0072; retains 0030 audience isolation |
