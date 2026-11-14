<dashboard>

# Owner dashboard and CLI

Start the archive with `./bin/nocheh up`. With pinned Node 26 and Python 3 available
locally, install the repository's locked development dependencies using `npm ci`,
then run:

```sh
./bin/nocheh dashboard
./bin/nocheh dashboard --no-open
./bin/nocheh dashboard --stop
```

Nocheh opens at <http://127.0.0.1:8783/> for the `personal` workspace; `./bin/nocheh workspaces`
shows each other workspace's address. It owns the application and owner API.
Open Assistant console from the sidebar for Hermes's native dashboard at `/hermes/nocheh`;
its return link brings you back to Nocheh. Chat, second in the sidebar, opens its chat
at `/hermes/chat` directly; the profile picker there chooses your private chat or a
group. Old `/nocheh#…` bookmarks still work.
Settings › Models holds the model providers and keeps their keys server-side; see
[model providers](provider.md).

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
| Home | What needs you (decisions waiting, problems), a Get started checklist until setup is done, today's replies, cost, kept messages and long-term memory, and where things are. |
| Chat | Talk to the assistant in the browser. It opens the assistant console's chat, where the profile picker chooses your private chat or a group. |
| Inbox | Waiting: decide approvals, memory-access requests, identity suggestions and organization changes. Allowed actions: standing permissions you can revoke. History: earlier decisions and their outcomes. |
| Tasks | Personal and per-project to-do lists, also filled by telling Nocheh in chat: Open, Today, Upcoming, Board, Done, Dropped, Archive and Trash. |
| Chats | The one place for memory access. Pick any chat or topic to see who can talk to Nocheh there, what it remembers there, what it may do there and which tools it may use (Commands, Web pages, Outside tools), its role and skills, and its project; turn Nocheh on or off in a group, allow people, add older topics. Sharing: your own rules that let one group use knowledge from another, with who will see it, previews of exactly what is shared, and access defaults. A topic's project is always its group's; turning Nocheh on in a group asks which project it joins, or none, and in a group already in a project first names that project's other groups. |
| Messages | Messages: every original message, its agent copy and versions, files, transcripts and reactions; hide (retire) a message or restore it. Import: choose a Telegram export, review access and files, then start or resume an import. |
| Memory | Facts, People and Projects as lists with side panels (correct a fact, share it with a chat, rename or merge people, a project's groups, its role and skills, its last Answer privately buttons, and automatic organizing, which, once on, only creates projects; removing a group from a project asks first and says its tasks stay on that project's list, for you only). Assistant notes: native notes and history for one chat. Long-term memory: the memory engine in use (Honcho today), readiness, attachment, budget, re-run or replace, and stored data. |
| Usage | Model calls, tokens and cost by part and by model, calls per day, and reply speed with a per-stage breakdown for each reply. |
| System | Health: services, connections, storage and diagnostics. Background work: background jobs with Stop (a machine job also shows its machine and plan), workflow totals, history charts and the task list with retry and cancel. Sent to apps: every message, edit, card, notice and reaction sent to chat apps, and whether it worked, with a Problems filter. Machine log: every command jobs ran on your machines. Backups: backups, restore, off-site copies and their test, exports, service checks, restart and settings-apply history. Databases: read-only table browser. |
| Settings | Telegram, Models (providers and which model each part uses), Speed, Privacy & data (backups, off-site copies with Cloudflare or Backblaze connected from one pasted credential, secret check, how long history is kept, password), Assistant (owner freedom, role and skills for the private chat and for groups, tools in every chat, limits, background jobs), Tasks (statuses, priorities, columns, time zone), Connections (Notion, GitHub), Machines (your VMs that jobs can work on over SSH, and the Machine control switch) and Advanced. |

Every settings edit, on any page, is a draft. On Settings and Chats the page header
always stays at the top of the screen with Discard and Save, turned off until something
is unsaved; elsewhere it appears only while something is unsaved. Save
writes the settings and applies them to the running services in one step, follows
the apply to the end and shows the saved values. A failed apply keeps your edits.
Edits stay while you switch tabs or pages; a tab with unsaved edits has a dot.
Actions on one item (approve, revoke, hide a message, correct a fact) happen at once
from its side panel and confirm with a short message.

