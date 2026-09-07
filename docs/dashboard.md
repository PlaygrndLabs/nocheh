# Owner dashboard and CLI

Start the archive with `./scripts/nocheh up`. With Node 22+ and Python 3 available
locally, install the repository's locked development dependencies using `npm ci`,
then run:

```sh
./scripts/nocheh dashboard
./scripts/nocheh dashboard --no-open
./scripts/nocheh dashboard --stop
```

The dashboard is at <http://127.0.0.1:8783/nocheh>. Its native Hermes shell runs in
a separate Compose project, with a private presentation-only home and loopback
backend port 8784. The TypeScript owner API runs locally; it does not expose a
Docker socket to containers. The launcher builds the pinned native dashboard
assets using the upstream npm lockfile. Stop and start to rebuild after updates.

## Find the right page

| Page | Use it for |
| --- | --- |
| Overview | Start common tasks and understand the archive, Hermes memory and Honcho. |
| Original chats | Search original messages and generated transcripts, then open source records and files. |
| Hermes memory | Read general notes, user profile notes and native conversation history for one chat. |
| Evidence graph | Follow recorded relationships back to their source evidence. |
| Import chats | Choose a Telegram export, review access and files, then start or resume an import. |
| Settings → Nocheh settings | Manage Telegram access, model routing and guarding across the installation. Review, save, then apply to running services. |
| Settings → Hermes preferences | Tune supported agent and memory preferences for one profile. Saves take effect on its next turn. |
| Maintenance | Check health, prepare archive downloads, create backups, restart or verify an inactive restore; inspect settings-apply results. |
| Honcho lab | Check the optional experiment and browse its stored data when it is running. |

This is Nocheh’s control panel on the native Hermes dashboard foundation. Hermes
provides the Telegram adapter, assistant runtime, tools, profiles and memory;
Nocheh provides archive capture, scope policy and guarding. The standard Hermes
chat and administration screens are not exposed here.

Original chats are preserved evidence. Native notes are generated working memory
and may change. Imported messages become archive sources, not native sessions or
automatically generated memory. Honcho remains separate from production memory.

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
The native shell's agent, gateway, filesystem, credential and configuration-write
routes are blocked. Use the Nocheh pages for management.

## Native memory and Honcho

Hermes memory selects only the configured owner/group profiles. Notes are read-only;
preferences in Settings → Hermes preferences use the same locked resolver as assistant startup and take effect on
the next turn. Session messages are paginated in groups of 50, with a 20,000
character preview per message. Notes are bounded to 256 KiB and explicitly show
truncation. A note's presence does not establish source provenance.

```sh
./scripts/nocheh memory list
./scripts/nocheh memory show --scope CHAT_ID
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

Graph selects one archive scope and pages through 20 events at a time. It includes
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
