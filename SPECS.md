<specs>

<purpose>
SPECS.md is the authoritative, durable definition of what Nocheh has to be and do.
It defines the intended product independently of implementation progress. Working
instructions live in [AGENTS.md](AGENTS.md); actual implementation, activation,
acceptance evidence, and proposals live in [TASK.md](TASK.md).
</purpose>

<area name="Nocheh">

- Nocheh is a personal AI brain. Owned source data, useful memory, and reasoning are the product. Telegram is an adapter; Hermes is the first replaceable runtime.
- Nocheh owns its dashboard, CLI, archive and files, source identities, audience policy, guarding, approvals, and integration lifecycle.

<area name="Foundation and deployment">

- Nocheh uses TypeScript services, React, npm for dependency management and project scripts, and thin Python integration with Hermes. Tested upstream revisions and dependency versions are pinned.
- Local Docker Compose is the supported development, unattended operation, and acceptance environment. Each installation has one Compose project containing all services, including the owner dashboard and executor.
- Deployment service names identify their tool and purpose. `nocheh-app` combines the API, source capture, outbox publication, and ordinary Inngest handlers; `nocheh-security` combines the broker and guard outside agent execution. Hermes serves its built native dashboard through its managed web server. The owner dashboard and executor run as separate Docker services, independently of the application and Inngest. The executor service is named `nocheh-executor`. Stores, credential-bearing gateways, and isolated agent launch authority retain separate boundaries.
- The supported Node runtime is 24.x. Ordinary workflow execution has concurrency four, executor workflows two, and separate API/capture and workflow PostgreSQL pools capped at eight connections each. Inngest outages cannot prevent capture, API startup, or management operations while Docker is available.
- Nocheh owns one PostgreSQL archive and a file store. Guarded projections, owner revisions, audience policies, approvals, and source receipts are durable records in that database. Hermes owns its native runtime state. Provider monitoring may retain its own operational SQLite state.
- Product source data is portable across runtime and memory implementations. A replacement runtime satisfies the same capability, capture, audience, and enforcement contracts.

</area>

<area name="Archive and provenance">

- Original messages, observed events, edits and revisions, source identities, timestamps, and retrievable file bytes are preserved in the owned archive. Transcripts and other generated artifacts are separate records with source and generation provenance. A model output never replaces an original.
- Incoming Telegram events enter a durable spool before acknowledgment and commit idempotently before downstream assistant processing. Duplicate updates, database outages, restarts, partial downloads, and retries preserve observations and recoverable progress.
- Capture, attachment retrieval, assistant work, and approved actions have independent progress; slow inference does not block source capture. Unsupported or malformed input is retained with a visible processing outcome.
- Browser text and attachments are captured before command interpretation or inference. Scheduled definitions and fires have source identities and captured originals. Outbound results, execution attempts, and delivery receipts remain separate evidence.
- Search, source reads, artifact downloads, graphs, export, and replay preserve identities and enforce audience access. Queries are bounded and paginated. Derived conclusions and inferred relations are distinguishable from source facts.

<area name="Imports and portability">

- The database design supports long-term data import across platforms, including future Slack and Discord adapters. Adding a platform preserves existing source data, identities, provenance, and audience boundaries.
- Manual import accepts Telegram Desktop single-chat and multi-chat JSON exports with supplied media, including ZIP input. Preview shows scopes, message counts, dates, and missing files; missing media does not make supplied text unusable.
- Imported history defaults to owner-private scope. Mapping it to an existing group requires explicit owner selection; Desktop identities are not guessed to be Bot API identities.
- Import jobs persist progress, duplicates, revisions, errors, cancellation, and resumable identities. Uploads and extraction are bounded and reject escaping paths and symlinks. The supplied export bytes retain import provenance.
- Historical import and replay send no old conversation replies. Importing makes sources searchable; learning requires explicit opt-in at import confirmation, retained across retries.
- Archive export and reimport preserve originals, files, generated records, guarded history, identities, and provenance. Accepting saved guarded copies requires an explicit trusted restore; ordinary imports prepare their own projections and divergent histories are conflicts.
- Portable export also includes registered native profiles' notes, scope markers, and SQLite session snapshots including committed WAL state. Runtime-generated material is labeled separately. Per-file hashes and a completion manifest support verification; operational credentials and configuration are excluded.
- Portable export does not activate an installation or imply one common recovery snapshot. A quiesced backup supplies a common recovery point.

