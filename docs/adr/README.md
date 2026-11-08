# Architecture decisions

This page says which decisions hold today, grouped by area. Each bullet links the ADRs behind it.
Open an ADR only when you need its reasons, rejected options or exact limits.
ADR files are historical records and stay unchanged; a later ADR replaces only the parts it names.
[SPECS.md](../../SPECS.md) defines the product, [TASK.md](../../TASK.md) records status, and [AGENTS.md](../../AGENTS.md) holds the working rules. ADRs never override them. [CATALOG.md](CATALOG.md) is the full chronological index.

## Nocheh in one paragraph

Nocheh is a personal AI brain. It owns the original archive, the rules, the secret check and every owner decision. Hermes is the agent runtime: it runs each turn in a sealed container and also acts as the Telegram adapter that receives and sends messages. Telegram is one front door, not the product. Honcho is long-term memory, and Hermes native notes are a smaller per-chat memory. Inngest drives durable workflows, but Nocheh's own Postgres state decides each step. The runtime, the memory service, the model providers and the front door all sit behind adapters and can be swapped.

## Current decisions

### Product and ownership

- Nocheh is a personal AI brain, not a task bot; outward actions need owner approval ([0007](0007-personal-ai-brain-roadmap.md)).
- Nocheh owns the archive, rules, secret check, approvals and dashboard; Hermes is a replaceable runtime behind an adapter ([0018](0018-hermes-owned-archive-subscription-rebuild.md), [0027](0027-native-hermes-dashboard-integration.md)).

### Archive and sources

- Three stores: the archive keeps originals only, the derived store keeps masked copies and generated material, and the control store keeps authority and operations state ([0053](0053-original-only-archive.md)).
- Data is plain text at rest, so it can be indexed and searched ([0014](0014-postgres-plaintext-at-rest-owner-column.md)).
- Sources have platform-independent identities, revisions and relations beside the unchanging event log ([0051](0051-platform-independent-sources.md)).
- Preparation turns media into text with Hermes tools: the document reader for files, the transcriber for voice notes and the vision tool for images ([0192](0192-files-are-read-by-the-runtime-document-reader.md), [0193](0193-voice-notes-are-transcribed-by-the-runtime-transcriber.md), [0194](0194-images-are-read-by-the-runtime-vision-tool.md)).
- The agent reads a chat oldest first through access checks, searches Honcho memory by meaning within readable sessions, and finds current reactions with masked excerpts ([0195](0195-the-agent-reads-a-chat-in-order-and-searches-by-meaning.md), [0084](0084-scoped-reaction-discovery.md), [0086](0086-reaction-discovery-evidence.md)).

### Secret check and security

- The secret check is on or off. When on, preparation stores a masked copy of each source as a guard revision that the owner can edit ([0033](0033-guarded-projections-and-honcho-memory.md)).
- Every Hermes model request passes the Hermes request boundary and the nocheh-security service, which owns policy, brokered provider calls and effect decisions; Honcho's model requests are checked by Nocheh through Honcho's provider gateway; a required check fails closed ([0020](0020-mandatory-outgoing-request-guard.md), [0037](0037-external-security-plugin-service.md)).
- A model-list request with no content, or with only a numeric page size, passes unchecked ([0172](0172-provider-model-lists-pass-the-guard.md), [0179](0179-anthropic-model-list-page-size-passes-the-guard.md)).
- Checks run side by side, three by default; reply checks take free slots before background checks; one audience's runtime context is masked side by side ([0127](0127-parallel-guard-checks.md), [0137](0137-side-by-side-runtime-context-guarding.md), [0139](0139-reply-checks-before-background-checks.md)).
- Identical text reuses one detector result across audiences and guard epochs; a first transcript or extraction choice does not start a new epoch ([0138](0138-shared-context-detection.md), [0170](0170-secret-check-results-survive-guard-epochs.md), [0108](0108-first-derivative-selection-does-not-revoke.md)).
- Text the check declines twice on its own is masked whole as a secret ([0184](0184-text-the-secret-check-always-declines-is-hidden.md)).

### Telegram and other doors

