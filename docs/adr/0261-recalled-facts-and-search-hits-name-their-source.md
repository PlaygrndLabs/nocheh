# ADR-0261: Recalled facts and search hits name their source

<status>
Step 1 accepted on 2026-11-17, steps 2 and 3 on 2026-11-18; step 4 is
planned. The owner asked for
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
- Long-term memory reached a turn as Honcho's prose: numbered facts, each with
  the time Honcho learned it, under a header naming whose facts they were, and
  named by the session or workspace they came from. Which message a fact came
  from, who wrote it and whether it was the owner's own words were not said,
  and nothing opened the original. `memory_recall` listed up to 256 archived
  messages behind its answer (`evidence_sources`), with no word on which fact
  each one supported.
- Honcho cites the messages each fact rests on when its deriver gives them
  (`source_message_ids`); a fact with no citation is known only with the batch
  it was learned in, through Nocheh's own Honcho plugin. Some cited messages
  are context, not the fact itself: the deriver cites the question a "yes"
  answers, which may be the owner's.
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
  A Telegram Desktop export wrote the names the exporting account saw, which
  for a saved contact is the name the owner gave them, so anyone but the owner
  reads `a person` for an exported sender and an unnamed origin for an
  exported forward (an inline bot's public username still shows).
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
  reads `a person`); for anyone but the owner, a Telegram Desktop export's
  sender reads `a person` and its reactions are counts without names; an item the owner typed has `owner:true`; a reply whose
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
  (how many readable replies, counting up to 100 in the reader's own groups and
  saying `complete:false` beyond, and the first of them). Each related message has its source, tag,
  `by` and the reader's own copy of its text, cut short.
- Outgoing links come from the archive's relations filtered by audience, then
  the read check. Incoming links come from a new
  `RelationshipRepository.replies`, read only in the audience's own groups (so
  replies elsewhere never take the place of those it may see), filtered by
  audience, then the read check.
  A topic's opening has no reply target: a message in the topic names the
  topic instead, and the opening's replies read
  `{count:0, items:[], topic:true}`, since `archive_page` opens the topic.
- The whole result stays within 16,000 characters: only what this decision
  adds is cut (further replies, the chain, `answers`, `reply_to`), and the
  result then says `thread_cut:true`.
- A thread or a page's links that cannot be worked out never fail the read:
  the message opens as before with its source `not available right now`, the
  page reads without `owner` or `reply_source`, and the failure is counted as
  `source_tags`.
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
  own message and marker stay. A tool result withheld because it held a
  retired message's text counts the same way for the rest of its turn, so a
  note copied from it goes too. A second retirement in the same block keeps
  the first one's notice, and `archive_page`'s `reply_source` link alone, which
  holds none of that message's text, cites nothing.
- The checked revision is stored with the version of these rules, so a
  profile checked before them is planned again once, and a message retired
  before this change leaves its recent blocks too. Until a profile's next turn,
  owner recall skips the rows that turn will withhold and the notes it will
  remove.
