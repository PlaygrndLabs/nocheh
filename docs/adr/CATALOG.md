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
| [0033](0033-guarded-projections-and-honcho-memory.md) | Durable editable guarding and Honcho primary memory | Current guarding and memory baseline; its per-generation Honcho workspaces are superseded by 0109 |
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
| [0044](0044-automatic-honcho-context.md) | Automatic primary Honcho context with protected generation cache | Automatic context remains; its generation cache is superseded by 0109 and 0115, and its timed refresh and five-minute limit by 0114 |
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
| [0056](0056-connected-entity-memory.md) | Stable people and project peers with attributed entity evidence | Current connected-memory direction; 0091 permits bounded delegation for discovered project creation, preserving identity review; 0109 replaces its per-audience workspaces with one installation workspace |
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
| [0072](0072-validated-honcho-context-renewal.md) | Revalidate unchanged Honcho context without repeated representation calls | Supersedes 0044's unconditional representation refresh; its timed renewal is superseded by 0114 and its snapshot by 0115 |
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
| [0109](0109-standard-honcho-entity-model.md) | Use Honcho through its documented entity model | Supersedes per-generation workspaces in 0033, 0044, 0056 and timer refresh in 0072; retains 0030 audience isolation |
| [0111](0111-complete-workflow-history-retention.md) | Inngest retention covers every run history table | Extends 0107 and 0110; supersedes 0106 on keeping events and run records |
| [0112](0112-spent-workflow-record-retention.md) | Expire spent workflow publication records and run links | Extends 0047 and 0111; the registry and effect receipts are never expired |
| [0113](0113-superseded-memory-summary-retention.md) | Remove superseded Honcho context summaries | Extends 0112; its served-summary exception is dropped by 0115, which keeps no context snapshot |
| [0114](0114-event-driven-honcho-context.md) | Rebuild Honcho context when Honcho finishes work, not on a timer | Supersedes the two-minute refresh and five-minute limit in 0044 and 0072; its snapshot table is replaced by 0115 |
| [0115](0115-honcho-session-revisions.md) | Versioned Honcho sessions with targeted rebuilds and live reply context | Implements 0109 steps H1–H4; replaces the context snapshot of 0044, 0072 and 0114 and the served-summary check of 0113 |
| [0120](0120-loops-outside-inngest.md) | Classify every Nocheh loop that runs outside Inngest | Extends 0041, 0042 and 0047; removes the superseded single-database worker |
| [0121](0121-operational-telemetry-retention.md) | Expire broker model-call events and guard invalidation notes | Extends 0111 and 0112; action and tool security events stay as the owner's audit |
| [0122](0122-honcho-fresh-start.md) | Honcho fresh start deletes earlier Nocheh workspaces | Implements 0109 step H5 on top of 0115; deletes only workspaces Nocheh recorded |
| [0123](0123-retired-sources-leave-native-history.md) | Retired sources leave stored Hermes native history | Extends 0021; rewrites the profile's native rows before its next turn, Hermes' workflow unchanged |
| [0124](0124-native-review-once-per-source.md) | Hermes native memory review runs once per source | Extends 0097 and 0088; later epochs review only unstarted sources and uncertain reviews have a bounded number of observations |
| [0125](0125-per-chat-telegram-dispatch-lanes.md) | Telegram turns run per chat, two chats at a time | Replaces the gateway's single dispatch lock; per-chat order and receipts unchanged; two-chat limit superseded by 0126 |
| [0126](0126-owner-set-parallel-replies-and-runs.md) | The owner sets parallel replies and parallel agent runs | Supersedes ADR-0125's fixed limit; settings default to three chats and four runs |
| [0127](0127-parallel-guard-checks.md) | Secret-guard checks run side by side | Replaces the Hermes detector lock and global preparation lock with an owner setting, three by default |
| [0128](0128-learning-results-keep-valid-items.md) | Silent learning keeps valid items and closes on unusable results | Extends 0056 and 0082; invalid items are dropped and recorded, evidence and attribution checks unchanged |
| [0129](0129-retired-sources-leave-native-notes.md) | Retired sources leave Hermes native notes | Extends 0123; removes note entries citing a retired source or written by a withheld turn's memory call |
| [0130](0130-spent-guard-fragment-retention.md) | Guard fragments leave once their source is prepared | Extends 0113 and 0121; the daily retention pass removes fragments of published guard sources after an hour |
| [0131](0131-honcho-meter-monthly-rollup.md) | The Honcho meter folds closed months into totals | Bounds the egress ledger; cap window and previous month keep per-call rows |
| [0132](0132-retired-history-placeholders.md) | Withheld Hermes history rows name the retired source | Extends 0123; a retired message or reply leaves a placeholder with its message ID; restore still does not rebuild it |
| [0133](0133-group-replies-when-addressed.md) | Group messages start a turn only when they address Nocheh | Narrows 0062; owner setting, only when addressed by default, unaddressed messages are archived without a turn |
| [0134](0134-editable-bot-names.md) | The names that address Nocheh are one editable list | Amends 0133; `TELEGRAM_BOT_NAMES` starts as Nocheh and نوچه, the owner may change or empty it |
| [0135](0135-group-topics-share-memory.md) | A group's topics share one memory by default | Amends 0030 and 0115; reads widen to the group's General chat and every topic, `TELEGRAM_TOPIC_MEMORY=topic` keeps topics separate |
| [0136](0136-per-topic-dispatch-lanes.md) | Each group topic has its own dispatch lane | Supersedes ADR-0125's shared group lane; order within one topic unchanged |
| [0137](0137-side-by-side-runtime-context-guarding.md) | Runtime context for one audience is guarded side by side | Extends 0127 to guarded runtime context and Honcho provider requests; identical fresh text is shared, publications bounded at four |
| [0138](0138-shared-context-detection.md) | Identical runtime text reuses one detector result across audiences | Extends 0137; detection shared by content, detector version and binding; guarded copies and access stay per audience |
| [0139](0139-reply-checks-before-background-checks.md) | Reply secret checks go before background learning checks | Extends 0127; memory review and learning checks are background, wait behind reply checks and leave one slot for replies |
| [0140](0140-truncated-learning-results-keep-whole-items.md) | A cut-off learning result keeps its whole leading items | Extends 0128; an answer cut at the output limit keeps whole items and sections before the cut |
| [0141](0141-per-part-model-providers.md) | Each part of Nocheh chooses its provider and model | Supersedes the single reasoning model route; built-in, OpenAI, Anthropic or custom OpenAI-compatible providers per part, keys server-side |
| [0142](0142-external-providers-only.md) | Nocheh runs no provider proxy; every model call uses a Settings provider | Supersedes 0035, 0103 and the built-in provider of 0141; no CLIProxyAPI, CPA Manager Plus or subscription transcription; unconfigured parts fail with provider_not_configured |
| [0145](0145-rebuilt-owner-dashboard.md) | The owner dashboard is rebuilt around eight plain pages and one save bar | Supersedes the 2026-10-12 page structure and settings flow, and 0026, 0058 and 0059 inside the dashboard; one sticky save bar saves and applies; graph and memory map removed |
| [0146](0146-save-in-page-header.md) | Save sits in the page header, not in a card at the bottom | Supersedes the save bar placement of ADR-0145 |
| [0147](0147-save-always-present.md) | Save is always present on pages that edit settings | Refines ADR-0146 |
| [0143](0143-hermes-delivery-log-retention.md) | Finished Hermes delivery logs expire after one month | Closed outbound, dispatch and run journals older than `NOCHEH_HERMES_JOURNAL_RETENTION_DAYS` (30) are removed at startup and daily; unfinished or unpublished ones stay |
| [0144](0144-keep-history-by-default.md) | Workflow history and Hermes delivery logs are kept by default | Supersedes the 14-day default of 0110 and the 30-day default of 0143; `0` is the default and the owner can set days |
| [0148](0148-honcho-reads-wait-for-epoch-correction.md) | Honcho reads wait for each guard epoch's correction | Refines 0115; turn context and recall read nothing from Honcho until the epoch's correction sweep and replaced-session deletions finish |
| [0149](0149-only-owner-changes-hold-honcho.md) | Only uncorrected owner changes hold Honcho reads | Supersedes the epoch condition of 0148; learning and other routine epochs no longer pause Honcho memory |
| [0150](0150-honcho-recall-checks-take-reply-priority.md) | Honcho recall checks take reply priority | Extends 0139; Honcho deriver requests stay background, API recall requests are checked at reply priority |
| [0151](0151-chat-role-and-skills-in-hermes-profiles.md) | Each chat's role and skills live in its Hermes profile | `SOUL.md` and `skills/` per canonical chat profile plus `nocheh-default/`; turns read them, never write them |
| [0152](0152-owner-editable-built-in-instructions.md) | The owner's instruction texts travel with each runtime call | Defaults stay in code; replacements in `owner_prompts` ride on `run.start`, `memory.review`, `guard.detect` and `memory.filter` as `prompts` |
| [0153](0153-owner-reruns-and-replaces-honcho-memory.md) | The owner re-runs or replaces Honcho memory | Builds on 0115 and 0122; retry failed Honcho learning in place, re-learn chosen chats by session rebuild, or replace the workspace from the archive or empty |
| [0154](0154-message-edits-replace-honcho-writes.md) | A message edit replaces its earlier Honcho writes | Extends 0115; only the latest revision of an incoming Telegram message is written, by targeted session rebuild |
| [0155](0155-albums-answered-once.md) | An album is answered once, on its first part | One turn per `media_group_id` with every ready part's text and files; other parts close as `album_member` |
| [0156](0156-desktop-exports-share-proven-telegram-identities.md) | Desktop exports share the Telegram identities Telegram proves | Extends 0051; Desktop senders are their Bot API accounts, and a supergroup or channel export mapped to its live chat observes the live messages, which win in search and Honcho memory |
| [0157](0157-group-turns-see-recent-unaddressed-messages.md) | A group turn sees the recent messages not addressed to Nocheh | Up to 20 guarded group messages since the last turn, with speaker lines and source citations, precede the turn outside the Honcho memory query |
| [0158](0158-telegram-approval-buttons.md) | Approve and Reject buttons in Telegram | A pending action gets a card with exact content and two buttons in its own group or the owner's private chat; only the owner's press decides, and the card shows the outcome |
| [0159](0159-group-members-post-freely-and-approvals-go-private.md) | Allowed members post freely in their own group; approvals go to the owner privately | A same-group post by an allowed member needs no approval; a post to another group is approved first; every card goes to the owner's private chat; people not allowed get one fixed, editable reply |
| [0160](0160-owner-task-list.md) | The owner's own task list | Tasks live in the control store; the dashboard edits them as the owner and the assistant only from a live owner-private turn, with idempotent changes and calendar-day due dates |
| [0161](0161-requesters-review-their-own-cross-group-messages.md) | The person who asked reviews their own message to another group | An allowed member's message to another group where they are also allowed, or to another topic with separate topic memory, gets its card in the group where it was asked, decided by that person or the owner |
| [0162](0162-telegram-mini-app.md) | The Telegram mini app | A credential-free service behind a Cloudflare tunnel checks Telegram's signature for the owner and forwards only home, Inbox and task routes to the dashboard |
| [0163](0163-chat-conversation-carries-into-new-guard-epochs.md) | A chat's conversation carries into each new guard epoch | A new epoch's profile is seeded once with the chat's recent user messages and delivered answers from its newest earlier profile; tool work, reasoning, summaries and notes stay behind, and retirements still apply before the first turn |
| [0164](0164-task-lists-links-and-tags.md) | Task lists, links and tags | Extends 0160; each task is personal or in one project's own list, can point to a group and people, and has a list of tags; a project's chat reaches only that project's list |
| [0165](0165-approval-card-is-the-answer-and-links-its-place.md) | An approval card is the whole answer and links where its message goes | Extends 0158 and 0161; a card in the chat where it was asked replies to the request and the turn stays silent; group and topic names come from captured messages and are Telegram text links |
| [0166](0166-a-chat-follows-its-own-message-requests.md) | A chat follows its own message requests across turns | Any turn of the same chat and profile reads its Telegram message requests; the status tool lists recent ones without an id; a finished request is asked again as a new one |
| [0167](0167-tasks-like-a-notion-table.md) | Tasks like a Notion table | Extends 0160 and 0164; owner-named statuses in four kinds, priority 0–4, start and due times, repeats, Telegram reminders, subtasks, dependencies, assignees, manual order, custom columns, comments, history, attachments, Markdown notes, archive and trash, external IDs, and Today, Upcoming and Board views |
| [0168](0168-superseded-epoch-profiles-are-removed.md) | Superseded guard-epoch profiles are removed once idle | Extends 0163; a chat's earlier-epoch profiles are removed after 15 idle minutes, once the newer profile has carried the conversation, so hidden content does not stay behind |
| [0169](0169-reply-runs-are-not-refused-for-worker-capacity.md) | Reply runs are not refused for worker capacity | Extends 0087; the pipeline worker accepts eight step requests at once, so a burst of background work after a memory change no longer makes Inngest refuse a reply's run and retry it minutes later |
| [0170](0170-secret-check-results-survive-guard-epochs.md) | Secret-check results carry across guard epochs | A text's shared detector result is keyed by installation, guard mode and detector, not epoch, so memory changes no longer make every recall and reply re-check text already checked |
| [0171](0171-desktop-forum-messages-keep-their-topics.md) | Desktop forum exports keep their topics | Extends 0156; the importer follows reply links to each topic's creation message, so a forum export mapped to its live supergroup files messages under their live topics |
| [0172](0172-provider-model-lists-pass-the-guard.md) | A provider's bare model list passes the privacy guard | A GET to .../models with no query or body carries no content and is sent unguarded; everything else is guarded or refused as before |
| [0173](0173-waiting-native-reviews-keep-their-place.md) | Waiting native reviews keep their place across epochs | Extends 0124; a never-started Hermes native review is rebound to the new epoch when its input is unchanged, old copies are deleted, and waiting reviews don't poll Hermes while another one runs |
| [0174](0174-memory-preparation-outages-are-retried.md) | Honcho retries a memory preparation outage | The provider gateway answers a temporary archive preparation failure with 503 and Retry-After so Honcho retries; only real refusals stay 403 |
| [0175](0175-notion-through-its-mcp-server.md) | Notion through its MCP server | Optional and off by default; OAuth or a Business MCP token kept by the management service; only the owner's private chat proposes Notion calls; the owner chooses whether reads, everything or nothing asks first |
| [0176](0176-stopped-learning-is-asked-again.md) | Learning stopped by an epoch is asked again | Extends 0173; the per-source sweep after each epoch requests a message's learning again when its newest job was left pending or failed under an earlier epoch |
| [0177](0177-stranded-memory-work-is-picked-up-at-start.md) | Stranded memory work is picked up at start | Extends 0173 and 0176; each worker start asks once for the per-source step of sources whose native review or learning was stranded under an earlier epoch |
| [0178](0178-settings-apply-is-followed-to-its-end.md) | A settings apply is followed to its end, across reloads | Refines 0146 and 0147; apply reports its steps, a reloaded page follows a running apply, and every apply ends with a result or a plain error |
| [0179](0179-anthropic-model-list-page-size-passes-the-guard.md) | A model list's page size passes the privacy guard | Extends 0172; a GET .../models whose only query is a numeric limit passes like the bare list; any other query is refused |
| [0180](0180-pixel-brain-logo-and-logo-colours.md) | The pixel brain logo and the logo's colours | Refines 0145; the owner's pixel brain is the logo on crisp grids, the dashboard tokens follow its lavender, navy and mint, and the favicon is an inline SVG |
| [0181](0181-memory-search-model-change-rebuilds-memory.md) | Changing the memory search model rebuilds Honcho memory | Extends 0153; every reviewed model is selectable, Save asks to confirm the rebuild, and Apply restarts Honcho with the new model, moves the gateway ledger and replaces long-term memory from the archive |
| [0182](0182-strangers-cost-nothing-and-reach-no-model.md) | Strangers cost nothing and reach no model | Extends 0159; no command menu for anyone; updates from chats Nocheh doesn't serve are archived but never prepared, read by a turn or listed to the assistant; a private stranger gets one editable fixed reply a day |
| [0183](0183-failed-native-review-without-effect-runs-again.md) | A native review that failed without changing notes runs again | Extends 0097 and 0124; a review whose notes are unchanged after a failure gets a failed receipt, is launched again under its lease, and the app retries it up to four attempts with growing gaps |
| [0184](0184-text-the-secret-check-always-declines-is-hidden.md) | Text the secret check always declines is hidden whole | Extends 0010; a single text the provider's safety filter declines twice on its own is masked whole as a secret instead of failing the check, and halving splits at the caller's own separator |
| [0185](0185-review-stopped-at-its-time-limit-runs-again.md) | A notes review stopped at its time limit without changing notes runs again | Extends 0183; the supervisor marks a killed or failed child's running receipt failed under the memory lock when the notes are unchanged |
| [0187](0187-daily-automatic-backups.md) | Daily automatic backups | Extends 0144; the dashboard backs up daily at an owner-set time and time zone, keeps the newest automatic copies, never removes hand-started ones, and skips when the disk is short |
| [0188](0188-typing-status-while-a-turn-works.md) | Telegram shows typing while a turn works | The committed adapter renews `sendChatAction` every four seconds from turn start until the answer is ready or the turn fails, under the reply's audience check and outside the outbound journal; `TELEGRAM_TYPING` turns it off |
| [0189](0189-mini-app-password.md) | The mini app has a password | Extends 0162; the dashboard keeps a scrypt hash of a password the owner sets in Settings › Telegram and the phones' sessions; each phone signs in once, a new password or Sign out everywhere ends every session, wrong passwords pause sign-in |