- In a selected group, only the owner starts turns unless a member is granted; a deny wins, and delivery re-checks access ([0062](0062-owner-managed-telegram-group-participants.md)).
- By default a group message starts a turn only when it addresses Nocheh: it replies to or mentions the bot, or opens with its display name or a name in `TELEGRAM_BOT_NAMES`; `TELEGRAM_GROUP_REPLIES=all` answers every message ([0133](0133-group-replies-when-addressed.md), [0134](0134-editable-bot-names.md)).
- Chats Nocheh does not serve are archived but never prepared or shown to a model; a private stranger gets one fixed reply a day ([0182](0182-strangers-cost-nothing-and-reach-no-model.md)).
- Every physical send is re-checked against its approved chat, topic and current policy; a rate-limited send gets at most three journaled attempts, and an uncertain send never resends ([0089](0089-physical-telegram-delivery-boundary.md), [0090](0090-durable-telegram-rate-limit-retries.md)).
- Hermes shows typing while a turn works and reacts on the answered message: eyes while working, then thumbs up or down ([0188](0188-typing-status-while-a-turn-works.md), [0211](0211-hermes-working-reactions-on-the-answered-message.md)).

### Replies and turns

- Hermes polls and sends for Telegram; each chat has its own Hermes profile with a fixed tool set and its own role (SOUL.md) and skills ([0021](0021-scoped-native-assistant-processes.md), [0151](0151-chat-role-and-skills-in-hermes-profiles.md)).
- Each turn runs in its own sealed container; browser TUI turns use the same isolation, and abandoned leases are reclaimed under the profile lock ([0028](0028-isolated-native-browser-turns.md), [0098](0098-isolated-native-lease-recovery.md)).
- Turns start in Telegram update order per chat or topic; chats and topics run in parallel up to owner limits (3 replies, 4 agent runs) ([0104](0104-telegram-update-order-and-untransmitted-sends.md), [0125](0125-per-chat-telegram-dispatch-lanes.md), [0136](0136-per-topic-dispatch-lanes.md), [0126](0126-owner-set-parallel-replies-and-runs.md)).
- The owner's instruction texts ride on each runtime call; defaults stay in code ([0152](0152-owner-editable-built-in-instructions.md)).
- A group turn also sees up to 20 recent unaddressed messages, masked and cited; an album gets one turn on its first part ([0157](0157-group-turns-see-recent-unaddressed-messages.md), [0155](0155-albums-answered-once.md)).
- A new guard epoch's profile starts with the recent conversation, and old profiles are removed after 15 idle minutes ([0163](0163-chat-conversation-carries-into-new-guard-epochs.md), [0168](0168-superseded-epoch-profiles-are-removed.md)).

### Honcho memory

- Honcho is primary long-term memory, on by default in fresh installs, run in the installation Compose project and attached once at startup; Nocheh is its only writer, and Hermes has no direct access ([0033](0033-guarded-projections-and-honcho-memory.md), [0045](0045-honcho-in-installation-compose.md), [0076](0076-honcho-enabled-local-default.md), [0061](0061-retire-isolated-honcho-comparison.md)).
- One workspace per installation, stable peers for people and projects, and versioned sessions per conversation; Nocheh enforces audience on every read ([0056](0056-connected-entity-memory.md), [0109](0109-standard-honcho-entity-model.md), [0115](0115-honcho-session-revisions.md)).
- A reply reads its conversation's Honcho session context live when a message arrives, and context is prefetched when Honcho finishes work, never on a timer ([0044](0044-automatic-honcho-context.md), [0114](0114-event-driven-honcho-context.md), [0115](0115-honcho-session-revisions.md)).
- Only the latest revision of an edited message stays in Honcho; only an uncorrected owner change or a replaced session pauses reads ([0154](0154-message-edits-replace-honcho-writes.md), [0148](0148-honcho-reads-wait-for-epoch-correction.md), [0149](0149-only-owner-changes-hold-honcho.md)).
- Historical recall needs evidence beyond the current question; terminal queue errors block readiness; preparation outages answer 503 so Honcho retries; recall checks run at reply priority ([0099](0099-independent-evidence-for-historical-recall.md), [0101](0101-honcho-terminal-queue-errors-block-readiness.md), [0174](0174-memory-preparation-outages-are-retried.md), [0150](0150-honcho-recall-checks-take-reply-priority.md)).
- The owner can retry learning, re-learn chosen chats or start a fresh workspace; changing the memory search model rebuilds memory; a 30-minute synthetic workspace allows checks while memory is detached ([0153](0153-owner-reruns-and-replaces-honcho-memory.md), [0122](0122-honcho-fresh-start.md), [0181](0181-memory-search-model-change-rebuilds-memory.md), [0068](0068-detached-honcho-acceptance-workspace.md)).

### Hermes native notes and learning