Links that use an earlier page or tab name (for example `#activity`, `#archive`, `#sharing`, `#monitoring`, `#projects` or `#memoryMap`) open the page and tab that now hold that content; a link to one memory-access request opens it in the Inbox.

Nocheh is the main product, and its own service is the Telegram bot. Hermes provides the assistant runtime,
its own native tools, profiles and native notes through an integration. Nocheh owns
capture, access rules, guarding, approvals, the per-chat tool switches, its data tools
(served to the brain over `/mcp`) and long-term memory behind its memory socket (Honcho
today). Native execution and administration remain restricted until
their integration acceptance passes; see TASK.md for actual phase status.

Original chats are preserved evidence. Native notes are generated working memory
and may change. Imported messages become archive sources, not native sessions or
automatically generated memory. At import confirmation, checking the optional learning control grants
learning consent. That permits Honcho ingestion only, not native note review (ADR-0198);
preparing guarded copies alone grants no learning consent. Honcho attaches once by
default; its live acceptance is an optional check.

## Change configuration

Settings show saved `.env` values with credential presence only. Save validates
the complete configuration, then starts the apply job, which recreates affected
Compose services and checks health; the Save button follows that job. A failed apply
restores the previous environment, reports whether recovery succeeded and keeps
your edits. Runtime state is shown as unverified until the apply job verifies it.

Imports accept Telegram Desktop JSON, an export directory or ZIP. Review counts,
missing media and chat scopes before starting. Unmapped chats remain owner-only.
Explicit group mapping shares history with that group. The original export JSON
is preserved as an archive artifact with a batch manifest. Media and message
payloads reuse the existing archive importer unchanged. Imports send no old
replies and do not automatically run memory derivation.

Jobs retain progress under the private `data/local/admin/jobs/` directory. Stop
or interrupted jobs can resume; already committed sources remain preserved.
Upload limits are 128 MiB export JSON, 50 MiB per media file, 512 MiB uploaded ZIP,
512 MiB total unpacked/uploaded content and 10,000 files. The dashboard sends large
files in 16 MiB pieces, so a proxy's request size limit does not stop them. The old import commands
remain supported alongside these conveniences:

```sh
./bin/nocheh config show
./bin/nocheh config set NOCHEH_GUARD_MODE on
./bin/nocheh config apply
./bin/nocheh import telegram /absolute/export/result.json
./bin/nocheh jobs list
./bin/nocheh jobs show JOB_ID
```

Secret settings take a hidden prompt or piped stdin, never a value in argv.
The dashboard owner session is separate from the archive service credential and
model provider keys. Ports bind only to localhost. Native HTTP and one-use,
30-second WebSocket tickets are checked by Nocheh before proxying. Internal
backend credentials are not injected into native pages. Existing CLI headers
remain compatible; download-only cookies cannot administer settings.

## Sign-in

The dashboard asks for the owner's Nocheh password; the Telegram mini app uses
the same one. On the first visit it asks to create the password. After that it
opens on a sign-in screen, and a browser stays signed in until it signs out
(Sign out, at the bottom of the menu) or goes 30 days without being used. Sign-ins survive dashboard restarts.

Settings › Privacy & data › Password changes the password after asking for the
current one; every other browser and phone then signs in again. Sign out
everywhere else ends every other session at once. After five wrong passwords in
a row, sign-in pauses for 15 minutes, and each further wrong password doubles
the pause, up to a day; one count covers browsers and phones.

The dashboard keeps a scrypt hash of the password and SHA-256 hashes of the
session tokens in `admin/owner-lock.json` in its state folder. The browser
receives an HttpOnly, SameSite=Strict session cookie, and a CSRF value derived
from it. A forgotten password is reset by stopping the dashboard, removing that
file, and creating a new password on the next visit.

## Native browser chat

Open Chat in the sidebar (or Assistant console → Chat). The context banner
identifies the owner-private default or selected group profile. Changing the native profile selector changes the scope of
archive retrieval, native sessions and memory. Chat does not send replies to Telegram.
The selector lists the private chat as `private-chat` and each allowed group as
`group-` plus its name and a short code of its own (the username or the code
alone when the name has no Latin letters); Profiles shows each group's full name. Sessions titles a Telegram
conversation with its chat's name and leaves out memory reviews.
The terminal, its model turn and the sidebar metadata connection have distinct roles;
only the managed turn runner can invoke a model.

