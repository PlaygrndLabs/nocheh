# ADR-0205: Jobs the owner approved work in a sealed box

<status>
Accepted on 2026-11-03, as step 3 of the steps the owner chose with "All three, in
order" so Nocheh works like a Claude Code session: a background job runs commands,
edits files and runs Python over a long chat with Hermes's own tools. The owner
chose on 2026-11-03 to turn link previews off for every bot message. Extends
[ADR-0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md),
[ADR-0200](0200-waiting-approvals-survive-reaction-epochs.md),
[ADR-0203](0203-owner-approved-jobs-read-notion.md) and
[ADR-0204](0204-a-jobs-changes-come-on-list-cards.md).
</status>

<context>
- The owner wants a job to work like a coding session: search a whole chat, keep
  notes in files and compute with Python, step after step, without a card for each
  command.
- A job's steps had only Nocheh's archive tools, Notion, and shell or browser
  operations that wait for the owner. Hermes's own terminal, file and code tools were
  off in every turn, because they would run in the turn container, which holds the
  turn's credential and can reach the broker.
- A job reads group text that anyone in the group can write, and it runs unattended.
- The default Docker host has neither gVisor nor user namespace remapping, so a
  sandbox must rely on plain Docker containers.
</context>

<decision>
- Only a job the owner asks for in their private chat, which the owner then
  approves there, can ask for the sealed box. "Sealed box for jobs" in Settings ›
  Assistant, on by default, must be on, the runtime must be the isolated one, and
  the box token must be set. Otherwise the proposal fails with
  `job_box_not_allowed`, and the agent is told so; the request is never quietly
  dropped. The broker passes this and the other fixed job error codes to the agent.
- The box is part of the job's fingerprint, so asking again in the same turn for
  the same job with only the box changed fails with `job_changed`, and the agent is
  told so; the card already posted stands. The card adds the line "🧰 It can run
  commands and Python in a sealed box: no internet, no keys, only the checked
  messages of the chat it reads." A saved card text without `{box}` or `{notion}`
  still gets that line at its end, so the owner always sees it before approving.
- A work step gets the box only while `ownerApprovedJob` passes, the switch and the
  guard are on, and the box time has not passed: the job's start, plus its time
  limit, plus one hour. The short last step at a limit never gets one. A step after
  the box time runs as a plain step instead of failing.
- In a box step, Hermes's own `terminal`, file tools (read, write, search, patch)
  and `execute_code` run in the box. The step keeps Nocheh's archive tools and
  Notion as ADR-0203 and ADR-0204 allow. It loses the approved shell, the browser,
  Hermes memory and subagents. If the step and the turn's environment disagree in
  either direction, for example because the launcher could not make the box, the
  turn stops with `job_box_unavailable` before the agent runs. After two retries the
  job fails with that code, and System › Background work shows it. A hook blocks
  these tools in every other turn, and blocks on any error.
- No box tool outlives its step. Each box command's time is cut to the step's time
  left less 30 seconds. When that leaves less than 10 seconds, a box tool is refused
  with "This step's time is up. Write down what you found so far; the next step
  continues." A code cell's time limit is at most the time left less 40 seconds, so
  Hermes still stops a cell that runs out of time: its own commands reach the box
  until the step's deadline. An idle code kernel ends after 600 seconds.
- The box is one container for each job, made by the security launcher. It has no
  network, keys, binds or Docker socket. Its root is read-only, it drops all
  capabilities, and it runs as uid 65532 with 1 CPU, 1 GiB of memory, 128 processes
  and 256 MB in `/work`. Its image is pinned to an image ID each time a box is made.
- The turn reaches the box only through one socket on a 1 MB volume. The volume is
  mounted read-only in the turn, and without setuid, devices or programs on both
  sides. The turn opens the socket without following links. The box server refuses
  callers with its own uid, so box commands cannot use it.
- `/chat` holds a read-only copy of the job's own chat and period, taken from the
  job's row only. It holds the messages that passed the secret check, one JSON
  record per line, oldest first in each part. Reaction updates are left out, but an
  imported message keeps the reactions it was exported with. A record's text and
  file texts are never cut until they pass 600,000 characters in all; past that
  they are cut with a note. A message still being checked is left out and
  counted, and a later step adds it. The copy is written as another uid, so box
  commands can read it but never change it. Each part is checked by size and
  checksum before it is kept.
- Filling `/chat` takes at most 120 seconds for each step. The step then starts, and
  `/chat/manifest.json` says how much arrived. A page holds at most 200 records and
  fits in 8 MiB. `/chat` holds 128 MB. A part that does not fit ends the copy for
  good: the manifest says `"complete": false, "full": true`, and that box is never
  filled again.