</area>
</area>

<area name="Guarded projections">

- Guarding has two modes: `on` and `off`, with `on` the default. Durable guarded projections are prepared at ingestion for source revisions, including imported and derived text, and reused without repeated detection of the same prepared content.
- A trusted model detects literal secret substrings; local code validates literal membership and spans, merges overlaps, and masks them. All other text remains exactly unchanged. Detection quality is measured; it is not a guarantee that every possible secret is found.
- The owner can inspect originals, file bytes, preparation status, guarded copies, and revision history. Only guarded projections are editable. Saves use revision checks; restoration creates a new revision. Saved owner edits are authoritative and cannot be re-masked or overwritten by background preparation.
- `on` selects only current guarded data for agents, tools, memory, and embeddings, including trusted reasoning routes. `off` selects originals with the same audience and effect checks. Guarding is neither archive encryption nor a switch that disables authorization.
- Preparation persists completed work and retries incomplete work. Unknown, unavailable, stale, or unbound guarded context fails closed without an original-data fallback.
- Every physical model attempt validates current content revisions, audience, and destination, including complete history, native memory, retrieved sources, tool results, auxiliary calls, redirects, retries, and provider changes. Unsupported transports, opaque server-side history, and provider-hosted tools that bypass this boundary are rejected.
- Trusted detection and media preparation receive the original inputs necessary for their task. Raw media reaches only explicitly trusted perception or transcription destinations; resulting text is stored and prepared under the same policy as typed text. Model names alone confer no trust.
- Owner edits and representation changes retire affected contexts, credentials, caches, and memory generations before reuse. Rebuilding uses current authorized sources; original and guarded memory generations do not mix. Retiring local data cannot retract data already delivered externally.

</area>

<area name="Memory and audience access">

- The owner's private assistant can recall across all registered native memories and archived sources. Groups and topics use versioned `isolated`, `approved` (default), or explicitly selected `filtered` sharing. Topics inherit group preferences and have distinct local context.
- Audience access is enforced in storage, tools, source reads, file access, notes, sessions, graphs, and delivery. Policy changes invalidate stale capabilities and contexts; audience authorization is rechecked before delivery.
- Approved shares expose exact owner-approved content revisions. They do not grant access to private originals or private provenance. Filtered sharing exposes only derived material reviewed for the target audience from explicitly selected sources; failures withhold wider knowledge. Semantic privacy filtering is fallible and separate from provider guarding.
- Live conversations can drive native memory review. Imported-content learning needs explicit approval during import; preparation or attachment does not grant that approval. Background review has no external-action tools and keeps source facts separate from inferences.
- Memories and retrieved content are evidence, never policy or approval. The security boundary preserves complete authorized native memory, source references, history, model choice, reasoning settings, and configured context limits without introducing lossy summaries or extra context-work approvals.

<area name="Honcho and native memory">

- Honcho is the primary long-term memory, with subscription reasoning through CLIProxyAPI and dedicated capped embeddings. Hermes keeps small native `MEMORY.md` and `USER.md` notes alongside Honcho and retains its native sessions.
- Every assistant turn receives bounded, current, authorized Honcho context automatically. Background workflows refresh protected context; deeper Honcho recall retrieves relevant details missing from that context. Ordinary turns do not require an unconditional Honcho reasoning call. Cached context never crosses audiences or survives revocation, representation changes, or its freshness limit as usable memory.
- Nocheh is the sole Honcho ingestion writer. Source, revision, audience, generation, and chunk receipts support reconciliation. An uncertain write is reconciled from evidence; absence of confirmation is not permission to resend blindly.
- Every Honcho reasoning or embedding attempt is bound to a current authorized workspace and prepared representation. Retired workspaces and unbound jobs fail closed. Agent processes do not receive Honcho credentials or a direct route around the Nocheh gateway.
- Attachment and detachment are explicit owner operations. Attachment requires accepted live reasoning, embeddings, ingestion, retrieval, restart, and failure checks. Detachment preserves source data, owner edits, and receipts.
- Reattachment rebuilds previously learned sources in the selected representation. Optional catch-up includes consented sources received while detached; optional history includes older consented sources. Neither option grants learning consent.
- Outages and rebuilds expose limited-memory status while preserving available current context, native notes, and archive search. Honcho memory can be rebuilt from owned sources and receipts.
- Incremental synchronization reports its progress separately from memory availability. Previously ready memory in the current authorized generation stays available while new sources are processed; initial builds, replacement generations, and actual recall failures report limited memory.