Submitted text and up to 10 files (25 MiB total) are archived before execution.
Voice attachments are transcribed like Telegram voice notes; bounded UTF-8 files
(up to 200 kB each, 1 MB total) are included as context. Other binary files remain
retrievable. Original images remain owner-only while guarding is on; required guarding
rejects opaque image context. Generated results and transcripts retain provenance.

Native Sessions can resume a conversation in its profile. Cancel stops the isolated
model process. Reload reconnects to the same live terminal. After a service restart,
a recorded run can be completed, failed or interrupted; it is never automatically
executed again. Inbox › History lists the latest 50 assistant runs (browser conversations and scheduled jobs together), each with its state and a link to its original message.
An explicit retry creates another observed input. Local UI commands appear as
“Captured only” because they do not start a model turn.

A turn gets Hermes's own native notes, scoped native session search and skills, plus
Nocheh's 18 data tools over MCP (`mcp__nocheh__*`): archive retrieval, long-term memory
recall and search, tasks, Notion, message and shell, browser and MCP proposals,
background jobs and knowledge proposals. Proposals follow the owner's approval rules,
and most wait for a yes. Shell, browser and MCP proposals, Notion included, also follow
the chat's tool switches. Local wake-word models and arbitrary TUI gateway commands
are disabled. See [ADR-0028](adr/0028-isolated-native-browser-turns.md) for the boundary.

## Native memory and Honcho

Memory › Assistant notes lists configured and historical group/topic profiles, and each private answer's own profile by where it was asked and the day it ran. Notes are read-only;
preferences in Settings › Assistant use the same locked resolver as assistant startup and take effect on
the next turn. Session messages are paginated in groups of 50, with a 20,000
character preview per message. Notes are bounded to 256 KiB and explicitly show
truncation. A note's presence does not establish source provenance.

```sh
./bin/nocheh memory list
./bin/nocheh memory show --scope CHAT_ID
./bin/nocheh memory show --scope CHAT_OR_TOPIC --profile NATIVE_PROFILE_ID
./bin/nocheh memory show --scope CHAT_ID --session SESSION_ID --offset 50
./bin/nocheh memory preferences --scope CHAT_ID
./bin/nocheh honcho doctor
./bin/nocheh honcho install
./bin/nocheh honcho workspace list
./bin/nocheh honcho peer inspect PEER_ID -w WORKSPACE_ID
./bin/nocheh honcho peer representation PEER_ID -w WORKSPACE_ID
./bin/nocheh honcho conclusion list --observer PEER_ID -w WORKSPACE_ID
./bin/nocheh honcho session view SESSION_ID -w WORKSPACE_ID --page 2 --size 50
./bin/nocheh honcho session view SESSION_ID -w WORKSPACE_ID --all > transcript.json
```

Honcho lifecycle (`init`, `up`, `down`, `status`, `login`) targets the installation
Compose project. Initialize its pinned source before starting Honcho. Inspection uses official
`honcho-cli==0.4.0` / `honcho-ai==2.8.0`, pinned dependencies and an internal-only
Compose runner with a fresh CLI config directory. Ambient Honcho accounts are
ignored. A narrow transport changes SDK get-or-create lookups into exact-ID list
queries and rejects writes, model-backed search/chat and unexpected endpoints.
Missing resources remain missing. Stored representation retrieval has no search
query; it does not request embeddings. Native list commands walk pages; the
wrapper caps at 100 pages and reports failure rather than silently exporting an
incomplete collection. `complete` refers to the requested command/limit, with
server pagination metadata retained. Inspect is a summary, not a full export.

The dashboard shows live-gate status, attachment, current memory generations and
receipts alongside workspace/peer/session lists. Honcho attaches by
default; Connect and Disconnect stay available, and Connect offers optional
consented history and catch-up. The CLI provides deeper stored-data
inspection. See [the current memory system](guarded-memory-system.md) for activation
and budget instructions; fixture tests do not certify live provider behavior.

## Evidence graph and local operations

