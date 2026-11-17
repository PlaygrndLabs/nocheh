# ADR-0259: Recalled facts and search hits name their source

<status>
Step 1 accepted on 2026-11-17; steps 2 to 4 are planned. The owner asked for
memory to track the source of each fact, not only to keep history without its
thread and relations, and to do it before the MVP. The design "Recalled facts
and search hits name their source" was reviewed three times (an adversarial
review, a check of its claims against the code, and a check for losses and
leaks), and every finding was checked again against the code before it was
taken. Of the three questions to the owner, this builds the recommended answer
to each, which the owner may still change: in a group the owner's own words are
named by the owner's Telegram name like anyone's, with `by=owner`; the owner's
own chats show times in the Settings › Tasks time zone, with the zone named,
and every other reader reads UTC; in the owner's own chats someone the owner
renamed reads “Bob”, saved as “Brother”, and nobody else ever reads a People
name. Builds on [ADR-0256](0256-nochehs-own-messages-carry-a-send-class.md)
and [ADR-0257](0257-learned-memory-names-its-source.md), and closes ADR-0257's
follow-up "Labels on search hits". Amends
[ADR-0157](0157-group-turns-see-recent-unaddressed-messages.md): retiring a
recent message withholds its text and that turn's tool work and notes, and the
turn's own message and answer stay.
</status>

<context>
- Search hits were archive messages with ids, chat ids and raw times. The model
  had to work out who wrote one, and in which chat, from the text and fields
  that are not built for that, and a name in a message could read like a label.
- Opening a message showed it alone. What it replied to, the replies to it and
  where a forward came from were in the archive's relations, but no tool showed
  them.
- Retiring a message that a group turn carried as a recent message left that
  turn's tool results, and the note written from them, in Hermes's stored
  history: the stored row cited the message only inside Nocheh's own frame,
  which the retirement plan did not read. The owner's next turn could still be
  led by it, and the note outlived it.
- Owner recall's hits from Hermes's stored chat history always had empty text:
  the pinned Hermes search returns a snippet and the neighbouring rows, never a
  row's content, and Nocheh read the content.
- In a group whose topics share memory, recall dropped every source learned in
  a sibling topic, because its evidence was read for the asking topic's
  audience alone. It also kept evidence that had been retired since.
</context>

<decision>

## 1. A source tag is built by code

- A tool result that names a source carries, beside every field it had,
  `tag` (who · where · when, at most 160 characters), `by` (whose words:
  `owner`, `person`, `forward`, `file`, `mixed`, `nocheh`, `shared` or
  `unknown`) and `at` (the moment, as an ISO time). Code builds it from the
  archive, the reader's own copy of the message and Nocheh's records; the
  model never writes one, and nothing in a message's text can.
- **who.** For the owner reading their own chats, the owner's own messages read
  `the owner`, told by the account, never by a name. For anyone else, the
  owner's messages read like anyone's, by the name Telegram showed, with
  `by=owner`. A person is the quoted name from the reader's copy, with
  ` (@username)` when Telegram gave a valid one; a member named "the owner"
  reads `“the owner”` with `by=person`. With no name it reads `a person`, never
  digits. Names are cleaned (`tagName`): brackets, quotes and their
  look-alikes and control or format characters go, the joiners Persian and
  Arabic names need stay, and a name is cut at 40 characters. Who wrote a
  message is read only by `telegramSenderName` in `src/chats-telegram.ts`.
- **People names.** Only in the owner's own chats, and only a name the owner
  set (`ownerChosenName`: never an untouched identity's or the automatic
  `telegram actor …` name), and only when it differs from the name Telegram
  showed: `, saved as “Brother”`.
- **where.** `this chat` for the reader's own chat; otherwise the group, topic
  or chat in fixed words (`modelPlace`). A member reads only the names Telegram
  showed (`recallNames` with `shownOnly`), so a topic whose only name the owner
  typed reads `› a topic`.
- **when.** Telegram's own seconds, else the time Nocheh saved the message,
  written `YYYY-MM-DD HH:MM <zone>`: the owner's Tasks zone for the owner, UTC
  for anyone else. An old Telegram Desktop export that wrote only a local time
  with no zone reads `… local time of the export`, never converted.
- **what and by.** A message that is not its sender's own typing says so
  (`forwarded from a channel shown as “City News”`, `text of a file (“…”)`,
  `quoting another person's message`, a pin, a reaction, a card). `by` is the
  message's ADR-0257 group (`bucketOf`), so `owner` only for the owner's own
  typing, a card `person` and Nocheh's reply about a forward `forward`. Trust
  keys on `by`, never on the words.
- **Who may read it.** Every tag, related message and count passes the
  reader's own read check first: a batched `readable()` that a property test
  holds equal to `canRead`. A source the reader may not read reads only
  `source not available here`, with no who, where, when or count. A member
  never reads the owner's private chat, another group, a sibling topic whose
  memory is kept apart, a People name, an owner-typed topic name or the
  owner's time zone.
- **One secret check.** All of a request's tags go through the guard in one
  `prepare` call. A tag that cannot be built never fails the read: it reads
  `source not available right now` with `by=unknown` and is counted as the
  `source_tags` memory problem, shown on System › Health and in the owner's
  notice. A moved binding is rethrown, not counted.
- Tags are given only to readers inside a turn; the dashboard, admin reads and
  reads outside a turn get today's shapes.
- How to read them is said once, in the tool descriptions; it is never repeated
  inside a tool result, so stored history does not pile it up.