</area>
</area>

<area name="Providers and transcription">

- Reasoning uses ChatGPT subscription authentication. No local models, paid reasoning API keys, paid reasoning fallback, or unrelated provider credentials are used.
- One pinned CLIProxyAPI service owns the shared ChatGPT login and is its sole OAuth writer and refresh owner. Hermes, Honcho, and trusted preparation use distinct scoped internal client keys. Fresh shared-provider login does not copy another application's OAuth store.
- The provider uses one credential with no provider/model fallback, quota switching, or additional proxy request retries. Refreshing a credential does not exempt a repeated model request from Nocheh's per-attempt enforcement.
- Automatic transcription uses the pinned `codex-asr` subscription speech route and is required for release. A trusted speech boundary can read the shared provider's current access token, but cannot receive the refresh token, write the OAuth store, or expose tokens to an agent.
- Shared-provider cutover requires live reasoning, refresh, literal detection, transcription, monitoring, and recovery acceptance. Exactly one provider refresh authority is active; rollback credentials are inactive when the shared route is active.
- Dedicated paid embeddings are the sole production exception to subscription-only models: a $5 total pilot cap, followed by a $5 cap per UTC calendar month. A durable admission ledger reserves spending before bounded requests, retains conservative reservations after failures, and cannot reset through restart, restore, or repeated monthly activation.
- The dedicated OpenAI embedding provider and model are explicit configuration. The default model is `text-embedding-3-small` with 1536 dimensions; selecting `text-embedding-3-large` also uses 1536 dimensions. Vectors from incompatible models are not silently mixed; model changes require rebuilding affected memory. The paid key is confined to the metered boundary.

<area name="Monitoring">

- Pinned CPA Manager Plus Full Mode runs as a separate service behind the Nocheh owner session. It shows request history, usage, latency, failures, and account/quota observations. Provider/admin keys stay server-side; automatic credential actions, external notifications, and request-body logging are disabled. Monitoring failure does not block inference.
- Service monitoring identifies each tool, purpose, host/container location, and expected running, completed, optional-stopped, or unhealthy state. API, capture, and Inngest connectivity are reported independently; process availability does not establish processing progress.
- Nocheh monitoring exposes observed Telegram polling progress and incidents, recent workflows, retries, waiting, success, skips, failures, uncertain delivery, provider routes, and service state. A fatal polling failure cannot remain reported as connected; retryable fatal adapter failures enter supervised recovery.
- Host OAuth callbacks are temporary and state-validated. Login status is observable without exposing credential values.
- Internal API keys are labeled with their service name and usage. Hermes, Honcho, and preparation show their shared ChatGPT login without implying separate subscription accounts.

</area>
</area>

<area name="Runtime integration">