Graph defaults to all private knowledge; you can select one archive scope. It pages
through 20 messages at a time. The aggregate `All private knowledge` root is a
`Collection` navigation node, separate from conversation groups and their counts.
The source-backed node types are users, projects, groups, and messages. It includes
recorded authorship, replies to original source IDs, same-source revisions, and
explicit group-to-project assignments. Actions, events,
runtime context, files, generated artifacts, Hermes profiles, and memory notes are
excluded from the graph and its JSON export. Messages without display
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

The owner dashboard shows people, projects and facts as lists with side panels;
the graph is available as JSON from the CLI and API.

Export the graph as JSON. Source detail includes the original record,
downloadable retained files, transcripts and their generation provenance. Use the
next cursor to retrieve additional graph pages:

```sh
./bin/nocheh memory graph --scope CHAT_ID --output graph.json
./bin/nocheh memory graph --scope CHAT_ID --after EVENT_ID --output next-page.json
```

System › Backups provides diagnostics, portable archive ZIP export, consistent backup,
service restart, restore into a new inactive Compose project, and, once Off-site
copies are set up in Settings › Privacy & data, Send copy now and Test the off-site
copy. Backup and
restart show a review step. Restore selects a locally generated backup ID and an
unused loopback port; it cannot overwrite current state. Restored Telegram stays
disabled, and copied credentials stay inactive. The existing `backup`,
`restore`, `diagnose`, `export` and `archive export` commands remain available under
`./bin/nocheh`, and `offsite list|fetch|decrypt` gets a backup back from an off-site copy
on a new machine.

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
runtime. Its separate administration process owns no Telegram poller, scheduler
or agent. Nocheh proxies its authenticated API separately from
the presentation assets. The internal API binds on loopback at archive port + 5
(8785 by default); restored installations derive their own port.

Native Config and Nocheh Settings share the same writer for the five current agent
and memory preferences. Config revisions include inherited policy state: a stale
native form or CLI writer is rejected after either a profile or global change.
Unknown native fields are retained; credentials are redacted and managed routing,
tools, provider authentication and scope bindings cannot be changed by native forms.
Raw YAML inspection is read-only. Nocheh Settings retains the deployment model,
Telegram and guard/trust settings with its existing save/apply behavior.

**Settings › Assistant** shows profile preferences and global Hermes defaults
together. Each profile preference shows its effective origin and has a reset icon
beside its input; resetting removes the profile override after saving so the global
value applies. Existing native values remain explicit overrides. Nocheh settings
shows `****` for a configured Telegram bot token without exposing its value and explains
that an empty selected group list still permits owner private messages.
Under the background job limits, **Sealed box for jobs** (on by default) lets a
job the owner asks for in their private chat run commands and Python in a sealed
box ([ADR-0205](adr/0205-owner-approved-jobs-work-in-a-sealed-box.md)). Off: no
new job gets a box, a running job loses its box within seconds, and any relaunch
runs without one. It saves over the job settings' revision, like the limits.
Job preference overrides can be stored via CLI; scheduler execution is P6 work.
**Tools in every chat** sets Commands, Web pages and Outside tools to Default, On or
Off for every chat; a chat or topic sets its own on its Tools card in Chats
([ADR-0233](adr/0233-data-tools-over-mcp.md)).

```sh
./bin/nocheh runtime profiles
./bin/nocheh runtime status
./bin/nocheh runtime show --profile PROFILE
./bin/nocheh policy show
./bin/nocheh policy show --profile PROFILE
./bin/nocheh policy set agent.max_iterations 8
./bin/nocheh policy inherit agent.max_iterations --profile PROFILE
./bin/nocheh policy set agent.max_iterations 4 --job JOB_ID
```

Pass `--revision REVISION` to conditional CLI writes. Native profiles created here
are owner-private and do not clone credentials. Their rename and removal controls
preserve managed Telegram bindings; removal retains their directory under
`retired-profiles` for recovery. Session inspection and changes stay within the
selected profile. Native file browsing/uploads are confined to that profile's
workspace, including symlink checks. These workspace files are not chat imports;
chat attachment capture is part of P4. Native session imports remain gated: use
Messages › Import to preserve originals and provenance.

Inspection does not bootstrap, migrate or auto-archive a session database. SQLite
can create its normal WAL/locking sidecars during a read-only connection. It does
not change session contents, notes or configuration. Missing stores list as empty.
Unintegrated native operations return an explicit unavailable result until their
managed execution phase passes acceptance.