- Recall evidence is read only from writes that are not retired. For anyone
  but the owner it is read within the reader's group when its topics share
  memory (so a sibling topic's evidence is kept), and each source passes the
  reader's read check; one that does not is dropped and counted as
  `source_reference_unreadable`. The owner's own turns check their evidence
  too, so a message retired since it was learned is no evidence; the check is
  one batch for all of a recall's messages.

## 5. Owner recall shows what it found

- Owner recall's hits from stored chat history carry the hit row's own text, at
  most 120 characters around the match, the time Hermes stored it in UTC, and
  the message ids it cites. Hermes's neighbouring rows are never asked for.

## 6. Recalled facts name their source (step 2)

- **Reading facts.** The memory socket gains `facts()` (Honcho's stock cursor
  list of a participant's explicit facts about itself, 100 a page, within the
  turn's sessions when it is limited to them), `factsById()`, `factExists()`,
  `mostDerived()`, `citationCoverage()`, and the summary's message from
  `context()`. A list answer about another participant, from a session outside
  the allowlist, of another level or without a cursor page is refused as
  invalid. A cited fact's messages are its citations. Only for an uncited fact
  does Nocheh's Honcho plugin give its learning batch (`per_node` mode of the
  provenance route, 128 facts a call, at most 8 messages each, with
  `messages_truncated`); such a fact is never exact, and a failed or old
  plugin leaves it with no messages (`fact_batches_unavailable`,
  `fact_batches_unsupported`, `fact_batches_invalid`) without failing the read.
  `GET /citation-coverage` and `citationCoverage()` can count how many live
  facts cite their messages; nothing calls them until step 4.
  No Honcho code or setting changes, and nothing is learned again.
- **From fact to message.** One query maps a fact's messages to Nocheh's
  receipts that are done, not retired and in the reader's audience (the
  reader's group for a group, the read set for a private answer); every
  message a receipt carries is a source. A message with no such receipt counts
  as another person's words, makes the fact not exact and is never shown or
  counted. Sources are read-checked as learned (`readable(…, {historical})`).
- **Order, `by` and the source line.** The fact's own participant's messages
  come first, then the rest in citation order. `by` follows ADR-0257's groups
  over every source, readable or not: `person`, `forward` or `file` when one of
  them is there, `mixed` for more than one, else `nocheh`, and `owner` only
  when every source is the owner's own typing and the fact cites them. A fact
  that is not exact also rests on messages Nocheh cannot see: Honcho's deriver
  reads every peer's messages of a batch but keeps only the observed peer's as
  its batch (`H:src/deriver/deriver.py`), and a cut citation list leaves some
  out. Those count as another person's words, so such a fact reads `person`
  (or `mixed` with a forward or a file), never `owner` or `nocheh`. A cited
  list is exact only when it is whole. The source line names the first
  readable source that is a person's, a forward or a file, else the first not
  the owner's, else the first: a fact about Bob that cites the owner's question
  and Bob's "yes" reads `Source [by=person]: “Bob” · this chat · 2026-11-03`.
  A fact that is not exact and names only the observed peer's own messages
  names no sender, only where and when: in GP1, an uncited fact about the
  owner learned from Bob's "Alex owes me 500" and the owner's "ok" reads
  `Source [by=person] (not exact; learned with other messages): learned in “GP1” on 2026-11-05`,
  in the block, in `memory_recall` (its sources with `by=unknown`) and when
  opened.
- **A turn's block.** Each block of long-term memory a turn reads (a group's
  speaker within the turn's session; the owner across the space; the owner's
  forwards and files, 100 facts each, as Honcho's own context held) lists its
  facts as `  n. HH:MM fact`, the time of its named message in the reader's
  zone (`--:--` when the reader may read none, under
  `Source [by=…]: not available here`), grouped under code-built source lines
  at day precision, groups oldest first. A fact known only with its batch says
  `(not exact; learned with other messages)`. A line opens the block:
  `[To open a fact's original: archive_read id=nocheh:memory:<id> fact=<n>. …]`.
  The summary's header names the day of the last message it covers. Only the
  summary and the fact lines go through the guard; every line must come back
  starting with its own number and time, and a model line that reads like a
  source line, header or fact line gets a leading `(` (after its invisible
  characters and markdown marks, in any case, or with `[by=` anywhere). The
  block keeps the 20,000-character
  limit, the oldest facts left out first with `[N older facts left out]`.
- **The block's record.** The block is named by its bounded record,
  `nocheh:memory:<id>`, whose raw parent (Honcho's output, which the guard
  never reads) keeps every fact's conclusion, exactness, `by`, time, every
  source in order, how many it did not show, whether Honcho named all of its
  messages (`complete`: only a whole citation list; a batch never is) and its
  session; only the block's text is checked for secrets on the turn path. The
  record's configuration holds a digest of that, so a changed source makes a
  new record and the same facts reuse theirs. History retention never prunes
  a block of facts. `exact_citations` is true only when every fact shown is
  exact and no summary is shown (`some_facts_cite_only_their_batch`,
  `summary_has_no_exact_citations` otherwise). Prefetch builds the
  same block. When the owner's turn has no learned session to read, the
  owner's profile is rebuilt from the same list as Honcho picks it: its 25
  most-derived facts, then the newest, up to 50; the plugin is asked only
  about the 50 chosen. A plugin that cannot give batches is counted as a
  `source_tags` problem as well as named in the block.
- **Prose when facts can't be named.** An engine without `facts`, a fact list
  or a tag request that could not be read, or a guard that moved a fact line
  gives the block as before, in prose named by its session, with
  `source_tags_unavailable`; the failure is counted once as `source_tags`.
- **`memory_recall`.** Its answer is named by its own record
  (`nocheh:memory:<answer id>`, no longer the workspace id), and its facts by a
  second record (`facts_source`). It lists `facts`: at most 12, cited ones
  first, each with `n`, its text (at most 240 characters), `exact`, `by`, its
  first two readable sources tagged and how many more, and `evidence_count`.
  Every fact the answers read, up to 200, is stored with all its sources on an
  unguarded record whose child, the facts record, holds only their texts,
  read within the sessions the recall asked; its texts are guarded and
  line-checked (`fact_text_unavailable` drops the texts, never the
  record). `evidence_sources` stays only where facts can't be listed
  (`recall_facts_unavailable`, counted).
- **Opening a fact.** `archive_read` takes `nocheh:memory:<id>` with `fact`
  (1 to 200): the fact's line of the record's guarded copy, read under the
  current binding, at most 2,000 characters, with its `exact`, `by`, `at`, its
  first ten readable sources tagged and how many more, and the record's id as
  `source`. Without `fact` it lists the first 20 facts' numbers, `by` and
  tags, a forgotten one as `{n, unavailable:true}`. It opens only a turn's
  block or a recall's facts record, of the reader's own audience (the owner
  reads any) in the current memory space, and never for a bound reader (a
  private answer, a member's private chat or the owner's ask about a member,
  [ADR-0262](0262-member-private-chat.md)).
- **Retire = forget, for facts.** A fact does not open while a correction is
  running, once Honcho no longer holds it, or once its record rests on a
  retired message, by the same rule the retired route uses, so no fact of a
  withheld record opens. A fact whose stored sources may be incomplete (any
  fact learned with its batch, a cut citation list, or a cited message that
  did not map) counts as retired when any message of its Honcho session is.
  Storage's retired route reports a
  record of facts or a recall's answer as retired when any of its evidence is,
  and lists it in `retired_records`; Hermes's retirement plan then withholds
  every stored row that cites it (a recall, an opened fact) and names the
  record as `nocheh:memory:<id>` in the notice.
- **Members.** Every source, count and tag passes the reader's own read check;
  a group never opens another group's record or reads the owner's private
  chat through a fact.

## 7. Replies in the turn and where notes came from (step 3)

- **The reply block.** When a turn's own message replies to a message its
  reader may read, the turn's frame quotes it before the message's own text:
  after the speaker line in a group, first in the owner's chat, and before a
  forward's line.

  ```
  [Replying to, by=person: “Alice” · this chat · 2026-11-03 14:12 UTC] (source nocheh:event:<64 hex>)
  <at most 200 characters of the reader's own copy of its text, on one line>
  [End of replied-to message]
  ```

  Storage builds it (`SourceRepository.repliedTo`, `replyBlock` in
  `telegram-dispatch.ts`) from the reply relation the message's own read
  already returned, one batched `readable()` and one tag request, never from an
  id in a payload. The line is at most 300 characters, its tag at most 160; a
  message with no text reads `[A message without text]`. A reply to Nocheh
  reads `by=nocheh` with Nocheh's own text (a card `person`, a reply about a
  forward `forward`), so "source?" finds what it asks about. A message the
  reader may not read, a retired one, one in another chat or a forum topic's
  opening gives no block. It goes to Hermes as `reply:{line, text, by, id}`,
  through the guard's `allow` with the rest of the turn; `reply_block()` in
  `turn_process.py` takes it only when the line has the fixed shape, its `by`
  and id are the line's own, both limits hold and the text is one line, and
  always unframes the text, since it may be someone else's words. The owner's,
  a group's and a private answer's turns get it (a private answer quotes what
  its question replies to, read under the answer's own access), and so does a
  member's own private chat (ADR-0262), first as in the owner's chat and read
  as that member reads: their own chat and the groups their chat reads, never
  the owner's chat or another private chat, and the member's own text after it
  is unframed. A reply to Nocheh's answer to an ask about a member (send class
  `member_read`) gives no block, since no reader but the dashboard reads that
  answer. The owner's ask about a member gets none: its frame is Nocheh's own
  and its reader reads only that member's chat. A command's fixed reply runs
  no model and gets none.