- Hermes supplies its native Telegram adapter, agent, tools, profiles, sessions, and built-in memory. Custom integration stays thin; minimal pinned compatibility patches support durable capture and mandatory enforcement.
- Native protocols and identifiers remain behind capability-checked runtime operations. Native pages and operations use actual runtime state; unavailable capabilities are explicit.
- Telegram, browser, and scheduled turns use the same managed capture, audience, guard, and tool-policy boundaries. One supervisor owns Telegram polling and scheduler lifecycle. Profile locks prevent concurrent native-memory and conversation writers. A busy profile defers work before execution; waiting preserves the same execution identity and remains cancellable, with current permissions checked before admission.
- Background native memory review waits for a short quiet interval after foreground activity so immediate follow-up messages can use the profile. Waiting does not consume an execution attempt or replace existing review receipts.
- Browser input defaults to owner-private scope; explicit group selection remains group-scoped through capture, tools, sessions, and memory. Reconnect and resume reuse stable stored identities and profile-bound sessions without duplicate submission.
- Durable claims, leases, heartbeats, and result receipts distinguish completion, interruption, and late evidence. Lost responses are reconciled; abandoned work is not automatically rerun as a new external effect.
- Runtime operations provide asynchronous `run.start`, `run.events`, `run.resume`, and `run.cancel` for Telegram, browser, and scheduled channels. Resume reconciles the same execution identity and preserves browser streaming, reconnect, cancellation, and session identities.
- Useful proactive conversation is permitted in selected Telegram groups. Intentional silence is a valid captured outcome. Group participants cannot approve actions or change administrative, provider, privacy, or guard settings.

<area name="Security and controlled tools">

- A runtime-independent external security service owns the versioned policy and broker contract. Only trusted infrastructure holds provider credentials and provisions isolated turns. Agent containers receive one profile and scoped broker/archive capabilities, not refresh stores, master service credentials, Docker access, or unrestricted egress.
- The trusted dashboard and executor containers have Docker-socket access for backups, restarts, monitoring, and approved isolated tools. This administration authority is outside agent isolation; agents and tool sandboxes receive no Docker socket.
- Explicit denies and mandatory boundaries take precedence over approvals and grants. Policy configuration, previews, and grants are owner-controlled with optimistic revisions; agent-supplied claims have no authority. Routine authorized context work needs no confirmation, and successful routine activity is quiet by default.
- Other external effects require exact owner approval or a matching bounded, expiring, revocable standing permission. The default is review each action. No auto-trading is permitted.
- Shell, browser, and MCP proposals bind immutable arguments, source event, profile, and scope. Dashboard and owner-private Telegram decisions use the same approval records. Revocation and authority are rechecked before execution starts.
- Controlled shell work runs outside the credentialed agent in disposable containers with only the scoped workspace, no network, credentials, or Docker socket, a read-only root, and bounded resources. The host does not interpret agent-supplied shell commands itself.
- Remote tool operations use approved public HTTPS destinations, pinned DNS resolution, no redirects or ambient credentials, and bounded responses. Browser inspection renders approved content offline; scripts and secondary requests cannot expand permission. MCP supports bounded HTTP JSON-RPC calls without local sampling, roots, elicitation, arbitrary local processes, or interactive authentication.
- Decision and effect records distinguish proposal, authorization, execution start, and observed result. An allow decision is not a receipt. Logs retain safe identities, revisions, and reasons without prompts, credentials, raw URLs, or memory contents.
- Uncertain effects are not automatically repeated. Revocation cannot undo an already transmitted effect. Security-service failure or replacement cannot open an unguarded fallback; activation requires acceptance of both isolation and memory/quality preservation. The trusted launcher and host are outside the agent isolation guarantee.

</area>

<area name="Scheduling">

- Hermes owns native profile schedule definitions, parsing, editing, cadence calculation, revision checks, occurrence accounting, and session history. Inngest durable waits coordinate scheduled occurrences under Nocheh's single execution authority. Definitions and each scheduled or explicit manual fire are captured before managed execution, with stable identities and separate generated results.
- Schedule configuration shares global/profile/job preference inheritance. Profile locks prevent overlapping browser, Telegram, and scheduled turns. Scheduled tools obey the same approvals and executor settings as other turns.
- Results default to local storage. Selecting Telegram produces an exact approval proposal for each completed result in that job's selected scope. Empty, cancelled, interrupted, overlong, or stale-audience results are not implicit deliveries.
- Owner-private and selected-group schedules support native schedule fields, conflict revisions, cancellation, run limits, and explicit catch-up. Topic schedules and interactive/script/skill jobs are outside the supported capability.
- Occurrences more than 60 seconds late are recorded as missed, including skipped ranges. Catch-up is explicit, never automatic; overlapping slots are skipped. Observed slots and missed ranges consume repeats, manual/catch-up runs do not, and intervals retain their original cadence after downtime.
- Pause prevents future starts; cancellation requests interruption without undoing completed effects. Crashes reconcile stored receipts without repeating uncertain execution. Restored schedulers are inactive.