- Each live source gets at most one native notes review, run in a supervised thread outside workflow admission, after Honcho ingestion's first attempt ([0097](0097-durable-native-review-handoff.md), [0124](0124-native-review-once-per-source.md), [0088](0088-primary-ingestion-before-native-note-review.md)).
- A review that failed or timed out without changing notes runs again, up to four attempts ([0183](0183-failed-native-review-without-effect-runs-again.md), [0185](0185-review-stopped-at-its-time-limit-runs-again.md)).
- Waiting reviews, including failed ones waiting to run again, keep their place and an open workflow across epochs; stopped learning is asked again, and stranded work is picked up at start ([0173](0173-waiting-native-reviews-keep-their-place.md), [0216](0216-failed-reviews-keep-their-place-across-epochs.md), [0217](0217-waiting-fragments-keep-their-place.md), [0176](0176-stopped-learning-is-asked-again.md), [0177](0177-stranded-memory-work-is-picked-up-at-start.md)).
- Learning keeps valid and whole leading items and reuses results unless real evidence changes ([0128](0128-learning-results-keep-valid-items.md), [0140](0140-truncated-learning-results-keep-whole-items.md), [0082](0082-evidence-based-learning-deduplication.md)).
- Automatic publication waits while a reply is active; privacy revocations apply at once ([0083](0083-defer-automatic-memory-publication-during-replies.md)).
- A retired source leaves Hermes history and notes: history rows become notices naming the retired ID, and notes citing it are removed ([0123](0123-retired-sources-leave-native-history.md), [0132](0132-retired-history-placeholders.md), [0129](0129-retired-sources-leave-native-notes.md)).

### Audience and sharing

- Owner recall spans every chat Nocheh serves; each group has its own memory audience, and its topics share it unless `TELEGRAM_TOPIC_MEMORY=topic` ([0030](0030-configurable-space-memory.md), [0135](0135-group-topics-share-memory.md)).
- Relationships never grant access; the owner approves one-time or lasting fact grants per group or topic ([0057](0057-memory-relationship-access-map.md)).
- A grant, its follow-up message and its workflow request commit together; delivery re-checks the exact grant; replays are serialized and keep expiry; an unstarted handoff resumes on an exact owner replay ([0093](0093-atomic-memory-approval-followups.md), [0094](0094-current-memory-authority-at-delivery.md), [0095](0095-recover-unstarted-memory-handoffs.md), [0096](0096-serialize-memory-decision-replays.md)).

### Actions and approvals

- The agent only proposes; approved shell, browser and MCP work runs in isolated containers with exact, revocable permissions ([0029](0029-controlled-tool-execution.md)).
- A waiting action shows Approve and Reject cards in Telegram with its exact content, an operation's in words; asked in chat, the card is the reply; the settled card says how it ended ([0158](0158-telegram-approval-buttons.md), [0165](0165-approval-card-is-the-answer-and-links-its-place.md), [0202](0202-approved-actions-report-how-they-ended.md), [0213](0213-operation-cards-read-in-words.md)).
- Allowed members post freely in their own group; a message to another group is reviewed by the asker or the owner; other approvals go to the owner's private chat ([0159](0159-group-members-post-freely-and-approvals-go-private.md), [0161](0161-requesters-review-their-own-cross-group-messages.md)).
- Topic destinations stay exact, a chat follows its own requests across turns, and waiting approvals carry across quiet epochs ([0092](0092-exact-topic-action-destinations.md), [0166](0166-a-chat-follows-its-own-message-requests.md), [0200](0200-waiting-approvals-survive-reaction-epochs.md)).
- When an approved operation ends, the agent continues in the chat that asked and answers there as a reply to the request, at most three times per request; such a follow-up never acts under the owner's freedom setting ([0212](0212-approved-operations-answer-in-the-chat-that-asked.md)).
- An operation a rule or the owner freedom setting already allows is waited for in the turn, up to a minute, and answers in that reply; no follow-up repeats it ([0215](0215-an-allowed-operation-answers-in-the-same-turn.md)).
- A web read's card can allow its site in that chat or topic for 12 hours or 30 days, and a command's card that exact command for 30 days; rules survive epochs, deny rules still win, and connected tools and messages are decided one by one ([0214](0214-allow-a-site-or-command-in-one-chat.md)).
- An operation or message whose outcome is unclear waits in the Inbox until the owner says it ran, says it did not, or dismisses it; an unclear web page read closes by itself. The receipt stays as observed and nothing runs again ([0218](0218-unclear-outcomes-close-by-the-owners-word-or-as-a-read.md)).
- Notion is optional, through its MCP server; only the owner's private chat proposes calls ([0175](0175-notion-through-its-mcp-server.md)).