- **Recent messages say what they reply to.** A recent group message that
  replies to another carries, on its own line after its speaker line,
  `[In reply to, by=<by>: <tag>] (source nocheh:event:<id>)`: who · where ·
  when, never the text. All of a turn's recent messages are looked up at once
  (one batched read of their reply targets, then `readable()` and tags). A part
  that is not well formed drops only itself; the speaker line keeps its own
  check, so a long name never loses the part.
- **A forum topic's opening is no reply.** Telegram sends every message in a
  topic as a reply to the topic's opening message (`forum_topic_created`, or a
  Telegram Desktop export's `topic_created` service message,
  `telegramTopicOpening`). Such a reply gives no block, no part and no `reply`
  read, whether the opening shows on the archived target or in the reply the
  message embeds.
- **Retiring a replied-to message.** The retirement plan of step 1 already
  reads both shapes: a retired reply block becomes the withheld notice and
  withholds the turn's tool work and the notes written from it, and a retired
  reply part replaces only its own line. Frame words are taken out of members'
  text, so a member's `[Replying to …` reads `(`.
- **Notes after a reply.** A turn whose message replies to anyone's message but
  the owner's own typing reads `reply`: its notes are `turn_read`, "after
  reading the message it replied to" for the model (`turn_read` already says
  the words are not the owner's, and a label in the owner's chat stays whole)
  and in the owner's words (`read_reply`, editable in Settings › Assistant).
  Nocheh's own message counts too, since it may carry what others said (it
  fails closed). Later in the session a reply block counts only for a note
  that copies a run of 32 characters or a distinctive token from its text, as
  other people's recent messages do, or, for a text shorter than a run but of
  at least 12 characters, holds it whole; a reply part, which holds no text,
  never counts.