</area>
</area>

<area name="Workflow orchestration">

- All product workflows use local Inngest: Telegram attachment retrieval, transcription, guarded preparation and dispatch; confirmed imports; native memory review and Honcho synchronization, rebuilding and reconciliation; browser turns; scheduled occurrences; and approved actions. Synchronous security checks and the native agent's internal reasoning loop retain their own boundaries.
- Inngest and persistent Redis run in the installation's Docker Compose project. Inngest has a dedicated database and role in the existing PostgreSQL instance, separate from the owned archive. TypeScript Connect workers have distinct application and executor identities and versions; Python adapters remain thin. Inngest Cloud and VPS deployment are outside this local workflow architecture.
- `nocheh-app` initializes the dedicated Inngest database and role before becoming healthy. Initialization preserves existing data and runs safely on repeated startup; no separate database initialization service is required. Inngest starts after the application and Redis are healthy, while application startup remains independent of Inngest availability.
- Fresh installations use isolated Hermes execution, the shared provider route, and evidence-based memory context; saved provider credentials and accepted cutovers retain their boundaries.
- Inngest is the only Nocheh workflow execution engine. Preparation is an explicit prerequisite; Telegram, browser, and scheduled runs consume stored preparation results. Legacy runners and engine-switch controls are absent. Synchronous security and native tool internals retain their own execution boundaries.
- Each workflow request or relevant state change commits an outbox record in the same archive transaction. A supervised publisher retries delivery independently of Inngest. Source capture and spool draining continue during orchestration outages.
- Inngest events, step outputs, errors, and logs contain only opaque IDs, versions, counts, timestamps, and allowlisted status codes. Messages, transcripts, prompts, results, tool arguments, and credentials stay in protected stores and are resolved inside executing steps.
- Nocheh owns the workflow registry linking source/job IDs, workflow versions, Inngest runs, attempts, and receipts. Permanent deduplication does not depend on Inngest's finite event-deduplication window. Each workflow family has one fenced execution authority.
- Inngest owns retry timing. Prerequisite waits are distinct from failed attempts; profile locks and bounded concurrency apply. Current audience, guarded revisions, import consent, and permissions are checked before execution. Terminal, cancelled, denied, suppressed, and ambiguous outcomes cannot automatically restart. Lost responses and uncertain effects require receipt reconciliation, never blind replacement execution.
- Telegram processing and delivery form one receipt-protected native runtime operation with separately visible assistant and delivery progress. Stored transcripts and guarded revisions are reusable. Intentional silence is a valid outcome; uncertain sends stop for reconciliation.
- Confirmed imports use bounded checkpointed batches, preserve upload validation, mapping, identities, progress, cancellation, and explicit learning consent across retries, and send no historical replies. Source preparation, owner edits, consent, and memory generation changes request the appropriate follow-up work. Honcho execution requires its existing attachment and acceptance gates.
- Workflow list/detail and validated retry/cancel operations are available at `/api/nocheh/workflows` and through the CLI, preserving existing job IDs, browser protocols, and compatibility routes. Nocheh shows family/status filters, stage, attempts, next retry, waiting reason, timestamps, source links, outbox backlog, oldest waiting work, connectivity, and stale observations with accessible status text and ten-second refresh.
- Nocheh Monitoring opens with a compact operational summary: running, waiting, failed, last recorded success, and backlog, with expandable details and an obvious **Open Inngest** link. Summary totals cover all workflow families independently of history filters and pagination. Unavailable or stale observations and uncertain outcomes stay visible in the compact view.
- The detailed Inngest UI is inspection-only behind the Nocheh owner session; execution controls use Nocheh authorization. Monitoring distinguishes retryable and terminal failure, waiting, intentional skip, cancellation, and uncertain effect. No external workflow notifications are sent.

</area>

<area name="Dashboard and CLI">

