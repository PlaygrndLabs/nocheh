<dashboard>

# Owner dashboard and CLI

Start the archive with `./scripts/nocheh up`. With pinned Node 24 and Python 3 available
locally, install the repository's locked development dependencies using `npm ci`,
then run:

```sh
./scripts/nocheh dashboard
./scripts/nocheh dashboard --no-open
./scripts/nocheh dashboard --stop
```

Nocheh opens at <http://127.0.0.1:8783/>. It owns the application and owner API.
Open Hermes from the sidebar for its dedicated native dashboard at `/hermes/nocheh`;
its return link brings you back to Nocheh. Old `/nocheh#…` bookmarks still work.
Open CPA dashboard from the sidebar for the CPA Manager Plus Full Mode UI at
`/providers/management.html`; it reuses the Nocheh owner session and keeps all
provider credentials server-side.

The launcher starts Nocheh before building the optional native page. If Hermes is
unavailable, the Nocheh archive/import/maintenance screens remain accessible.
The owner API runs locally. Docker administration access is confined to trusted
management services; agents and tool sandboxes receive no Docker socket.
All containers, including the native dashboard, belong to the `nocheh` Compose
project. Native assets use the pinned upstream lockfile. Stop and start to rebuild
updates; `dashboard --stop` stops only the dashboard service and owner server.

## Find the right page

| Page | Use it for |
| --- | --- |
| Overview | Read system health, archive/workflow metrics, attention items and 24-hour activity; start common tasks. |
| Monitoring | Read five global workflow totals, history charts, service diagnostics, and paginated receipts; open Inngest. |
| Memory access | Review audience policy, shared knowledge, recall previews, and learning jobs in separate tabs. |
| Archive | Browse originals, guarded copies and transcripts; edit guarded wording and inspect history or original files. |
| Memory | Read general notes, user profile notes and native conversation history for one chat. |
| Graph | Follow recorded relationships back to their source evidence. |
| Activity | Review exact approvals, bounded permissions, and run history in separate tabs; inspect original evidence. |
| Imports | Choose a Telegram export, review access and files, then start or resume an import. |
| Settings → Nocheh settings | Manage Telegram access, model routing and guarding across the installation. Review, save, then apply to running services. |
| Settings → Hermes preferences | Tune supported agent and memory preferences for one profile. Saves take effect on its next turn. |
| Maintenance | Check health, prepare archive downloads, create backups, restart or verify an inactive restore; inspect settings-apply results. |
| Integrations | Inspect runtime status and capabilities, or open Hermes and provider monitoring. |
| Honcho memory | Inspect primary-memory readiness, attachment, generations and receipts, plus stored Honcho data. |

Nocheh is the main product. Hermes provides the Telegram adapter, assistant runtime,
tools, profiles and memory through an integration. Nocheh owns capture, access rules,
guarding and approvals. Native execution and administration remain restricted until
their integration acceptance passes; see TASK.md for actual phase status.

Original chats are preserved evidence. Native notes are generated working memory
and may change. Imported messages become archive sources, not native sessions or
automatically generated memory. At import confirmation, checking the optional learning control grants
learning consent. That permits native note review and Honcho ingestion when attached;
preparing guarded copies alone grants no learning consent. Honcho stays detached
until its real provider acceptance passes.

## Change configuration

Settings show saved `.env` values with credential presence only. Review and Save
validates the complete configuration. Apply is a background job that recreates
affected Compose services and checks health; failed apply attempts restore the
previous environment and report whether recovery succeeded. Runtime state is
shown as unverified until the management apply operation verifies it.
The page shows these actions directly without a numbered progress strip.

Imports accept Telegram Desktop JSON, an export directory or ZIP. Review counts,
missing media and chat scopes before starting. Unmapped chats remain owner-only.
Explicit group mapping shares history with that group. The original export JSON
is preserved as an archive artifact with a batch manifest. Media and message
payloads reuse the existing archive importer unchanged. Imports send no old
replies and do not automatically run memory derivation.