### Background jobs and sealed box

- The agent starts a job with one call, Nocheh prices it and a card approves it; a job is one sealed Hermes run of up to 50 minutes, relaunched at most twice if it does not finish ([0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md), [0207](0207-a-background-job-is-one-hermes-run.md)).
- Nocheh prices a job's model use itself at frozen rates, and the broker refuses requests past the cost limit ([0206](0206-nocheh-prices-a-jobs-model-use-itself.md)).
- A running job and its report carry across quiet epochs, and each report part is sent once ([0208](0208-running-jobs-carry-across-quiet-epochs.md), [0201](0201-job-reports-survive-reaction-epochs.md)).
- Jobs the owner asks for in their private chat may use a sealed box: no network, no keys, a read-only chat copy and a read-only GitHub copy fetched through Nocheh's own GitHub App ([0205](0205-owner-approved-jobs-work-in-a-sealed-box.md), [0209](0209-owner-approved-jobs-read-a-github-copy-in-their-box.md), [0210](0210-github-access-goes-through-nochehs-own-github-app.md)).
- Owner-approved private-chat jobs read Notion as the owner allows; changes always ask, and group or member jobs never reach Notion ([0203](0203-owner-approved-jobs-read-notion.md)).
- A job's changes come on list cards after its report ([0204](0204-a-jobs-changes-come-on-list-cards.md)).

### Workflows and schedules

- Local Inngest runs every product workflow but only wakes steps; Nocheh's archive, outbox and receipts decide ([0041](0041-local-inngest-workflows.md), [0046](0046-consolidated-inngest-installation.md)).
- An accepted event is republished every 30 seconds until a workflow records receipt ([0047](0047-receipted-event-handoff.md)).
- The workflow worker coordinates through archive API calls without database access; the owner can retry, cancel and read history ([0042](0042-host-workflow-archive-coordination.md), [0043](0043-owner-workflow-inspection.md)).
- Replies keep one of two admission slots; background work shares one Inngest concurrency key and hands a free slot to a live waiter; the worker takes eight step requests at once ([0080](0080-reply-admission-and-honcho-derivation.md), [0105](0105-shared-background-engine-queue.md), [0087](0087-live-background-admission-handoff.md), [0169](0169-reply-runs-are-not-refused-for-worker-capacity.md)).
- Hermes keeps schedule definitions; each fire is captured, run in isolation and never delivered automatically ([0031](0031-native-managed-schedules.md)).
- Every loop outside Inngest is listed with its reason ([0120](0120-loops-outside-inngest.md)).
- Workflow history and Hermes delivery logs are kept forever by default; when the owner sets a number of days, a daily pass expires them with spent records, model-call events, guard fragments and unused context summaries ([0144](0144-keep-history-by-default.md), [0106](0106-configurable-workflow-history-retention.md), [0107](0107-daily-workflow-history-retention.md), [0111](0111-complete-workflow-history-retention.md), [0112](0112-spent-workflow-record-retention.md), [0113](0113-superseded-memory-summary-retention.md), [0121](0121-operational-telemetry-retention.md), [0130](0130-spent-guard-fragment-retention.md), [0143](0143-hermes-delivery-log-retention.md)).

### Tasks and projects

- The owner's tasks live in the control store as personal or project lists, with links, tags and Notion-like fields ([0160](0160-owner-task-list.md), [0164](0164-task-lists-links-and-tags.md), [0167](0167-tasks-like-a-notion-table.md)).
- The agent proposes knowledge changes; delegated project creation and chat assignment apply later, with receipts and inbox review ([0091](0091-bounded-agent-knowledge-organization.md)).
- A project has its own role and skills; a chat's role wins, and skills stack ([0196](0196-projects-have-their-own-role-and-skills.md)).

### Imports

- Desktop export senders map to proven Telegram identities, live copies win, and forum exports keep their topics ([0156](0156-desktop-exports-share-proven-telegram-identities.md), [0171](0171-desktop-forum-messages-keep-their-topics.md)).
- Imports share paged secret checks at background priority, are ready once every message is prepared, and are learned by Honcho only ([0191](0191-imports-share-secret-checks-and-become-ready.md), [0198](0198-imported-history-is-learned-by-long-term-memory-only.md)).

