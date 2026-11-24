# ADR-0293: "Do what I ask" runs a command only from the owner's typed words

<status>
Accepted on 2026-11-24. The owner chose: "A command runs with no card only when it
comes from your own typed words; one shaped by a forward, file or page gets a card."
On how far back to look, the owner chose "Whole current conversation". Amends
[ADR-0263](0263-only-addresses-no-model-built-open-without-a-card.md) ("Commands the
owner asks for in their private chat run as before") and
[ADR-0244](0244-owner-defaults-posts-and-machine-reports-stay-private.md) (what the
owner freedom setting runs).
</status>

<context>
- With "Do what I ask" on, every shell command the model proposed in the owner's
  private chat ran with no card. Nothing checked what else had reached the model: a
  forwarded message, a file, a quoted reply, a page or a search of other chats could
  word a command, and it ran in the agent's workspace.
- A turn answers one message, but the model also sees the day's whole session
  (ADR-0288), carried messages included, and each tool result it read before the
  command. Nocheh's storage sees only the message; the session lives in the agent's
  runtime.
</context>

<decision>

## What counts as outside

- **The asking message**, read from its captured original, album parts included: a
  forward of someone else's message or an inline bot's, any file, photo, voice note
  or audio, a reply or quote to anything but the owner's own typed message (Nocheh's
  messages included), and a message not from the owner.
- **The conversation the turn runs in**, everything the session holds before the
  model starts: the same lines in earlier stored messages (forward, file, transcript,
  reply, recent group messages), a retired message's stand-in, every tool result
  below, and a compaction summary (`past`), which may hold any of them.
- **Carried messages.** A new day's session and a new guard epoch carry typed
  messages and answers but drop tool results and summaries, so an answer that repeats
  a page would read clean. The carry records what its source rows read, and what was
  carried into them, in the profile's `nocheh-carried-reads.json`; a session it
  cannot record is not carried, and a record that cannot be read leaves the turn
  unreported.
- **Tool results in the turn**: archive and memory search, web pages, Notion, Gmail,
  GitHub, another server's tools, past-session search, the task list (it holds what
  members and groups wrote), and any other tool, an operation's status and skills
  included (`other`). Not counted: a command's own output, this chat's notes and
  memory recall, and Nocheh's answer about a message or time zone it was asked to
  set.
- **Operations of this message** that came back with a result (`browser` as `web`,
  `mcp` as `tools`).

## Who records it

- Storage keeps `turn_reads(event_id, origin, read)`; reads only accumulate, so a
  turn never turns clean again, and the same command proposed twice keeps its card.
- The agent runtime's parent process, outside the model's reach, scans the session
  and reports it before the model starts (`POST /v1/turn/conversation-reads`, origin
  `conversation`; a clean session is kept as `none`). It does this for the owner's
  live private turns only. A turn it never reported counts as outside
  (`unchecked`), so a runtime that cannot read its session, or never reports, gets
  cards.
- The runtime's tool-result hook names each result's read
  (`/v1/context/prepare?read=<token>`, origin `turn`) before the model sees it.

## The decision

- `proposeOnce` asks only for a shell command under `owner_requests_execute`. When
  anything counts, the setting does not approve it, the usual card follows, and
  `controlled_actions.outside_reads` keeps the reasons. The card adds one editable
  line (`outside_note`) saying why "Do what I ask" asked first.
- Unchanged: an "Always allow this command" chat rule, the owner's own choice for
  that exact command, still runs it; web reads and server tool lists open by
  ADR-0263's address rules; a message to the owner's own chat; group tools.
  Follow-ups and jobs already ask.

</decision>

<consequences>
- A forward, file, voice note or page in today's session puts a card on every later
  command until the next day's session starts. Commands are rare, and the card keeps
  its "Always allow" button.
- The owner's own voice note counts: it is not typed, and its transcript is the only
  text.
- Known gaps: pasted text, a forward sent as a copy with the sender hidden, and text
  the owner reads aloud cannot be told from typing; long-term memory and notes, which
  reach every turn, are not counted; files already in the workspace are not tracked.
</consequences>