- A box is kept from step to step while only reactions or automatic learning
  revisions have changed since it was filled (ADR-0200). Neither changes the chat's
  messages. Any other change, such as a hidden message, an edited copy or
  a guard change, replaces it with a new box and a fresh copy. So does a step whose
  turn did not end by itself with success: it failed or was killed, or its caller
  went away. Nothing such a step left running, such as a code cell, reaches the
  next one. `/work` is lost then, and when the job ends.
- `NOCHEH_BOX_TOKEN` is held only by the broker and the launcher. `./bin/nocheh init`,
  `up` and `make dev` generate it when it is missing. The broker's two box routes,
  which only the launcher calls, need it: the list of boxes that may exist, and the
  chat copy. The chat copy also needs the step's own credential, and refuses owner
  credentials. Without the token, no step gets a box and a job that asks for one is
  refused. A box job approved before the token went missing does not run as a plain
  job: its next step stops with `job_box_unavailable`. No other relayed read can ask
  for whole texts.
- Every 15 seconds the launcher removes each box the broker no longer lists: its
  job stopped or ended, Stop was pressed, the switch or the guard went off, what the
  job may read changed, or its time passed. It removes all its boxes after two
  minutes without an answer, and at start and stop. Each box and socket volume
  carries `nocheh.box.network` with the installation's `NOCHEH_AGENT_NETWORK`, and
  the launcher lists, counts and removes only boxes with its own, so another copy of
  Nocheh on the same Docker keeps its boxes. At most `NOCHEH_BOX_LIMIT` boxes exist
  at once, 2 to 8, default 2, since two jobs can run at once. A box the sweep would
  remove holds no place.
- No Hermes note points the model to a file the box cannot open. A command that
  names Hermes's results folder, the turn's Hermes home or its spill folders is
  refused before it reaches the box, whatever the box would answer. The box
  environment is made when the step starts, and terminal and Python output kept in
  the turn is dropped. An oversized result then keeps Hermes's inline preview.
- Each box step's text tells the agent what `/chat` and `/work` hold, how the copy
  is ordered, that reaction updates are left out while an imported message keeps
  the reactions it was exported with, that the copy stays partial for good when the
  manifest says `full` while the archive tools still read the rest, that the box has
  no internet, and that its work is lost when the job ends. The owner can edit it as
  `background.box`.
- Only Notion's known read tools count as reads. In a job step, a read by address
  runs without asking only for a raw ID, a notion.so address, or a data source or
  view ID. Any other tool or address asks.
- Link previews are off for every message the bot sends or edits.
</decision>

<note date="2026-11-04">
Amended by [ADR-0207](0207-a-background-job-is-one-hermes-run.md): the box, the
deadline of its commands and the /chat copy belong to each run of a job, not each
step, and there is no wrap-up step to leave out. Box commands end at the job's hard
deadline, three minutes after its time limit, and the box expires five minutes after
that. /chat is filled once, when a run starts; a run after one that ended abnormally
gets a new box.
</note>

<note date="2026-11-04">
Extended by [ADR-0208](0208-running-jobs-carry-across-quiet-epochs.md): a job's run
goes on across reaction epochs and automatic learning revisions, which no longer wait
for it, so its box stays for the whole run under the same rule. Any other change
still ends the run, and its box with it.
</note>

<note date="2026-11-05">
Extended by [ADR-0209](0209-owner-approved-jobs-read-a-github-copy-in-their-box.md):
a box can also hold `/repo`, a read-only copy of a GitHub repository the job pinned
when it was asked for. A repo box gets a 256 MiB `/repo` tmpfs and 512 MiB more
memory, and the box image has git. The box still has no network and no keys.
</note>

<consequences>
- A job can search and compute over a whole chat without a card for each command.
  Group text can steer those commands, but they run with no internet and no keys,
  and their output reaches the model only through the secret check.
- What the agent writes to `/work`, such as Notion reads, can pile up across steps
  next to the chat copy. It still has no way out but tool output.
- Still open: the box runs under Docker's default runtime, without gVisor or user
  namespace remapping, so a flaw in the host's kernel could let a command out.
- Still open: the box server and box commands share one uid. A command can kill or
  replace the server or read a pending script, which breaks only its own job's box.
- Still open: the secret check of a box step's output is not counted in the job's
  cost or its cost limit. It runs at background priority, so replies go first.
- The chat copy's pages are not kept as already checked values, so filling a box
  adds nothing to what each secret check loads, however long the chat. Box output
  that quotes `/chat` is checked again.
- Turning the switch off removes running boxes within seconds. A step that loses
  its box mid-way gets a plain tool error, and later steps run without one.
- The backend, the hook and the spill handling rely on Hermes internals. If an
  upgrade renames the backend or hook internals, the hook blocks the box tools or
  the step fails. A renamed spill key or function fails silently, and Hermes's note
  pointing to a file the box cannot open comes back. Each Hermes upgrade must run
  the box checks again before it ships.
- Hermes's code limits (120 seconds, 20 tool calls, one kernel, 600 seconds idle)
  and output limits are fixed for every profile, but only box steps use those tools.
</consequences>