Jobs retain progress under the private `data/local/admin/jobs/` directory. Stop
or interrupted jobs can resume; already committed sources remain preserved.
Upload limits are 32 MiB export JSON, 50 MiB per media file, 256 MiB uploaded ZIP,
512 MiB total unpacked/uploaded content and 10,000 files. The old import commands
remain supported alongside these conveniences:

```sh
./scripts/nocheh config show
./scripts/nocheh config set NOCHEH_GUARD_MODE on
./scripts/nocheh config apply
./scripts/nocheh import telegram /absolute/export/result.json
./scripts/nocheh jobs list
./scripts/nocheh jobs show JOB_ID
```

Secret settings take a hidden prompt or piped stdin, never a value in argv.
The dashboard owner session is separate from the archive service credential and
Hermes OAuth. No remote login is implemented; ports bind only to localhost.
The browser receives a separate HttpOnly owner session and CSRF value. Native HTTP
and one-use, 30-second WebSocket tickets are checked by Nocheh before proxying.
Internal backend credentials are not injected into native pages. Existing CLI
headers remain compatible; download-only cookies cannot administer settings.

## Native browser chat

Open Hermes → Chat. The context banner identifies the owner-private default or
selected group profile. Changing the native profile selector changes the scope of
archive retrieval, native sessions and memory. Chat does not send replies to Telegram.
The terminal, its model turn and the sidebar metadata connection have distinct roles;
only the managed turn runner can invoke a model.

Submitted text and up to 10 files (25 MiB total) are archived before execution.
Voice attachments use automatic subscription transcription; bounded UTF-8 files
(up to 200 kB each, 1 MB total) are included as context. Other binary files remain
retrievable. Original images remain owner-only while guarding is on; required guarding
rejects opaque image context. Generated results and transcripts retain provenance.

Native Sessions can resume a conversation in its profile. Cancel stops the isolated
model process. Reload reconnects to the same live terminal. After a service restart,
a recorded run can be completed, failed or interrupted; it is never automatically
executed again. Activity shows the latest 50 browser inputs and their source/result.
An explicit retry creates another observed input. Local UI commands appear as
“Captured only” because they do not start a model turn.

The current tool set is memory, scoped native session search, archive retrieval and
external-action proposals. Broader shell/browser/MCP execution and cron remain in
their following phases. Local wake-word models and arbitrary TUI gateway commands
are disabled. See [ADR-0028](adr/0028-isolated-native-browser-turns.md) for the boundary.

## Native memory and Honcho

Hermes memory lists configured and historical group/topic profiles. Notes are read-only;
preferences in Settings → Hermes preferences use the same locked resolver as assistant startup and take effect on
the next turn. Session messages are paginated in groups of 50, with a 20,000
character preview per message. Notes are bounded to 256 KiB and explicitly show
truncation. A note's presence does not establish source provenance.

```sh
./scripts/nocheh memory list
./scripts/nocheh memory show --scope CHAT_ID
./scripts/nocheh memory show --scope CHAT_OR_TOPIC --profile NATIVE_PROFILE_ID
./scripts/nocheh memory show --scope CHAT_ID --session SESSION_ID --offset 50
./scripts/nocheh memory preferences --scope CHAT_ID
./scripts/nocheh honcho doctor
./scripts/nocheh honcho install
./scripts/nocheh honcho workspace list
./scripts/nocheh honcho peer inspect PEER_ID -w WORKSPACE_ID
./scripts/nocheh honcho peer representation PEER_ID -w WORKSPACE_ID
./scripts/nocheh honcho conclusion list --observer PEER_ID -w WORKSPACE_ID
./scripts/nocheh honcho session view SESSION_ID -w WORKSPACE_ID --page 2 --size 50
./scripts/nocheh honcho session view SESSION_ID -w WORKSPACE_ID --all > transcript.json
```

Honcho lifecycle (`init`, `up`, `down`, `status`, `login`) targets the installation
Compose project. Initialize its pinned source before starting Honcho. Inspection uses official
`honcho-cli==0.1.4` / `honcho-ai==2.4.0`, pinned dependencies and an internal-only
Compose runner with a fresh CLI config directory. Ambient Honcho accounts are
ignored. A narrow transport changes SDK get-or-create lookups into exact-ID list
queries and rejects writes, model-backed search/chat and unexpected endpoints.
Missing resources remain missing. Stored representation retrieval has no search
query; it does not request embeddings. Native list commands walk pages; the
wrapper caps at 100 pages and reports failure rather than silently exporting an
incomplete collection. `complete` refers to the requested command/limit, with
server pagination metadata retained. Inspect is a summary, not a full export.

