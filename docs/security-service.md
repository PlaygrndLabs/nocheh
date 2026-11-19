# Security service

The versioned `nocheh.security` service brokers isolated assistant requests.
Its policy library also runs inside the trusted archive executor, using the same
database and precedence. Thus an unavailable optional UI or broker does not remove
effect authorization. An isolated model has no direct provider fallback.
See [phase status and acceptance evidence](security-service-plan.md).

From the repository root:

```sh
python3 -m tools.operations.security.security show
python3 -m tools.operations.security.security plugin
python3 -m tools.operations.security.security preview ACTION_ID --policy /absolute/path/policy.json
python3 -m tools.operations.security.security apply /absolute/path/policy.json --expected-revision 1
python3 -m tools.operations.security.security effects --effect ACTION_ID
```

The policy document is strict and versioned. Global rules omit selectors; scope,
profile, job and exact fingerprint selectors combine. All matching denies win,
then a valid bounded grant, then an explicit ask, then defaults. Example:

```json
{"version":1,"rules":[{"id":"pause-project-shell","kind":"shell","outcome":"deny","profile":"project"}]}
```

Supported configurable boundaries: controlled shell/browser/MCP operations,
explicit Telegram action requests, and isolated model/archive/memory reads.
Native memory writes stay inside the writable profile data directories; no
setting claims to intercept arbitrary filesystem writes. Guard on/off, sharing
policy and each chat's tool switches (Commands, Web pages, Outside tools) remain
separate mandatory controls: a shell, browser or MCP proposal for a tool that is off
is refused with `tool_disabled_by_owner` before the secret check, and the executor's
claim checks the switch again. Existing selected-group conversation
and approved scheduled delivery keep their existing delivery policy.

Use the exact fingerprint returned by Activity or a policy preview to grant a
repeated operation. The owner explicitly chooses both limits; no hidden grants:

```sh
python3 -m tools.operations.security.security grant ACTION_ID --fingerprint FINGERPRINT --uses 100 --minutes 10080
python3 -m tools.operations.security.security revoke PERMISSION_ID
```

Grants bind exact arguments, scope and profile. A scheduled operation also binds
its job. Limits are 1–1000 uses and 1–43200 minutes (30 days). Changed arguments,
expiry or revocation need new authority. Ordinary authorized recall, drafting,
model calls and native memory work never request permission. This version does
not grant arbitrary shell commands or arbitrary URL/parameter combinations.

Owner policy edits use a required expected revision. Preview is read-only and
does not consume grants. Group members and model processes cannot edit policies,
grant permissions or read owner effect logs. Runtime policy applies at the next
authorization; an action already sent cannot be undone.

Effect records contain IDs, scope/profile, source reference, rule, origin, policy
revision, permission ID and, for an effect a turn asked for, the brain its pass names
(`hermes` today). They omit prompts, URLs, credentials and result text.
Inspect originals/results through the linked action and existing archive UI.
`allowed` means permission, `claimed` means an executor reservation, `started`
means a trusted executor/provider request attempt began, and `completed` means a
result was observed. Missing results are `ambiguous`; the executor never repeats
the effect automatically. Telegram recovery reads the runtime's durable receipt
using the existing idempotent action ID. A completed HTTP response is not a claim
that the model's answer was correct. Successful routine activity creates no alerts.

Owner API routes are `/v1/security/plugin`, `/policy`, `/preview` and `/effects`
(each prefixed by `/v1/security`). They are available through the owner archive
API; the service itself serves all but `/preview`. Scoped turn credentials cannot access them.

The broker also serves Nocheh's data tools at `/mcp` to isolated turns (`nocheh-app`
serves them to turns without the isolated runtime). Only a turn's own pass reaches
`/mcp`; the service token and any request with an `Origin` header are refused. Each
tool calls an existing `/v1` route again with the caller's pass, so every check stays
where it was and `/mcp` itself grants nothing
([ADR-0233](adr/0233-data-tools-over-mcp.md)).