- Nocheh loads independently at `/` and owns overview, archive, imports, memory, graph, activity/approvals, integrations, settings, monitoring, and maintenance. It starts when Hermes is unavailable.
- The complete native Hermes page opens at `/hermes/` with a return link to Nocheh. Authenticated HTTP and WebSocket proxying supports native navigation, chat, profiles, sessions, files, models, preferences, skills/plugins/MCP, cron, channels, and supervised system controls where their capability contract is satisfied.
- The primary owner API is `/api/nocheh/*`; `/api/plugins/nocheh/*` and `/nocheh` bookmarks remain compatible. Existing shell/CLI commands remain available. CLI and UI share validated operations, revisions, and job identities, with structured output, pagination, and meaningful failures.
- Owner authentication and cross-site protections apply to browser APIs and downloads. Internal and provider credentials never enter browser storage. Inspection is side-effect-free; merely reading native profiles, jobs, or memory does not create or repair them.
- The owner can inspect originals and derived records, edit guarded copies, run resumable imports, inspect native notes and sessions, manage memory sharing and review, decide approvals, and perform diagnosed backup/recovery operations. Unavailable services and missing provenance are explicit.
- Settings have global defaults, profile overrides, and job overrides, with effective values, provenance, and apply timing. Shared validation and revision checks prevent stale writes; failed apply operations leave a recoverable configuration. Native preferences are preserved across turns and cannot widen managed scope bindings.
- The ignored root `.env` owns local deployment settings and internal secrets; native preferences stay in native stores and OAuth stays with its active refresh authority. Initialization is idempotent, preserves existing credentials, and exposes a credential-free example. Secret inputs use hidden prompts or stdin, and responses show presence rather than values.
- An isolated environment has its own explicit configuration and credentials. New profiles default to owner-private. Native lifecycle controls use Nocheh's supervisor and cannot create a second poller, scheduler, or refresh authority.

<area name="Dashboard design and visualization">

- The entire Nocheh dashboard uses Radix-based shadcn/ui, Recharts, Tailwind CSS, and Lucide icons, with pinned npm dependencies. React, esbuild, and the existing server remain the frontend foundation; page components, shared controls, and data hooks use a separate browser TypeScript configuration.
- The dashboard uses neutral surfaces, teal accents, restrained borders, readable system fonts, and tabular numerals. Adaptive light/dark themes follow the system by default, with a persisted light/dark/system selector. Hermes and CPA supply compact-navigation, persistent-status, metric-card, and health-summary design references and retain their native interfaces.
- Shared buttons, badges, alerts, tables, tabs, dialogs, drawers, progress indicators, skeletons, and empty states provide consistent feedback. Status uses text, icon, and color: green for confirmed success, blue for active work, amber for waiting/recovery/uncertainty, red for failure, and neutral for disabled/skipped/unknown. Stale observations are distinct from actual failures; domain-specific meanings remain visible.
- Grouped navigation has icons and a collapsible desktop sidebar, with a navigation drawer below 1024 pixels. Existing routes, bookmarks, and integration links remain usable. Charts and the Three.js graph load lazily. Shared polling cancels obsolete requests; refresh does not remount pages or discard form edits.
- Overview shows a compact health strip, archive/workflow metrics, a 24-hour activity chart, attention items, and common-task shortcuts. Explanatory prose is expandable. Monitoring places historical charts beneath its compact global summary and keeps service badges and expandable diagnostics.
- Workflow details use a paginated table showing family, status, stage, attempts, and timing, with receipts and authorized controls in an accessible details drawer. Archive and memory use consistent search/filter toolbars, clear metadata, and responsive list/detail layouts distinguishing originals, guarded copies, generated notes, and provenance.
- Honcho and integrations distinguish connection, memory availability, synchronization progress, and capabilities. Labeled progress bars require known totals. Imports and maintenance show steps, progress, badges, and compact history while preserving consent, resume behavior, and operation reviews. Activity separates approvals, permissions, and run history with tabs. Settings preserve revision checks and inline feedback. Technical JSON is available under explicit detail disclosures.
- Owner-authenticated workflow metrics at `/api/nocheh/workflows/metrics`, its legacy owner API alias, and `/v1/workflows/metrics` return bounded aggregates with observation time, bucket boundaries, admission/completion/terminal-failure counts, completion-duration p50/p95, and sample counts. Each persisted workflow identity is counted once; admissions use `created_at`, and confirmed outcomes use registry state and `updated_at`. Domain completion alone is not confirmed orchestration completion.
- Historical charts default to 24 hours with hourly buckets and offer seven days with six-hour buckets. Buckets use UTC; display identifies the browser timezone. Completion duration means admission to confirmed completion, including waits and retries. Activity lines, outcome bars, duration charts, and a current workload-by-family bar chart show distinct measures. Chart family filters do not change global summary totals.
- Current status refreshes every ten seconds and historical aggregates every sixty seconds; manual refresh updates both. Failed refreshes retain prior observations with stale warnings. Observed zero activity, unavailable data, and missing duration samples are distinct. Charts include legends, accessible tooltips, and a data-table alternative. Historical metrics use existing PostgreSQL records without a sampling service or inferred queue-depth/uptime history; detailed provider analytics remain in CPA.
- Dashboard controls and visualizations support keyboard navigation, focus restoration, readable contrast, reduced motion, mobile layouts, and both themes. The evidence graph retains source inspection and its non-WebGL fallback.