The dashboard shows live-gate status, attachment, current memory generations and
receipts alongside workspace/peer/session lists. Attach remains disabled until
provider acceptance passes. After acceptance, owner attach/detach controls
offer optional consented history and catch-up. The CLI provides deeper stored-data
inspection. See [the current memory system](guarded-memory-system.md) for activation
and budget instructions; fixture tests do not certify live provider behavior.

## Evidence graph and local operations

Graph defaults to all private knowledge; you can select one archive scope. It pages
through 20 messages at a time. The only node types are users, projects, groups,
and messages. It includes recorded authorship, replies to original source IDs,
same-source revisions, and explicit group-to-project assignments. Actions, events,
runtime context, files, generated artifacts, Hermes profiles, and memory notes are
excluded from both the visual graph and its JSON export. Messages without display
text use their source kind and a stable short message ID instead of sharing an
indistinguishable placeholder. Telegram users use their recorded `@username` or
display name, groups use their recorded chat title, and private conversations are
shown as type `Private chat`, never `Group`. They are labeled `Private chat · @username`,
the recorded display name, or the numeric Telegram ID when the original observation
contains no name.
Original chat identity remains part of an imported message's identity even when
multiple Desktop exports are mapped into one scope. Group-scoped API credentials
cannot request a different scope. Citations outside the current page or scope do
not create an edge; uncited memory has no verified source provenance. This is a
deterministic evidence view, not semantic entity extraction or the repository's
Graphify graph.

The graph uses a local Three.js 3D scene. Drag to orbit, scroll to zoom, and
right-drag to pan; on touch screens use one finger to orbit and two to pan/pinch.
Camera buttons offer orbit/zoom/reset, selected-node focus and full screen where
supported. With the scene focused, arrow keys orbit, Shift+arrows pan, +/- zoom,
and Home resets. No automatic rotation or ongoing render loop runs while idle.

Search the node browser or choose a context-entity type, then select a node in the list or scene
to highlight its direct connections. The inspector shows incoming/outgoing
relationships and opens original sources. A deterministic spatial layout helps
navigation; distance is not a semantic assertion. Shapes, colors, and labels
distinguish the context-entity types. If WebGL is
unavailable or its context is lost, the node browser and source inspection remain
available with a reload control. The renderer is bundled locally using pinned
Three.js/esbuild versions; no CDN or additional model calls are used.

Page forward/backward or export the current graph as JSON. Source detail
includes the original record, downloadable retained files, transcripts and their
generation provenance. Use the next cursor to retrieve additional graph pages:

```sh
./scripts/nocheh memory graph --scope CHAT_ID --output graph.json
./scripts/nocheh memory graph --scope CHAT_ID --after EVENT_ID --output next-page.json
```

Maintenance provides diagnostics, portable archive ZIP export, consistent backup,
service restart, and restore into a new inactive Compose project. Backup and
restart show a review step. Restore selects a locally generated backup ID and an
unused loopback port; it cannot overwrite current state. Restored Telegram stays
disabled, and the copied OAuth login stays inactive. The existing `backup`,
`restore`, `diagnose`, and `scripts/archive.py export` commands remain available.

Jobs, downloads, exports, backups and inactive restores are private files under
`data/local/admin/` (or the selected `NOCHEH_STATE_DIR`). The UI streams downloads
through owner authentication. A session-only HttpOnly, SameSite=Strict cookie is
accepted only on file/export download routes; settings and mutations still require
the native owner session header. Cross-origin requests remain denied. Jobs show errors and survive manager restarts;
interrupted non-import operations require a new job, while imports can resume.
The manager excludes imports/config writes while an operation runs. Preference
inspection is read-only. Avoid separately running CLI mutations during a dashboard
backup. A portable export walks available records; use Backup for a consistent
snapshot of the database, files and native runtime state.