### Dashboard and mini app

- The dashboard and CLI share owner operations; the dashboard runs apart from Telegram ([0025](0025-owner-dashboard-and-management-cli.md)).
- The dashboard has plain pages with Save in the sticky page header, and every settings apply is followed to its end ([0145](0145-rebuilt-owner-dashboard.md), [0146](0146-save-in-page-header.md), [0147](0147-save-always-present.md), [0178](0178-settings-apply-is-followed-to-its-end.md)).
- It uses shared components, workflow charts, the pixel brain logo and its colours, and a read-only database browser ([0050](0050-dashboard-components-and-workflow-metrics.md), [0180](0180-pixel-brain-logo-and-logo-colours.md), [0063](0063-owner-database-browser.md)).
- The mini app is a credential-free service behind an outgoing tunnel that checks Telegram launch data; one owner password covers it and the dashboard ([0162](0162-telegram-mini-app.md), [0189](0189-mini-app-password.md), [0190](0190-one-owner-login.md)).

### Providers and models

- Each part picks its own Settings provider (OpenAI, Anthropic or custom) and model; Nocheh runs no provider proxy or login, and an unset part fails with `provider_not_configured` ([0141](0141-per-part-model-providers.md), [0142](0142-external-providers-only.md)).
- Embeddings have explicit provider, model and key settings, and a provider failure starts a durable cooldown ([0034](0034-explicit-embedding-environment.md), [0100](0100-durable-embedding-egress-cooldown.md)).
- Anthropic replies use the Messages API for prompt caching ([0199](0199-anthropic-replies-use-the-messages-api-for-prompt-caching.md)).

### Health and usage

- The owner sets the monthly embedding cap ($0 to $15); spending settles from reported usage, definite HTTP errors release their holds, and old months fold into totals ([0078](0078-owner-honcho-budget-control.md), [0079](0079-separated-honcho-budgets-and-settlement.md), [0102](0102-separate-embedding-error-holds-from-spending.md), [0131](0131-honcho-meter-monthly-rollup.md)).
- An exhausted pilot can move to the monthly cap for acceptance ([0077](0077-exhausted-pilot-honcho-acceptance-budget.md)).
- Telegram polling is watched, and fatal errors restart it ([0038](0038-observed-telegram-health-and-local-oauth-callback.md)).

### Installation and recovery

- Local Docker Compose is the target, in one project named nocheh; exact-revision rollouts rebuild only nocheh-app ([0019](0019-local-compose-development-and-acceptance.md), [0036](0036-one-compose-project.md), [0067](0067-exact-revision-app-rollout.md)).
- nocheh-app holds archive, capture and handlers; nocheh-security holds broker and guard; hermes, hermes-agent-sb and nocheh-db complete the core ([0046](0046-consolidated-inngest-installation.md), [0055](0055-concise-core-service-names.md)).
- The dashboard and executor are services with owner-approved Docker socket access; agents never get the socket ([0048](0048-containerized-management.md)).
- nocheh-db creates the archive, derived, control and workflow databases before it reports healthy; root Compose owns its volumes ([0054](0054-postgres-owned-store-bootstrap.md), [0075](0075-clean-development-setup.md)).
- One root `.env` is the editable configuration ([0024](0024-single-environment-configuration.md)).
- Backups are quiesced, verified and daily; a restore starts inactive; upgrades are checked offline first, and the archive and Hermes native notes export in a portable form ([0023](0023-consistent-backups-and-inactive-restore.md), [0187](0187-daily-automatic-backups.md), [0081](0081-bounded-workflow-backup-fingerprints.md), [0032](0032-isolated-upgrades-and-portable-memory.md)).

### Dev process

- AGENTS.md holds working rules, SPECS.md the product and TASK.md the status; work uses one worktree and locked integration, and merging to main is not a release or activation ([0039](0039-main-refactor-consolidation.md), [0040](0040-specifications-and-agent-workflow.md)).
- Code is placed by role, `.agent/` is the only agent support root, and live acceptance output stays out of Git ([0069](0069-role-based-source-layout.md), [0070](0070-single-agent-support-root.md), [0071](0071-local-only-acceptance-evidence.md)).
- `make dev` runs one source-watched stack against the operating installation, with the root dev Compose override ([0065](0065-single-stack-source-mounted-development.md), [0066](0066-fixed-name-standard-port-development.md), [0073](0073-live-data-source-watched-development.md), [0074](0074-root-development-compose-layout.md)).