## Tools and approvals

**Inbox › Waiting** shows the complete command, page URL or MCP arguments,
and the originating profile and scope; Inbox › History shows the eventual
execution result. Approve or deny each operation in Waiting or in your private Telegram DM with `/actions`,
`/action ID`, `/approve ID` and `/deny ID`. Group messages cannot approve actions.
Long operations require the dashboard so approval never relies on truncated text.

An optional permission allows only that exact operation in that scope/profile,
for 1–1000 starts and up to 30 days (the dashboard offers 1, 3, 10 or 50 starts for an hour, a day, a week or 30 days). Revoke it in Inbox › Allowed actions, `/revoke ID`, or the CLI.
Revocation stops future starts; it cannot undo a started operation. Ambiguous
results are retained without automatically repeating execution. An unclear one
waits in Inbox › Waiting until you open it and press It ran, It didn't run or
Dismiss (for a message: It was sent, It wasn't sent or Dismiss); an unclear web
page read closes by itself, since a read changes nothing. Closing one runs
nothing again, and History says how it closed.

Shell runs in a disposable, network-disabled container with only the selected
workspace mounted. Browser inspection fetches one approved public HTTPS page and
renders its inert text/link structure offline. MCP supports exact public HTTPS
tool calls or discovery with JSON responses; authenticated/SSE servers, local MCP
processes and interactive browser actions remain unavailable. Nocheh keeps
each chat's tool switches (Commands, Web pages, Outside tools, which also covers Notion):
for every chat in Settings › Assistant › Tools in every chat, and for one chat or topic
on its Tools card in Chats. A topic follows its chat, a chat follows every chat, and
every tool starts on. A proposal for a tool that is off is refused with
`tool_disabled_by_owner`, and the switch is checked again before the run. Scheduled
runs and background jobs follow their chat. A tool that is on still follows the
approval rules.

```sh
./bin/nocheh approvals list
./bin/nocheh approvals show ACTION_ID
./bin/nocheh approvals approve ACTION_ID --fingerprint DISPLAYED_FINGERPRINT
./bin/nocheh approvals deny ACTION_ID --fingerprint DISPLAYED_FINGERPRINT
./bin/nocheh approvals grant ACTION_ID --fingerprint DISPLAYED_FINGERPRINT --uses 3 --minutes 60
./bin/nocheh approvals revoke PERMISSION_ID
./bin/nocheh approvals status
```

`up` starts one approved-tool worker; `down` and backup drain it. Restored tool
workers remain inactive. Bash entrypoints and the optional Honcho CLI are retained.

## Machines

**Settings › Machines** keeps your own machines, such as a VM, that a job you
approve can work on over SSH
([ADR-0231](adr/0231-owner-approved-jobs-work-on-the-owners-machines-over-ssh.md)).
**Add machine** asks for a name, an address (an IP address, a host name, or
`host.docker.internal` for a VM on the computer that runs Nocheh), a port (22 by
default) and a login. Nocheh connects from its own container, so the form flags
`localhost`, `127.x.x.x` and `::1` and says to use `host.docker.internal` instead.
Nocheh then makes the machine's key, keeps it, and shows a setup command with **Copy
setup command** and **Copy public key**: paste the command into a terminal on the
machine, signed in as the login, and it adds the public key to
`~/.ssh/authorized_keys` once, with the modes SSH asks for; or add the key there
yourself. Then press **Test**. The first good test trusts the machine's host key. Nocheh may
use the login you use yourself: Stop ends only the programs a job started there. The
machine needs bash; bash 4 or later and coreutils' `timeout` (`gtimeout` from
Homebrew on macOS) work best.