</area>

<area name="Evidence graph">

- The product graph is a deterministic, scoped view of original identities, authorship, replies, revisions, files, derived provenance, and explicit native-note citations. It does not invent source support for notes or store layout positions as facts. Nodes and edges enforce the same audience boundaries.
- A locally bundled, lazy-loaded Three.js view supports orbit, pan, zoom, focus, search, source inspection, pagination, and optional full screen. It renders on demand, limits rendering resolution, disposes resources, and never auto-rotates.
- A keyboard-accessible node browser and evidence inspector are available without WebGL. Observed and generated/citation links are distinct. Graph JSON and original-source exports preserve the underlying records. The graph requires neither model calls nor an additional graph database.

</area>
</area>

<area name="Operations and acceptance">

- Backups quiesce ingress before writers and preserve PostgreSQL records, originals, files, durable journals/receipts, native state, configuration, and a conservative spending-ledger snapshot. Checksums and table fingerprints verify recovery; rebuildable dependency caches are explicitly excluded.
- Backups include Inngest PostgreSQL history and Redis queue/run state at the same quiesced recovery point as Nocheh evidence. Restored workers, schedules, and event publication remain inactive. Backup, restore, and service shutdown execute through containerized management independently of Inngest, with maintenance progress visible in Nocheh.
- Restore uses a separate project and state directory with Telegram disabled, OAuth held inactive, and archive workers, tool execution, scheduling, and Honcho attachment held. Restore does not activate services or reset a newer spending ledger.
- Recovery cutover reconciles snapshot-era pending work with source evidence and shuts down source authorities before activation. Rollback uses the matching code/images and a verified inactive snapshot, never an older runtime against a newer live database.
- Candidate compatibility checks build pinned runtime/native assets in isolation without live state, credentials, or test network. They do not activate candidates or change saved pins. Upgrade acceptance covers capture, guards, audience access, approvals, native memory, restore, and single-authority operation.
- Release acceptance includes real subscription chat, literal detection, Ogg/Opus transcription, refresh/quota/failure handling, and local Compose recovery. Real Telegram acceptance covers owner replies, selected-group behavior and intentional silence, private/group isolation, original voice bytes and derived transcripts, exact owner approval, and reconnect/restart without duplicate effects.
- Missing credentials, unrun checks, or healthy containers do not establish acceptance. Provider cutover, Honcho activation, and release have separate gates; Git integration is not activation. The isolated synthetic Honcho comparison is optional and does not block production release. Its explicitly configured embedding requests have a durable $5 total experiment cap across runs.
- Validation evidence excludes real conversations and credentials. Measurements distinguish deterministic preservation/enforcement from finite observations of detection, privacy filtering, memory quality, and latency.

</area>
</area>

</specs>