## Replaced decisions

- The first design's task pipeline, audit records, structured and graph memory, SQLite recall, setup dashboard, VPS bootstrap and delivery rules ([0001](0001-phase-1-core-processing.md), [0002](0002-phase-1-5-validation-observability.md), [0003](0003-phase-2-structured-memory.md), [0006](0006-setup-dashboard.md), [0008](0008-memory-graph-architecture.md), [0009](0009-bootstrap-and-env-source-of-truth.md), [0011](0011-embedding-backed-recall.md), [0012](0012-wiring-recall-into-analysis.md), [0016](0016-answer-path-outbound-delivery-approval-rule.md)) -> the Hermes rebuild ([0018](0018-hermes-owned-archive-subscription-rebuild.md)) and local Compose ([0019](0019-local-compose-development-and-acceptance.md)).
- SQLite ([0005](0005-sqlite-vps-persistence.md)) -> Postgres ([0014](0014-postgres-plaintext-at-rest-owner-column.md)) -> three separate stores ([0053](0053-original-only-archive.md)).
- Live buffering ([0004](0004-live-buffering-history-import-ai-context.md)) -> one guarded message log ([0013](0013-importer-core-message-log-projections.md)) -> owned-archive rebuild on Hermes ([0018](0018-hermes-owned-archive-subscription-rebuild.md)).
- Guarded copies in the archive ([0052](0052-pure-source-archive.md)) -> originals only, masked copies derived ([0053](0053-original-only-archive.md)).
- No Honcho ([0015](0015-not-adopting-honcho-as-memory-layer.md)), a memory bake-off ([0017](0017-memory-backend-evidence-gate.md)) and an isolated Honcho trial ([0022](0022-isolated-metered-honcho-experiment.md)) -> Honcho as primary memory ([0033](0033-guarded-projections-and-honcho-memory.md)) -> standard Honcho entity model ([0109](0109-standard-honcho-entity-model.md)).
- Shared provider proxy ([0035](0035-shared-cliproxy-provider-and-monitoring.md)) and OAuth relay ([0103](0103-relay-every-provider-oauth-login.md)) -> Settings providers only ([0141](0141-per-part-model-providers.md), [0142](0142-external-providers-only.md)).
- 3D evidence view and Memory map ([0026](0026-three-dimensional-evidence-view.md), [0058](0058-semantic-react-flow-memory-map-editing.md), [0059](0059-elk-layered-memory-map-layout.md), [0060](0060-context-entity-evidence-graph.md)) -> plain dashboard pages ([0145](0145-rebuilt-owner-dashboard.md)).
- Timed Honcho context refresh ([0072](0072-validated-honcho-context-renewal.md)) -> event-driven context ([0114](0114-event-driven-honcho-context.md)) -> versioned sessions ([0115](0115-honcho-session-revisions.md)).
- Separate dev preview ([0064](0064-isolated-source-watched-development-preview.md)) -> one source-watched dev stack ([0073](0073-live-data-source-watched-development.md)) -> clean setup ([0075](0075-clean-development-setup.md)).
- Inngest storage set up by nocheh-app ([0049](0049-application-database-bootstrap.md)) -> set up by nocheh-db ([0054](0054-postgres-owned-store-bootstrap.md)).
- 14-day history retention ([0110](0110-default-workflow-history-retention.md)) -> keep forever by default ([0144](0144-keep-history-by-default.md)).
- Retry-order hints for background admission ([0085](0085-fair-background-workflow-admission.md)) -> live admission handoff ([0087](0087-live-background-admission-handoff.md)).
- Background jobs as a chain of sealed steps ([0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md)) -> one Hermes run ([0207](0207-a-background-job-is-one-hermes-run.md)).
- Separate mini app password ([0189](0189-mini-app-password.md)) -> one owner login ([0190](0190-one-owner-login.md)).

## How to add or interpret an ADR

- Use SPECS.md for the intended product and TASK.md for what is built or active.
- Add an ADR only for a lasting architecture choice whose reasons will matter later. ADRs are not progress logs.
- Name exactly which earlier decision the new one extends or replaces. Do not retire a whole ADR when one boundary changed.
- Add the new ADR to [CATALOG.md](CATALOG.md) and to the right area on this page; move replaced decisions to "Replaced decisions".
- Never edit an accepted ADR. Fix SPECS.md, this page, the catalog, or write a new ADR instead.