Each machine shows its login, address and port, its state (Not tested, Ready, Test
failed with the reason and what to do, or Off), its last good test and its host key
fingerprint. Ready means its last Test passed; after a failed Test no new job can
ask for it until a Test passes again. Its row has **Test**, an on/off switch,
**Edit**, **Copy setup command**, **Trust a new host key** (after you reinstalled the
machine, for example), **Log** and **Remove**. **Edit** uses the same fields and
checks as Add machine. A new name saves at once. A new address, port or login asks
first: Nocheh forgets the host key, jobs running on the machine stop, cards waiting
for your approval are withdrawn, and the machine needs a new Test. Its key stays, so
the public key already on the machine still works. Trusting a new host key, turning a
machine off or removing it also withdraws the cards still waiting for it and stops
its running jobs. Before a new address, port or login, a new host key or a removal,
Nocheh first ends the programs of every job on that machine whose cleanup is still
due, one job at a time, while the old key and host key still work. The **Machine
control** switch turns all machine work off at once; it asks first, and a notice
stays on the page while it is off. When the machine service is not set up, the page
says so and nothing else changes.

A machine job is asked for in your private chat or in an active project's group.
Its one plan card, with Approve and Reject, always comes to your private chat.
**System › Background work** shows the job's machine and the plan you approved.
Stop, a time or cost limit, a failed run, or turning its machine or Machine
control off ends the programs the job started on the machine, with anything
running inside them (such as in a tmux the job started), and none of the login's
others. Stop's confirm
says so for a job that has started; for a job still waiting or approved it says
nothing has run there yet. While Nocheh ends the programs, the job says "Ending its
programs on" the machine; when it couldn't, it says to end them yourself. A job that
ends normally leaves what it started running, also when its report couldn't be
delivered. A waiting card withdrawn by a switch, a new address, port or login, a new
host key or a removal says its machine was turned off or changed.

**System › Machine log** lists every command jobs ran on your machines, and each
test and cleanup, newest first: time, machine, job, kind, the command as the
assistant asked for it, exit code and state. Filter it by machine or job; **All
commands, also internal ones** adds the commands Hermes runs by itself, such as its
session setup and its checks on commands left running. A row opens the command's
details, including **Fingerprint of what ran** (for a job's command, the whole
script the machine got) and **Fingerprint of what it printed**; while a command
runs, what it printed is not known yet. Output itself is not kept. A cleanup that
couldn't end the programs says to end them by hand; most of them hold a file named by
the job in `~/.nocheh/jobs` open, which `lsof +D ~/.nocheh/jobs` shows. After a restore, a test, command or cleanup says Nocheh has no
key for the machine, and the machine shows Test failed until you remove it and add
it again.

## Space policies and native review

Your private assistant can recall across the entire archive and registered native
profiles. Group and topic context is constrained in storage and tools. A topic
inherits its group's settings unless you override them. `approved` is the default;
`isolated` permits only its own context; `filtered` is an explicit opt-in for
selected source spaces. Approved shares disclose the exact saved text, while
supporting original IDs remain private. Revoking a share retires old group contexts
and blocks stale in-flight delivery; it cannot retract messages already posted.

Filtered mode currently considers original archive text only and uses a
model-based privacy reviewer. Native-note/transcript filtering is pending explicit
owner authorization. Filtering can miss personal details; failures withhold wider
knowledge. The access preview performs no model call and shows eligible sources,
not a promise that their contents will be released.

At the final import step, **Let the assistant learn from this history** is
unchecked. The saved choice survives cancellation/restart and cannot change on
resume. Completed imports without approval remain searchable. Review jobs use
Hermes's native memory review, with no external-action tools. Pause/resume controls
operate on queued work; an interrupted native write is marked ambiguous and needs
an explicit resume. Retrying an ambiguous review may repeat a native memory edit.