The trusted launcher is part of the host's security boundary: it owns Docker
authority. Agent containers do not. It pins the installed image ID at startup,
disables external DNS, mounts only native data plus read-only configuration, and
discards the turn filesystem on exit. Replacing it requires a trusted compatible
implementation; arbitrary plugin installation does not confer privileges.

`NOCHEH_MEMORY_CONTEXT=evidence` moves complete native memory blocks and recalled
objects into a labelled data message on each provider attempt. Hermes reads the
native blocks only when it builds a session's prompt, so each turn reads them itself,
and a continuing session keeps its stored prompt. It leaves native
history and memory files unchanged. The same evidence participates in initial
context-size estimates; the layer does not lower limits or summarize sources.
The pinned native compaction instruction is adjusted so it does not label memory
as administrative authority. The memory and process-isolation settings remain independently configurable.
Fresh configurations default to `NOCHEH_SECURITY_RUNTIME=isolated` and
`NOCHEH_MEMORY_CONTEXT=evidence`.

In evidence mode each native notes block is one entry, `{source, target, title,
usage, about, notes: [{from, label, ref?, content}]}`. `content` is the note's text
unchanged; `from` (one of `owner`, `nocheh`, `person`, `forward`, `file`,
`mixed`, `turn`, `turn_read`, `unknown`, `unavailable`) and `label` (fixed
words, at most 120 characters, no person's name) come from Nocheh's own record
of who wrote the note, which Hermes's parent keeps in
`<profile>/nocheh-note-sources.json`, outside the folders an isolated run can
write, and storage turns into labels when the turn starts. `about` is a fixed
sentence saying so, and that `from=owner` means only the owner's own messages;
it reaches the model even when the owner edited the evidence instruction. The
child accepts only a known `from` and a plain label, else `unknown`, and a block
of another shape stops the turn. In the owner's turns, the long-term memory
blocks in the same evidence each carry `about`, `owner` or
`forwards_and_files`. Labels are information for the model, not a permission,
and the request guard checks them like the notes. A review's rules count by the
messages code recorded each was learned from: rules resting on another person's
message, a forward or a file make the note `person`, `forward`, `file` or
`mixed`. Only a review that holds someone else's words reads them; a review of
Nocheh's own learned messages, alone or with the owner's own, leaves them out,
and the owner's quote or pin of a message Nocheh learned counts as Nocheh's. A
review of only the owner's own messages reads only the rules the owner wrote,
since a rule learned automatically, even from the owner's own messages, can
restate a rule or chat that its interpretation read.
A pin or quote of Nocheh's message that is not archived yet, or whose capture
failed, or of a forward of one, counts as someone else's (it fails closed), and
its words, from Nocheh's own account, are cut from everything learned. Code tells
Nocheh's own account only by comparing the sender's ID with the bot account the
archive stored with the update (`events.bot_id`); when that is not an account,
nothing is cut by it. Only Nocheh's own words are cut: another bot's message is
learned as someone else's, and a message sent through an inline bot, which its
sender wrote, as sent through an inline bot. The owner's quote of their own
forward quotes whoever wrote it, so it is never `owner`, and neither is a quote
of a message in another chat or topic, which Telegram does not show as a forward
or as sent through an inline bot; a Telegram Desktop export's message with any
of its forward fields is a forward. A checklist others can add tasks to, and
any checklist edited, pinned, quoted or forwarded, is never `owner` either:
Telegram names no one per task, and the owner can stop sharing one after others
added tasks; only the owner's own in the owner's private chat with Nocheh, where
no one else can add tasks, stays `owner`. Nor is a poll someone else added an
option to, a deleted option (except, in that private chat, one deleted from the
owner's own poll that is not a forward), a Telegram Desktop export's checklist
or poll, or a message that embeds one its sender did not type or one that
quotes a message: Telegram keeps an embedded message's quote but leaves out its
reply, so that quote is never read as the sender's own words. The owner's pin
of such a message of their own is labelled as a message holding someone else's
words that the owner pinned. A pinned message's own reply
is never learned with the pin. A message another embeds, which code finds by
its shape alone (a `message_id` and a `chat`), never a field's name, so one in a
field Telegram adds later is found too (the checklist a service message reports
on, a giveaway's or a suggested post's message, the poll an option was added
to), is kept and labelled: only Nocheh's own words in it are cut, and a quote
inside it is traced through the archived event of the embedded message itself,
as a pinned message's quote is: one quoting Nocheh's words is cut from
everything learned, and so is one the archive can't trace (that message never
archived, archived in a revision answering nothing, or archived only as
Telegram Desktop exports), counted as `quote_not_traced`, whoever it quoted.
The owner's notes review cuts one from someone not allowed there, a quote inside
one of such a person's message (one of a message in another chat included,
judged as a top-level quote of one is), a poll option such a person added or
one added in a chat's name, and a deleted option's text other than the owner's
own in the owner's private chat, counting the message as kept out. In the
owner's notes review a quote inside a pinned message is judged by who wrote the
message it quotes, and cut when that can't be traced, counted as
`quote_not_traced`, as is a quote inside an embedded message that answers one
in another chat when the archive holds no revision of the embedded message to
judge it by. A Telegram Desktop export's reply to another chat
(`reply_to_peer_id`) gets no reply relation, since its id is that chat's, and
the review never judges a quote by one an earlier export was given. The evidence
instruction says a `nocheh` note is not the owner's own words either. What a
turn read comes from its own session:
a search by meaning counts as reading other chats, an earlier tool result or
another person's group message counts only when the note copies a run of 32
characters or a distinctive token from it, and a forward of the sender's own
message is not a read in the message the turn answers. Earlier in the session a
forward the turn was given counts as read, except the owner's forward of their own message in
their private chat, the only one written `[Forwarded: your own earlier message]`.
Anywhere else an own forward is written
`[Forwarded: the sender's own earlier message]`, a member's in a group and the
owner's own in a group or in a private answer carried from one alike, and counts
as a forward read (it fails closed). A note from a turn whose session can't be
read is never `turn`, and the turn is counted for the owner's notice. Storage
counts a lookup that can't name a note's chat, Hermes's before a turn or review
as well as recall's and the Notes page's, as the owner's `note_labels` line.
The legacy memory mode (`NOCHEH_MEMORY_CONTEXT=legacy`) and the non-isolated
runtime carry no labels, and a non-isolated run could reach the record file
([ADR-0257](adr/0257-learned-memory-names-its-source.md)).

