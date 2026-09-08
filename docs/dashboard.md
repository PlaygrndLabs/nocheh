# Owner dashboard and CLI

Start the archive with `./scripts/nocheh up`. With Node 22+ and Python 3 available
locally, install the repository's locked development dependencies using `npm ci`,
then run:

```sh
./scripts/nocheh dashboard
./scripts/nocheh dashboard --no-open
./scripts/nocheh dashboard --stop
```

Nocheh opens at <http://127.0.0.1:8783/>. It owns the application and owner API.
Open Hermes from the sidebar for its dedicated native dashboard at `/hermes/`;
its return link brings you back to Nocheh. Old `/nocheh#…` bookmarks still work.

The launcher starts Nocheh before building the optional native page. If Hermes is
unavailable, the Nocheh archive/import/maintenance screens remain accessible.
The owner API runs locally and does not expose a Docker socket to containers.
Native assets use the pinned upstream lockfile. Stop and start to rebuild updates.

## Find the right page

| Page | Use it for |
| --- | --- |
| Overview | Start common tasks and understand the archive, Hermes memory and Honcho. |
| Archive | Search original messages and generated transcripts, then open source records and files. |
| Memory | Read general notes, user profile notes and native conversation history for one chat. |
| Graph | Follow recorded relationships back to their source evidence. |
| Activity | Follow browser inputs, completed results and interruptions; open their original sources. |
| Imports | Choose a Telegram export, review access and files, then start or resume an import. |
| Settings → Nocheh settings | Manage Telegram access, model routing and guarding across the installation. Review, save, then apply to running services. |
| Settings → Hermes preferences | Tune supported agent and memory preferences for one profile. Saves take effect on its next turn. |
| Maintenance | Check health, prepare archive downloads, create backups, restart or verify an inactive restore; inspect settings-apply results. |
| Integrations | Inspect runtime status and capabilities, or open the native Hermes dashboard. |
| Honcho lab | Check the optional experiment and browse its stored data when it is running. |

Nocheh is the main product. Hermes provides the Telegram adapter, assistant runtime,
tools, profiles and memory through an integration. Nocheh owns capture, access rules,
guarding and approvals. Native execution and administration remain restricted until
their integration acceptance passes; see TASK.md for actual phase status.

Original chats are preserved evidence. Native notes are generated working memory
and may change. Imported messages become archive sources, not native sessions or
automatically generated memory. At import confirmation, an unchecked option lets you approve a Hermes memory review after ingestion succeeds. Honcho remains separate from production memory.

## Change configuration

Settings show saved `.env` values with credential presence only. Review and Save
validates the complete configuration. Apply is a background job that recreates
affected Compose services and checks health; failed apply attempts restore the
previous environment and report whether recovery succeeded. Runtime state is
shown as unverified until the management apply operation verifies it.

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
./scripts/nocheh config set NOCHEH_GUARD_MODE auto
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
retrievable. Original images may reach explicitly trusted routes; required guarding
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

Honcho lifecycle (`init`, `up`, `down`, `status`, `login`) delegates to the existing
experiment. Initialize it before `honcho install`. Inspection uses official
`honcho-cli==0.1.4` / `honcho-ai==2.4.0`, pinned dependencies and an internal-only
Compose runner with a fresh CLI config directory. Ambient Honcho accounts are
ignored. A narrow transport changes SDK get-or-create lookups into exact-ID list
queries and rejects writes, model-backed search/chat and unexpected endpoints.
Missing resources remain missing. Stored representation retrieval has no search
query; it does not request embeddings. Native list commands walk pages; the
wrapper caps at 100 pages and reports failure rather than silently exporting an
incomplete collection. `complete` refers to the requested command/limit, with
server pagination metadata retained. Inspect is a summary, not a full export.

The dashboard shows experiment availability and workspace/peer/session lists.
The CLI provides deeper stored-data inspection. Live compatibility with the pinned
Honcho server remains pending the separate bridge login and temporary embedding
credential; fixture tests do not certify that live comparison. No experiment
inference or production-memory switch is performed by the dashboard.

## Evidence graph and local operations

Graph defaults to all private knowledge; you can select one archive scope. It pages through 20 events at a time and includes up to 20 native profiles per page. It includes
observed authorship, replies to original source IDs, same-source revisions,
attachments, derived-artifact provenance, and explicit Hermes note references.
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

Search the node browser or choose a type, then select a node in the list or scene
to highlight its direct connections. The inspector shows incoming/outgoing
relationships and opens original sources. A deterministic spatial layout helps
navigation; distance is not a semantic assertion. Shapes, colors, labels and
dashed citation/derived links distinguish the evidence types. If WebGL is
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

**Settings → Policy defaults** edits global preference defaults. **Hermes
preferences** shows each effective value's origin and can remove a profile override
with **Inherit global value**. Existing native values remain explicit overrides.
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