- **Retiring a message a later turn copied.** A note a later turn of the same
  session wrote by copying a retired message's text (the same copy check:
  the turn's own message, its replied-to block, a recent message or a tool
  result that held it) is withheld with that turn's tool work, as the turn
  that quoted it is (`plan()`, rules version `quoted2`, so profiles already
  checked are planned again once).
- **A note's ref opens only what passes canRead first.** `archive_read
  {note}` and the owner's recall check access before tagging
  (`SourceTagRepository.checked`); a check that fails opens no source and is
  counted as `source_tags`. Refs that could not be kept are counted as
  `note_refs`, a notice line of their own.
- **When a note was written.** A review's label names the day of the message it
  is named by (another person's, a forward or a file first), in the reader's
  zone, read for all of a lookup's reviews in one query; the day comes before
  the place, so a label cut at 120 characters loses place words, not the day:
  "Nocheh's notes review on 2026-11-03 of another person's message in …". A
  turn's note records the moment it was written (`at_time`, accepted only when
  its UTC day is the note's `at`), shown as a day in the reader's zone; a note
  written before reads its day marked `UTC`. The owner's chat reads the
  Settings › Tasks zone, any other reader UTC.
- **Note refs.** Each note in a turn's evidence carries `ref`, the first 12 hex
  of its key, when that turn's refs were kept. Hermes sends the turn's message
  (`turn_event`) with its lookup; storage keeps, per ref, up to 10 messages the
  note's writer read (a review's batch, first message first, or the message a
  turn answered) in `note_lookups`, added if missing, merged for the same turn
  and pruned after 7 days. `archive_read {note:'<ref>'}` opens them only in that
  turn, never for a bound reader (a private answer, a member's private chat or
  the owner's ask about a member, which shares its turn's message with the
  owner's asking turn; ADR-0262): up to 5, each tagged and read-checked, an
  unreadable one left out with no count. A ref that is not the note's own key
  prefix is dropped by Hermes, and refs that could not be kept leave the labels
  without refs and are counted as the `note_refs` memory problem.
- **Recall.** An owner correction in `memory_recall` gains
  `tag: the owner's correction · <place> · <day>` and `evidence` (its first 3
  sources, tagged); the owner's native note hits gain `day` and `sources` (the
  first 3 messages the note was written from, tagged).