Search hits and opened messages carry a source tag, `{source, tag, by, at}`,
built by storage code from the archive and the reader's own guarded copy, never
by the model ([ADR-0261](adr/0261-recalled-facts-and-search-hits-name-their-source.md)).
Every tag, related message and reply count first passes the reader's own read
check (a batched `readable()` equal to `canRead`); a source the reader may not
read reads only `source not available here`. Names are quoted and cleaned of
brackets, quotes and control or format characters, so a name can't read like a
frame line or claim the owner's words; trust keys on `by`, which keeps ADR-0257's
fail-closed groups. All of a request's tags pass the guard in one `prepare`
call; a tag that can't be built reads `source not available right now` and is
counted as the `source_tags` memory problem. Hermes's retirement plan also reads
the spans Nocheh's own frame quotes at the top of a stored turn (the recent group
messages, the speaker line and a replied-to block), never past the turn's
`[Archive source: …]` marker; frame words are taken out of members' text
(`FRAME_WORDS`, now with the reply words too), so text inside a message can't
open a span. A retired span becomes `[Quoted message withheld; it was retired:
nocheh:event:<id>]` and withholds that turn's tool calls and results, and the
notes written from them, like a retired turn message. Owner recall asks Hermes's
search only for a hit's own snippet and time, never the neighbouring rows'
`context`.