## 2. Search hits (additive)

- `archive_search` hits, `memory_search` hits (the first three of each learned
  batch, at most ten tags; every hit, id, order and text as before), the
  reaction and its targets in `current_reactions`, shared releases and grants
  (`shared by the owner on <day>`, the share's own day in the reader's zone,
  `by=shared`) and `archive_page` items name their source. Nothing any of them
  showed before is removed.
- `archive_page`: `from` no longer falls back to the numeric sender id (it
  reads `a person`); an item the owner typed has `owner:true`; a reply whose
  message is off the page has `reply_source`, which `archive_read` opens. A
  message in a forum topic is no reply to the topic's opening, so it gets
  none; a Telegram Desktop export's reply into another chat
  (`repliesElsewhere`) loses its `reply_to`, which names that chat's message.

## 3. Opening a message with its thread

- `archive_read` takes `replies` (0 to 10, default 3) and `chain` (0 to 5,
  default 1). A message keeps every field it had and adds its `tag`, `by`,
  `at`, `chat_id` (with `at`, `archive_page` opens the conversation around
  it), `forward` (where a forward came from) and `topic`; `answers` (the
  message Nocheh's reply answers, with its own read check); `reply_to` (the
  message it replies to) and `chain` (the messages before that); and `replies`
  (how many readable replies, counting up to 100 and saying `complete:false`
  beyond, and the first of them). Each related message has its source, tag,
  `by` and the reader's own copy of its text, cut short.
- Outgoing links come from the archive's relations filtered by audience, then
  the read check. Incoming links come from a new
  `RelationshipRepository.replies`, filtered by audience, then the read check.
  A topic's opening has no reply target: a message in the topic names the
  topic instead, and the opening's replies read
  `{count:0, items:[], topic:true}`, since `archive_page` opens the topic.
- The whole result stays within 16,000 characters: only what this decision
  adds is cut (further replies, the chain, `answers`, `reply_to`), and the
  result then says `thread_cut:true`.
- `archive_read` also opens `nocheh:grant:<id>` (what the owner granted, through
  the grant's own checks) and `nocheh:learned:<id>:<revision>` (an entry's
  active revision, with who wrote it, its day in the reader's zone and five of
  its sources, tagged). Neither is open to a private answer.

## 4. Retire means forget at once

- Hermes's retirement plan reads the messages Nocheh's own frame quotes at the
  top of a stored turn, in its fixed order and never past the turn's own
  `[Archive source: …]` marker: the recent group messages, the speaker line and
  a replied-to block. Text inside a message cannot open such a span, since the
  frame's words are taken out of members' text.
- A retired recent message or replied-to block is replaced by
  `[Quoted message withheld; it was retired: nocheh:event:<id>]`, and counts
  for the rest of that turn like a retired turn message: its tool calls and
  results are withheld, the note written from them is removed, and the
  delivered answer keeps its text with only its reasoning cleared. The turn's
  own message and marker stay.
- Recall evidence is read only from writes that are not retired. For anyone
  but the owner it is read within the reader's group when its topics share
  memory (so a sibling topic's evidence is kept), and each source passes the
  reader's read check; one that does not is dropped and counted as
  `source_reference_unreadable`.

## 5. Owner recall shows what it found

- Owner recall's hits from stored chat history carry the hit row's own text, at
  most 120 characters around the match, the time Hermes stored it in UTC, and
  the message ids it cites. Hermes's neighbouring rows are never asked for.

## 6. Later steps (planned)

- **Step 2: facts name their source.** Each long-term memory fact in a turn's
  evidence and in `memory_recall` carries the sources Honcho cited for it, in a
  source line built the same way, and opens with
  `archive_read nocheh:memory:<id> fact=n`; a fact whose source was retired, or
  whose conclusion a correction deleted, does not open.
- **Step 3: replies in the turn.** A turn that replies to a message carries
  that message's text in a reply block, recent messages say what they reply
  to, and a note written from it reads as having read it.
- **Step 4: dashboard.** Messages › detail shows a message's thread and what
  was learned from it; Memory › Long-term lists facts with their sources.

</decision>

<alternatives>
- **Tags written by the model, or read from the text.** Rejected: a name or a
  planted line could claim the owner's words.
- **"the owner" in groups.** Not chosen: it would tell members which account is
  the owner's. The model already knows which speaker is the owner, and `by`
  carries the trust.
- **One time zone everywhere.** Not chosen: the owner reads their own time in
  their own chats; a group never learns the owner's zone.
- **Removing fields a tag repeats.** Rejected: nothing the owner or members get
  today is removed.
- **Withholding only the quoted text of a retired message.** Rejected: the
  turn's search results and its note would keep what was retired.
</alternatives>

<consequences>
- Every search hit and opened message says who wrote it, where and when, in
  about 25 more tokens a hit. Tags fresh in the guard epoch cost one more
  secret check per request.
- What the owner loses:
  - `archive_page` no longer shows a sender's numeric id where Telegram gave
    no name.
  - An old Desktop export's reply into another chat no longer links to a
    message of this chat with the same number.
  - Members read `› a topic` for a topic whose only name the owner typed.
  - People names show only when the owner set them.
  - Old Desktop export times read as the export's local time.
  - Retiring a recent message or a replied-to message also withholds that
    turn's tool results and notes in later turns; the delivered answer stays.
- Tags are information for the model, not permission: every access check is
  unchanged, and `by` keeps ADR-0257's fail-closed groups.
- A failed tag is counted as `source_tags`; the read still answers.
</consequences>