- **How to read sources, once per block.** The sentence the tool descriptions
  carry is also the `about` of the turn's `nocheh.memory.recall` evidence entry
  and ends the default `memory.evidence` text; it is never written into a tool
  result.

## 8. Later steps (planned)

- **Step 4: dashboard.** Messages › detail shows a message's thread and what
  was learned from it; Memory › Long-term lists facts with their sources; the
  Notes page names a review's day.

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
- **Reading Honcho's representation and finding each line's fact.** Rejected:
  its lines carry no fact id, and two facts can read the same. Nocheh lists
  the facts itself with Honcho's own selection (the newest 100, and for a
  profile the most derived first), which a store test checks against Honcho's
  own rule.
- **Listing every evidence message in `memory_recall`.** Replaced: up to 256
  ids said nothing about which fact each supported and cost up to about 9,000
  tokens; 12 facts with two tagged sources each and two record ids cost
  about 2,000 to 2,400, and every fact still opens by its number.
- **A reply block without the replied-to text, only its source.** Rejected:
  the model would have to open every replied-to message to know what was
  answered; since retiring that message withholds the whole block and the
  turn's tool work, keeping 200 characters of it costs nothing in forgetting.
- **Note refs that open in any later turn.** Not chosen: a ref is a short,
  guessable prefix; tied to the turn whose evidence showed it and kept 7 days,
  it opens nothing in another chat or turn, and every turn shows fresh ones.
- **Taking a batch-only fact's first messages as its sources.** Not chosen: the
  plugin names at most 8 messages of a batch, so a retired one could be left
  out; such a fact is forgotten when any message of its session is retired.
- **Forgetting a topic's name when its opening message is retired.** Rejected:
  a topic's name is the place's name, kept in the chat directory as Telegram
  showed it, carried by every later message in the topic and shown to every
  member by Telegram, as a group's title is; retiring a message retires it as
  a memory source, not the name of the place it was in.
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
  - Members no longer read the names a Desktop export wrote on
    `archive_page` (its sender and the people on its reactions).
  - Retiring a recent message or a replied-to message also withholds that
    turn's tool results and notes in later turns; the delivered answer stays.
- Tags are information for the model, not permission: every access check is
  unchanged, and `by` keeps ADR-0257's fail-closed groups.