Long-term memory facts carry source lines built the same way, never by the
model ([ADR-0261](adr/0261-recalled-facts-and-search-hits-name-their-source.md)
step 2). A fact's messages are mapped only through receipts that are done, not
retired and in the reader's own audience; one that does not map counts as
another person's words and is never shown. `by=owner` needs every message to be
the owner's own typing and cited. Only the model-written summary and fact lines
pass the guard; each line must come back with its own number and time, or the
block reads as before and the failure is counted as `source_tags`. A fact opens
by its record and number only for its own audience (the owner reads any), in the
current memory space, never for a bound reader (a private answer, a member's
private chat or the owner's ask about a member), never while memory is being
corrected, once memory no longer holds it, or once any of its stored sources
(or, for a fact whose sources may be incomplete, any message of its session) is
retired. The retired route reports such records in `retired_records`, so Hermes
withholds the stored rows that cite them.

The reply block a turn's frame carries (ADR-0261 step 3) is built by storage from
the reply relation the message's own read returned, the reader's read check and
one tag request, never from an id in a payload, and passes the guard with the
rest of the turn. Hermes takes `reply:{line, text, by, id}` only when the line
has its fixed shape (at most 300 characters, one line, a known `by` and an id
that are the line's own) and the text is one line of at most 200 characters, and
always unframes the text; a recent message's `[In reply to …]` part is checked on
its own and a bad one drops only itself. A forum topic's opening is never a
reply target. The `reply` read token makes a turn's notes `turn_read` when the
replied-to message is not the owner's own typing, Nocheh's own included; earlier
in the session only when the note copies from the block's text (a run, a
distinctive token, or a short text held whole). A note's `ref` (the first 12 hex
of its key) is shown only when storage kept that turn's refs in `note_lookups`
(pruned after 7 days; a failure is counted as `note_refs`); `archive_read
{note}` opens a ref's messages only for the turn whose lookup kept it, never for
a private answer, each through the reader's read check before it is tagged (a
check that fails opens none), and Hermes drops a ref that is not the note's own
key prefix. Retiring a message also withholds a later turn of the same session
whose note copied its text, with that note. The sentence on reading source lines is the recall evidence entry's
`about`, once per turn, and never part of a tool result.


For an existing installation, stop Hermes and its native writers before running
`python3 -m tools.operations.security.security_profiles /absolute/path/to/hermes --hermes-stopped`.
The converter checkpoints SQLite, validates integrity, moves the same database
bytes into `native-state`, and reports their hash. It never replaces history with
a model output. Browser history, native recall and portable export use the same
path. A shared memory-lock file coordinates trusted writers and exports.

The launcher derives the host profile path from its read-only Docker mount and
pins the installed image ID. `NOCHEH_AGENT_NETWORK` selects its internal network;
restored projects receive a separate network and do not clean up another project's
turns or boxes. Backups stop both security services and include policy/history
receipts.

The launcher also makes the sealed boxes of jobs the owner approved
([ADR-0205](adr/0205-owner-approved-jobs-work-in-a-sealed-box.md)). A box has no
network, keys, binds or Docker socket, and the job's turn reaches it only through
one socket mounted read-only. The broker decides which runs get a box; the
launcher follows the run's binding and removes every box the broker stops listing.
Each box and its socket volume carry the label
`nocheh.box.network=<NOCHEH_AGENT_NETWORK>`, and the launcher lists, counts and
removes only boxes with its own network's label, so two copies of Nocheh on one
Docker never remove each other's boxes. After a run that did not end by itself
with success, the launcher replaces that job's box at its next run.