Backups may briefly pause the bot while its writers stop and resume. A failed
restore can leave a separate, inactive project/state directory for diagnosis;
it never activates the restored credentials automatically. Read/import subprocesses have a 15-minute limit. Lifecycle operations finish
their cleanup before a graceful shutdown; dashboard stop refuses while one runs.
An OS crash or forced kill can still leave interrupted work requiring diagnosis. Export
and backup files are retained until the owner removes them.

## Native administration and inherited preferences (P3)

The native page now reads actual Hermes profiles and sessions from the running
runtime. Its separate administration process owns no Telegram poller, scheduler,
agent, or subscription refresh. Nocheh proxies its authenticated API separately from
the presentation assets. The internal API binds on loopback at archive port + 5
(8785 by default); restored installations derive their own port.

Native Config and Nocheh Settings share the same writer for the five current agent
and memory preferences. Config revisions include inherited policy state: a stale
native form or CLI writer is rejected after either a profile or global change.
Unknown native fields are retained; credentials are redacted and managed routing,
tools, provider authentication and scope bindings cannot be changed by native forms.
Raw YAML inspection is read-only. Nocheh Settings retains the deployment model,
Telegram and guard/trust settings with its existing save/apply behavior.

**Settings → Hermes preferences** shows profile preferences and global Hermes defaults
together. Each profile preference shows its effective origin and has a reset icon
beside its input; resetting removes the profile override after saving so the global
value applies. Existing native values remain explicit overrides. Nocheh settings
shows `****` for a configured Telegram bot token without exposing its value and explains
that an empty selected group list still permits owner private messages.
Job preference overrides can be stored via CLI; scheduler execution is P6 work.
Broader tool and approval policy controls are P5 work, not active capabilities yet.

```sh
./scripts/nocheh runtime profiles
./scripts/nocheh runtime status
./scripts/nocheh runtime show --profile PROFILE
./scripts/nocheh policy show
./scripts/nocheh policy show --profile PROFILE
./scripts/nocheh policy set agent.max_iterations 8
./scripts/nocheh policy inherit agent.max_iterations --profile PROFILE
./scripts/nocheh policy set agent.max_iterations 4 --job JOB_ID
```

Pass `--revision REVISION` to conditional CLI writes. Native profiles created here
are owner-private and do not clone credentials. Their rename and removal controls
preserve managed Telegram bindings; removal retains their directory under
`retired-profiles` for recovery. Session inspection and changes stay within the
selected profile. Native file browsing/uploads are confined to that profile's
workspace, including symlink checks. These workspace files are not chat imports;
chat attachment capture is part of P4. Native session imports remain gated: use
Nocheh Imports to preserve originals and provenance.

Inspection does not bootstrap, migrate or auto-archive a session database. SQLite
can create its normal WAL/locking sidecars during a read-only connection. It does
not change session contents, notes or configuration. Missing stores list as empty.
Unintegrated native operations return an explicit unavailable result until their
managed execution phase passes acceptance.

## Tools and approvals

**Activity → Approvals** shows the complete command, page URL or MCP arguments,
the originating profile and scope, and the eventual execution result. Approve or
deny each operation there or in your private Telegram DM with `/actions`,
`/action ID`, `/approve ID` and `/deny ID`. Group messages cannot approve actions.
Long operations require the dashboard so approval never relies on truncated text.

An optional permission allows only that exact operation in that scope/profile,
for 1–20 starts and 1–1440 minutes. Revoke it in Activity, `/revoke ID`, or the CLI.
Revocation stops future starts; it cannot undo a started operation. Ambiguous
results are retained without automatically repeating execution.

Shell runs in a disposable, network-disabled container with only the selected
workspace mounted. Browser inspection fetches one approved public HTTPS page and
renders its inert text/link structure offline. MCP supports exact public HTTPS
tool calls or discovery with JSON responses; authenticated/SSE servers, local MCP
processes and interactive browser actions remain unavailable. Global/profile
preferences can disable each tool. Enabling a tool still requires action approval.