- A failed tag is counted as `source_tags`; the read still answers.
- Step 2: a turn's memory reads its facts with their sources, a few hundred
  tokens more for a full owner block and about the same for a group; a recall
  with 12 facts listed costs about 2,000 to 2,400 tokens, less than the 256
  evidence ids it replaces could (about 9,000) but more than a recall that
  read few; it is replayed from history until compaction. Each block adds one
  fact list beside the context read, one receipts query, one batched read
  check and one tag request (its guarded copies read in one query), and the
  plugin only for uncited facts; the guard checks only the block's text, not
  its source ids. Each recall keeps two more derived records, and a block a
  new pair whenever its facts or their sources change, kept by history
  retention.
- What the owner loses in step 2:
  - Nocheh picks a turn's facts with Honcho's newest-first rule; facts tied at
    the 100th place may differ. The owner's profile is exact unless more than
    300 facts were learned more than once.
  - A full block shows about 5 to 15% fewer old facts, since source lines take
    room within the same 20,000 characters.
  - `memory_recall` lists `facts` and `evidence_count` instead of
    `evidence_sources` (kept only where facts can't be listed); every source
    still opens through `fact=n`.
  - Facts learned from several messages together read "not exact", and a
    fact's cited context (the question a "yes" answers) is among its sources.
  - Honcho's per-line times, when a fact was learned, give way to the time of
    the message it came from.
  - A fact a correction deleted no longer opens by its number, and none opens
    while a correction runs; the model recalls again.
  - Retiring one message forgets every fact of its Honcho session whose stored
    sources may be incomplete, which is every fact learned with its batch.
  - Retirement works record by record: one retired message withholds every
    stored row that cites a record holding any fact resting on it (up to 100
    facts of a turn's block, 200 of a recall), the rows of facts that did not
    rest on it too, and no fact of that record opens again. In the owner's
    private chat one retired learned message withholds every stored recall
    whose facts record holds a batch fact from that chat.
  - A batch fact names no sender: its source line says only where and when.
  - After a fresh start deletes the old memory space's receipts, a record from
    that space can no longer apply the session rule; its facts no longer open
    (another memory space), but a stored row citing it is withheld only for a
    retired message it names.
  - Recall's prose answer is still not sourced sentence by sentence.
  - Citation coverage can be counted by the plugin, but nothing calls it until
    step 4.
- Step 3: a turn whose message replies to another reads about 120 more tokens,
  kept in its history until compaction, and each recent message that replies
  to another about 45; a plain message in a forum topic reads none. Each turn
  with recent messages adds one batched read of their reply targets, and a
  reply one more tag request; a turn with notes keeps one `note_lookups` row.
- What the owner loses in step 3:
  - Retiring a message a turn replied to withholds that turn's searches, other
    tool results and notes from later turns, not only its quoted text, in the
    owner's chat as in groups; the answer already sent stays.
  - A note written while replying to anyone's message but the owner's own
    reads `turn_read`, Nocheh's own messages included; in a later turn of the
    session, so does any note that copies from a reply block's text.
  - The model's label of a note a member wrote while replying in a group
    reads two reads ("the message it answered (another person's), the message
    it replied to") and passes 120 characters, so the group's name goes ("from
    a group") and the end of the label is cut ("…, the message it…"); its
    `from` is still `turn_read`.
  - A note written before this step has no `day` in recall (its UTC day is no
    day in the owner's zone); its label still names it, marked UTC.
  - A note a later turn copied from a message, then retired, goes with that
    turn's searches and other tool results, not only the note; a note that
    only shares a distinctive token with it (a number of six digits or more)
    goes too.
  - Review labels read in a new order, the day before the place, so a long one
    loses place or phrase words sooner; a note written before this step reads
    its day as `<day> UTC`.
  - A note's ref opens only in the turn whose evidence showed it, and only for 7
    days; refs that could not be kept leave that turn's notes without them.
  - The Notes page shows no review day until step 4.
  - A recent message's reply part names the message without its text; the model
    opens it with `archive_read` to read it.
  - An earlier group message whose row holds a reply block makes a note that
    copies from that row read `recent` as well as `reply`: the earlier-row rule
    reads the whole row (it errs toward more reads).
</consequences>