| Variable | Purpose |
| --- | --- |
| `NOCHEH_BOX_IMAGE` | Box image, set by Compose from the workspace: `nocheh-box:local` for `personal`, `nocheh-<name>-box:local` for another workspace. `./bin/nocheh up`, `./bin/nocheh build` and `make dev` build it; the launcher pins its image ID at every box it makes |
| `NOCHEH_BOX_LIMIT` | Boxes that may exist at once, 2 to 8, default 2, since two jobs can run at once. The launcher does not start with less |
| `NOCHEH_BOX_TOKEN` | Lets the launcher ask the broker which boxes may exist and read a box's chat copy. Only `nocheh-security` and `hermes-agent-sb` receive it. `./bin/nocheh init`, `up` and `make dev` generate it when it is missing; it has at least 32 characters, differs from `SERVICE_TOKEN`, and Settings never shows it |

Without the token, no run gets a box and a job that asks for one is refused with
`job_box_not_allowed`. A box job approved before the token went missing does not
run as a plain job: its next run stops with `job_box_unavailable`. So does a box
job's run when the image is missing, the box limit is reached or the box cannot be
made. After two relaunches the job fails with `job_box_unavailable`, which System ›
Background work shows as "job box unavailable". The launcher logs one line at
startup that names a missing token or image, never the token. The owner turns
boxes off with **Sealed box for jobs** in Settings › Assistant.

The broker also relays the commands of a job that works on one of the owner's
machines ([ADR-0231](adr/0231-owner-approved-jobs-work-on-the-owners-machines-over-ssh.md)).
The run's own credential posts each command to `POST /v1/machines/exec`, which the
broker sends on to `nocheh-app` with a body limit that fits the command's 4 MiB
input, a 15-minute timeout and output capped at 8 MiB plus 64 KiB: `nocheh-machines`
keeps a command's output frames, headers included, within 8 MiB, and the 64 KiB
leave room for its notes and exit code. It makes no effect decision of its own: the
job's card is the approval and System › Machine log is the record. It passes the
machine refusal codes, such as `machine_off` or `machine_unreachable`, back to the
run unchanged. `nocheh-app` checks the job and calls `nocheh-machines`, which
holds the keys and runs `ssh`. Only `nocheh-app` and `nocheh-machines` receive
`NOCHEH_MACHINE_TOKEN`; `./bin/nocheh init`, `up` and `make dev` generate it when it
is missing, it has at least 32 characters, differs from `SERVICE_TOKEN` and
`NOCHEH_BOX_TOKEN`, and Settings never shows it. The broker, the launcher and turns
never hold it or a key. The run's binding names its machine, and the
launcher then starts the turn with `TERMINAL_ENV=nocheh_machine`, `TERMINAL_CWD=~`
and `NOCHEH_MACHINE_RUN=1`, without any extra mount or network. The turn asks no
approval per command, but Hermes's hardline floor and its block on guessing a
password through `sudo -S` still apply, and the file tools take paths on the
machine, where `~` is the machine login's home. A binding with
both a box and a machine is refused. Machine jobs need the isolated runtime: in
legacy mode the tool refuses a machine with `isolated_runtime_required`.

To return to the previous execution mode, set `NOCHEH_SECURITY_RUNTIME=legacy`
and `NOCHEH_MEMORY_CONTEXT=legacy` and restart Hermes with this version's image.
Sealed boxes need the isolated runtime. In legacy mode a job that asks for a box
is refused with `job_box_not_allowed`, and a box job approved before the change
fails at its next run with `job_box_unavailable`. Turn **Sealed box for jobs** off
first, so such a job's later runs go without a box.
The converted history remains readable. An older image that predates this layout
requires an offline reverse conversion; do not start it against converted profiles.
There is no automatic fallback when a required security service is unavailable.

Secret detection remains the existing ADR-0033 mechanism. It can produce false
positives: the live acceptance run observed a harmless synthetic colour being
masked. The exact saved owner-edit path is checked separately. This service adds
no classifier that discards memory, and finite fixture results do not establish
identical accuracy for every future conversation.