```sh
./scripts/nocheh approvals list
./scripts/nocheh approvals show ACTION_ID
./scripts/nocheh approvals approve ACTION_ID --fingerprint DISPLAYED_FINGERPRINT
./scripts/nocheh approvals deny ACTION_ID --fingerprint DISPLAYED_FINGERPRINT
./scripts/nocheh approvals grant ACTION_ID --fingerprint DISPLAYED_FINGERPRINT --uses 3 --minutes 60
./scripts/nocheh approvals revoke PERMISSION_ID
./scripts/nocheh approvals status
```

`up` starts one approved-tool worker; `down` and backup drain it. Restored tool
workers remain inactive. Bash entrypoints and the optional Honcho CLI are retained.

## Space policies and native review

Your private assistant can recall across the entire archive and registered native
profiles. Group and topic context is constrained in storage and tools. A topic
inherits its group's settings unless you override them. `approved` is the default;
`isolated` permits only its own context; `filtered` is an explicit opt-in for
selected source spaces. Approved shares disclose the exact saved text, while
supporting original IDs remain private. Revoking a share retires old group contexts
and blocks stale in-flight delivery; it cannot retract messages already posted.

Filtered mode currently considers original archive text only and uses the ChatGPT
subscription privacy reviewer. Native-note/transcript filtering is pending explicit
owner authorization. Filtering can miss personal details; failures withhold wider
knowledge. The access preview performs no model call and shows eligible sources,
not a promise that their contents will be released.

At the final import step, **Review with Hermes to update private memory** is
unchecked. The saved choice survives cancellation/restart and cannot change on
resume. Completed imports without approval remain searchable. Review jobs use
Hermes's native memory review, with no external-action tools. Pause/resume controls
operate on queued work; an interrupted native write is marked ambiguous and needs
an explicit resume. Retrying an ambiguous review may repeat a native memory edit.

```sh
./scripts/nocheh memory spaces
./scripts/nocheh memory policy --space=-100123/topic/42
./scripts/nocheh memory policy --space=-100123/topic/42 --set policy.json --revision REVISION
./scripts/nocheh memory share --space=-100123/topic/42 --file shared.txt --revision REVISION
./scripts/nocheh memory revoke SHARE_ID --revision REVISION
./scripts/nocheh memory preview --space=-100123/topic/42 --query Juniper
./scripts/nocheh memory recall Juniper
./scripts/nocheh memory reviews
./scripts/nocheh memory pause JOB_ID
./scripts/nocheh memory resume JOB_ID
./scripts/nocheh memory review EVENT_ID --approve
./scripts/nocheh import telegram /path/to/result.json --approve-memory-review
./scripts/nocheh memory graph --scope '*' --output graph.json
```

Use the revision returned by `memory policy`; stale edits are rejected. A minimal
policy file is `{"mode":"approved"}`. Omitting a key restores inheritance; `{}`
restores all inherited settings. The existing import command without the optional
approval flag keeps imports searchable without scheduling a native review.

## Schedules

Open **Hermes → Cron** to create a prompt schedule for the owner-private profile or
one selected group. The native schedule builder supports intervals, cron expressions
and one-time schedules. Each fire starts a fresh session with that profile's memory.
Set **Run settings** to override agent steps and time for one job, or leave them
blank to inherit. Production model selection remains in Nocheh Settings.

**Local** saves results in Activity. **Telegram** proposes the exact result to that
scope for owner approval. Overlong results stay local with a visible delivery error.
Pause prevents future starts; Cancel run interrupts an active run. Runs more than
60 seconds late are recorded as missed; **Catch up once** is an explicit extra run.
It does not replay every missed interval. Original prompts and generated results
remain separately inspectable in Activity, including after deleting a schedule.

```sh
./scripts/nocheh cron list --profile all
./scripts/nocheh cron create --profile PROFILE --file job.json
./scripts/nocheh cron show JOB_ID --profile PROFILE
./scripts/nocheh cron update JOB_ID --profile PROFILE --file changes.json --revision REVISION
./scripts/nocheh cron pause JOB_ID --profile PROFILE
./scripts/nocheh cron trigger JOB_ID --profile PROFILE --request-id UNIQUE_REQUEST_ID
./scripts/nocheh cron catch-up JOB_ID --profile PROFILE --request-id UNIQUE_REQUEST_ID
./scripts/nocheh cron cancel JOB_ID --profile PROFILE
./scripts/nocheh cron runs JOB_ID --profile PROFILE
```