```sh
./bin/nocheh memory spaces
./bin/nocheh memory policy --space=-100123/topic/42
./bin/nocheh memory policy --space=-100123/topic/42 --set policy.json --revision REVISION
./bin/nocheh memory share --space=-100123/topic/42 --file shared.txt --revision REVISION
./bin/nocheh memory revoke SHARE_ID --revision REVISION
./bin/nocheh memory preview --space=-100123/topic/42 --query Juniper
./bin/nocheh memory recall Juniper
./bin/nocheh memory reviews
./bin/nocheh memory pause JOB_ID
./bin/nocheh memory resume JOB_ID
./bin/nocheh memory review EVENT_ID --approve
./bin/nocheh import telegram /path/to/result.json --approve-memory-review
./bin/nocheh memory graph --scope '*' --output graph.json
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

**Local** saves results in Inbox › History. **Telegram** proposes the exact result to that
scope for owner approval. Overlong results stay local with a visible delivery error.
Pause prevents future starts; Cancel run interrupts an active run. Runs more than
60 seconds late are recorded as missed; **Catch up once** is an explicit extra run.
It does not replay every missed interval. Original prompts and generated results
remain separately inspectable in Inbox › History, including after deleting a schedule.

```sh
./bin/nocheh cron list --profile all
./bin/nocheh cron create --profile PROFILE --file job.json
./bin/nocheh cron show JOB_ID --profile PROFILE
./bin/nocheh cron update JOB_ID --profile PROFILE --file changes.json --revision REVISION
./bin/nocheh cron pause JOB_ID --profile PROFILE
./bin/nocheh cron trigger JOB_ID --profile PROFILE --request-id UNIQUE_REQUEST_ID
./bin/nocheh cron catch-up JOB_ID --profile PROFILE --request-id UNIQUE_REQUEST_ID
./bin/nocheh cron cancel JOB_ID --profile PROFILE
./bin/nocheh cron runs JOB_ID --profile PROFILE
```

A minimal job file is `{"name":"Daily review","prompt":"Review today's archived notes.","schedule":"0 18 * * *","deliver":"local"}`.
The native parser uses the profile's Hermes timezone; ISO dates include their UTC
offset. Reuse the same request ID only when retrying the same manual request.
Custom skills/scripts, alternate providers and topic schedules are not enabled.

## Original and guarded versions (ADR-0033)

Messages browses all records without requiring a search. Open a source to see
its read-only original beside the separate guarded copy, including derived text
and file metadata. Save guarded wording directly; matching copies of the message
text are updated together. Other guarded fields can be inspected and edited too.
History lets you inspect an old revision and restore it as a new owner revision.
Concurrent saves require refresh and comparison; preparation never overwrites an
owner revision. Original file downloads remain read only.

Local Compose now uses the saved guarded version when guarding is on. A synthetic
live test verified import, edit, scoped retrieval and native Hermes
archive recall. See [task history](task-history.md) for that recorded checkpoint and [TASK.md](../TASK.md) for current Honcho and release checks.

## System monitoring

Open **System › Background work** for running, waiting and failed workflow
totals, the last confirmed workflow completion, and unpublished backlog across
all workflow families. The summary refreshes every ten seconds independently of
history filters and pagination. Unavailable data is shown explicitly; failed
refreshes retain the last snapshot with a stale-data warning.

Use **Scheduler console** for native execution history at `/inngest/runs`, behind the
same owner session. That view is read-only. Use **Kind of work** and the **Tasks** list to filter
history, inspect stages, source evidence and receipts, use authorized retry/cancel
controls, or check delivery and worker freshness. Telegram, provider, background
work and service diagnostics have their own expandable sections. Failures,
uncertain effects, disconnected workers and unhealthy services remain visible
without expanding details. A healthy container does not certify model access or
Telegram reception. **Open the message** opens the archived evidence.
**Storage** shows the same read-only report as `./bin/nocheh storage`: each
database's size and largest tables, local state folder sizes (a folder the
dashboard cannot fully read is shown as "at least"), Docker log limits and the
workflow history retention setting. It is measured when System › Health opens.

<design_and_metrics>

## Appearance and workflow trends

The owner dashboard uses a small set of locally owned Radix-based components
(`dashboard/ui`), Tailwind semantic colour tokens, Lucide, and Recharts, with no
page stylesheet. Appearance follows the system by default; Light, Dark, or Match device
is persisted locally. The sidebar lists each page's tabs under it (from
`dashboard/lib/page-tabs.ts`, which the pages read too); the open page's tabs show,
and the chevron beside a page shows or hides its tabs, remembered locally. The
desktop sidebar collapses to icons, and below 1024px navigation opens in a
keyboard-accessible drawer. Refresh updates data without remounting
the page. Hermes keeps its native interface and integration link.

Background work retains global running, waiting, failed, last confirmed success and
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
keyboard tooltips and Show as a table provide alternative inspection paths.
Current workload-by-family uses health counts, never historical queue depth.
Workflow summary values and label icons use blue for running, amber for waiting
and backlog, red for failures, and green for a recorded confirmed completion.
Missing or unavailable values are neutral in both themes. Zero is an observed
count in the labeled category, rather than an unavailable observation.
No sampling service, uptime claim, or provider analytics collection is added.

Page implementations live under `dashboard/pages/` (one file per page, its tabs
in a folder of the same name). Shared components live in `dashboard/ui/`: `core.tsx`
(buttons, cards, fields, badges, tables), `overlay.tsx` (dialogs, side panels,
confirmations, toasts), `page.tsx` (page frame and tabs) and `save-bar.tsx`. The
owner API client (`dashboard/lib/api.ts`), data subscriptions (`resource.ts`), routes,
the shared settings draft store (`settings.ts`) and other draft sources (`drafts.ts`)
live in `dashboard/lib/`. All browser code is TypeScript/TSX checked with
`tsconfig.dashboard.json` and formatted with Prettier (`npm run format:dashboard`,
`npm run check:dashboard-format`). The build removes obsolete chunks and emits a
separate chart bundle. `npm run test:dashboard` covers routes, request
handoff/cancellation and small presentation helpers.

`npm run test:dashboard-browser` opens every page and tab in Chromium against the
synthetic preview below and checks headings, navigation, old bookmarks, the save
bar (save, apply, discard, edits kept across tabs), adding a custom provider, Usage,
phone-width layout, and that no page logs an error. It needs `npm run build`, a
disposable PostgreSQL reachable through the usual `PG*` variables, and Chromium
(`PLAYWRIGHT_CHROMIUM_EXECUTABLE`, or the browser Playwright manages). It starts and
stops its own preview server on a free port.

Messages and conversation history use list/detail views that stack on mobile.
Original sources remain read-only; guarded copies are explicitly editable, and
notes carry generated-content labels. Settings and guarded drafts keep the
revision where editing started, so Refresh cannot silently bypass a conflict.
Import consent belongs to the selected job and stays fixed when it resumes.
Maintenance reviews use focus-restoring dialogs before backup, restart or restore.

</design_and_metrics>

<synthetic_preview>

## Isolated UI acceptance preview

`deploy/acceptance/dashboard-preview-compose.yml` is a separate synthetic fixture,
not an overlay for the installation Compose file. Assign a unique project/image,
an unused localhost port, and new random credentials in a private environment file:
`NOCHEH_FIXTURE_PROJECT`, `NOCHEH_FIXTURE_IMAGE`, `NOCHEH_DASHBOARD_PORT`,
`POSTGRES_PASSWORD`, and `SERVICE_TOKEN`. Never copy installation credentials.
The fixture owns its database volume and internal database network; only its
HTTP preview bridge publishes the chosen loopback port. It has no poller,
scheduler, provider credentials, or external-effect executor.

From the session worktree, with `FIXTURE_ENV` pointing to that private file:

```sh
docker compose --env-file "$FIXTURE_ENV" -f deploy/acceptance/dashboard-preview-compose.yml build preview
docker compose --env-file "$FIXTURE_ENV" -f deploy/acceptance/dashboard-preview-compose.yml up --no-build preview
```

Keep the second command in the persistent preview terminal. The fixture uses real
PostgreSQL workflow aggregates and synthetic page data. Its action/settings/import
controls change only synthetic state; integration links show a fixture boundary.
For injected browser failures, `/tmp/nocheh-ui-scenario` inside that preview
container accepts `offline`, `unavailable`, `conflict`, `fresh`, `no-provider`, `slow-apply` or `lost-apply`; `normal`
restores normal behavior; `unavailable` also shows machine control as not running.
Never apply these probes to installation containers.

For the existing native inspection and database bootstrap tests, combine the
preview file with `deploy/acceptance/dashboard-native-checks-compose.yml`, enable the
`native-checks` profile, and assign fresh 64-character hexadecimal
`INNGEST_POSTGRES_PASSWORD`, `INNGEST_EVENT_KEY`, and `INNGEST_SIGNING_KEY` values.
It starts pinned Inngest and Redis only on the private fixture network, without
registered runtime workers or published ports. The `checks` service runs against
that same fixture. The container-dashboard boundary test additionally requires a
separate network-isolated container with `nocheh-app` and `hermes`
mapped to loopback and `NOCHEH_CONTAINER_TEST=1`.

</synthetic_preview>

</dashboard>