A minimal job file is `{"name":"Daily review","prompt":"Review today's archived notes.","schedule":"0 18 * * *","deliver":"local"}`.
The native parser uses the profile's Hermes timezone; ISO dates include their UTC
offset. Reuse the same request ID only when retrying the same manual request.
Custom skills/scripts, alternate providers and topic schedules are not enabled.

## Original and guarded versions (ADR-0033)

Archive now browses all records without requiring a search. Open a source to see
its read-only original beside the separate guarded copy, including derived text
and file metadata. Save guarded wording directly; matching copies of the message
text are updated together. Other guarded fields can be inspected and edited too.
History lets you inspect an old revision and restore it as a new owner revision.
Concurrent saves require refresh and comparison; preparation never overwrites an
owner revision. Original file downloads remain read only.

Local Compose now uses the saved guarded version when guarding is on. A synthetic
live subscription test verified import, edit, scoped retrieval and native Hermes
archive recall. See TASK.md G7 for evidence and remaining Honcho/release checks.

## System monitoring and subscription login

Open **Monitoring** (`/#monitoring`) for running, waiting and failed workflow
totals, the last confirmed workflow completion, and unpublished backlog across
all workflow families. The summary refreshes every ten seconds independently of
history filters and pagination. Unavailable data is shown explicitly; failed
refreshes retain the last snapshot with a stale-data warning.

Use **Open Inngest** for native execution history at `/inngest/runs`, behind the
same owner session. That view is read-only. Expand **Workflow details** to filter
history, inspect stages, source evidence and receipts, use authorized retry/cancel
controls, or check delivery and worker freshness. Telegram, provider, background
work and service diagnostics have their own expandable sections. Failures,
uncertain effects, disconnected workers and unhealthy services remain visible
without expanding details. A healthy container does not certify model access or
Telegram reception. **Inspect original** opens the archived evidence.

The provider panel's **OAuth Login → Codex** uses a temporary callback listener on
the host at port 1455. Start a fresh login after an expired attempt. If that port
is busy with another login, finish it first or use `./scripts/nocheh provider login`
for device authentication. Once the shared login is present, run
`./scripts/nocheh provider cutover` to validate and switch the active route.

The three API keys shown in the provider panel are generated local access keys
for Hermes, Honcho and guarded-text preparation. The management key protects the
local administration API. Neither kind is an OpenAI billing key or a substitute
for the subscription OAuth login.

<design_and_metrics>

## Appearance and workflow trends

The owner dashboard uses locally owned Radix-based components, Tailwind, Lucide,
and Recharts. Appearance follows the system by default; Light, Dark, or System
is persisted locally. The desktop sidebar collapses, and below 1024px navigation
opens in a keyboard-accessible drawer. Refresh updates data without remounting
the page. Hermes and CPA keep their native interfaces and integration links.

Monitoring retains global running, waiting, failed, last confirmed success and
unpublished backlog totals, independent of table pagination and chart filters.
Workflow history is paginated; its details drawer holds receipts, publication,
revision-aware retry/cancel, and source links. Status combines words, icons and
color. Stale worker observations are uncertainty, not proof of a failed service.

Owner-authenticated `GET /api/nocheh/workflows/metrics?range=24h|7d&family=…`
(and the legacy `/api/plugins/nocheh` alias) proxies `/v1/workflows/metrics`.
The default 24-hour range uses hourly UTC buckets; seven days uses six-hour
UTC buckets. The response includes `from`, `to`, `observed_at`, `bucket_seconds`,
`range`, `family`, and bounded `buckets`. Each bucket includes `start`, `end`,
`admitted`, `completed`, `terminal_failed`, `completion_samples`,
`completion_ms_p50`, and `completion_ms_p95`. A rolling window can have a partial
first and last bucket (at most 25 or 29); start is inclusive and end exclusive.
The browser explicitly labels its display timezone.

Admissions use registry creation time. Confirmed completed/failed registry
outcomes use confirmation update time; domain completion alone is excluded.
Registry identity prevents repeated requests or retries from double counting.
Completion duration is admission to confirmed completion, including waits and
retries. It can exceed the selected chart window. Invalid negative durations
have no sample; empty duration buckets are null, not zero. Reconciled outcomes
can move between buckets because the registry is not a historical transition log.

Current status refreshes every ten seconds, aggregates every sixty seconds, and
manual Refresh updates both. Failed refreshes retain successful observations
with a stale warning. Unavailable counts are not shown as zero. Chart legends,
keyboard tooltips and View chart data provide alternative inspection paths.
Current workload-by-family uses health counts, never historical queue depth.
Workflow summary values and label icons use blue for running, amber for waiting
and backlog, red for failures, and green for a recorded confirmed completion.
Missing or unavailable values are neutral in both themes. Zero is an observed
count in the labeled category, rather than an unavailable observation.
No sampling service, uptime claim, or provider analytics collection is added.
Detailed provider analytics remain in CPA.

Page implementations live under `web/pages/`; shared controls live in
`web/components/ui/`, while data subscriptions and revision-bound drafts live in
`web/lib/`. Browser code is checked with `tsconfig.web.json`. The build removes
obsolete chunks and emits independent chart, access-control, and Three.js bundles.
`npm run test:dashboard` covers graph behavior and request handoff/cancellation.

Archive and conversation history use list/detail views that stack on mobile.
Original sources remain read-only; guarded copies are explicitly editable, and
notes carry generated-content labels. Settings and guarded drafts keep the
revision where editing started, so Refresh cannot silently bypass a conflict.
Import consent belongs to the selected job and stays fixed when it resumes.
Maintenance reviews use focus-restoring dialogs before backup, restart or restore.

</design_and_metrics>

<synthetic_preview>

## Isolated UI acceptance preview

`compatibility/dashboard-preview-compose.yml` is a separate synthetic fixture,
not an overlay for the installation Compose file. Assign a unique project/image,
an unused localhost port, and new random credentials in a private environment file:
`NOCHEH_FIXTURE_PROJECT`, `NOCHEH_FIXTURE_IMAGE`, `NOCHEH_DASHBOARD_PORT`,
`POSTGRES_PASSWORD`, and `SERVICE_TOKEN`. Never copy installation credentials.
The fixture owns its database volume and internal database network; only its
HTTP preview bridge publishes the chosen loopback port. It has no poller,
scheduler, provider login, or external-effect executor.

From the session worktree, with `FIXTURE_ENV` pointing to that private file:

```sh
docker compose --env-file "$FIXTURE_ENV" -f compatibility/dashboard-preview-compose.yml build preview
docker compose --env-file "$FIXTURE_ENV" -f compatibility/dashboard-preview-compose.yml up --no-build preview
```

Keep the second command in the persistent preview terminal. The fixture uses real
PostgreSQL workflow aggregates and synthetic page data. Its action/settings/import
controls change only synthetic state; integration links show a fixture boundary.
For injected browser failures, `/tmp/nocheh-ui-scenario` inside that preview
container accepts `offline`, `unavailable`, `conflict`, or `no-graphics`; `normal`
restores normal behavior. Never apply these probes to installation containers.

For the existing native inspection and database bootstrap tests, combine the
preview file with `compatibility/dashboard-native-checks-compose.yml`, enable the
`native-checks` profile, and assign fresh 64-character hexadecimal
`INNGEST_POSTGRES_PASSWORD`, `INNGEST_EVENT_KEY`, and `INNGEST_SIGNING_KEY` values.
It starts pinned Inngest and Redis only on the private fixture network, without
registered runtime workers or published ports. The `checks` service runs against
that same fixture. The container-dashboard boundary test additionally requires a
separate network-isolated container with `nocheh-app`, `hermes`, and
`cliproxy-monitor` mapped to loopback and `NOCHEH_CONTAINER_TEST=1`.

</synthetic_preview>

</dashboard>
