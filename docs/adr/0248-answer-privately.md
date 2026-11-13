# ADR-0248: Answer privately: a frozen read set in the asker's private chat

<status>
Accepted on 2026-11-13 with the owner's Members design, approved on 2026-11-12
("I just review the tables and seems what I want if there is a important point
or need my answer ask, else start build."), as part of its step 2, "Projects and
the private button". Amends
[ADR-0135](0135-group-topics-share-memory.md) (a scoped reader's one recall
scope becomes a read set, which is the same thing for every reader but a
private answer) and [ADR-0233](0233-data-tools-over-mcp.md) (a turn's pass may
carry a signed `answer` claim, and an answer's pass reaches only read routes
and read tools). Keeps
[ADR-0242](0242-private-chats-stay-out-of-group-sharing.md): anything that is
not clearly a group or one of its topics counts as private, and sharing rules
and grants never name a private chat. Keeps
[ADR-0057](0057-memory-relationship-access-map.md): relationships never grant
access. This ADR has two halves: the read set, the record and the read-only
reader below, and the button, its delivery and the brain's side in the last
section.
</status>

<context>
- The Members design, step 2: an answer in a group uses only that group. Under
  the owner's own answer in a group that belongs to a project, an "Answer
  privately" button gives the person who asked an answer in their private chat
  that may also read the project's other groups. Only the asker can use it, and
  in step 2 that is only ever the owner. The groups are frozen when the button
  is tapped. The answer only reads; long-term memory is read by plain search
  only; it gets what the owner's sharing rules and grants let into the asking
  group. Projects and topics follow their group.
- A scoped reader had one recall scope: its own chat, or its group with its
  topics (ADR-0135). `canRead` compared a message's chat with the reader's
  chat. Only the owner (`scope` null) read more than one chat, and an owner
  pass opens every owner gate, so a private answer cannot run as the owner.
- A pass with a non-null scope equal to the owner's chat looked like the
  owner's private chat to several routes: a post from it was classified as the
  owner's own request, and the delivery check, the imports list and the
  destinations list treated it as the owner. A private answer therefore needs
  an allowlist of routes, not a list of refusals.
</context>

<decision>
- **Read sets.** A scoped reader reads a set of chats (`ReadSet` in
  `src/spaces.ts`): its home (the asking group or topic), exact spaces, whole
  groups (each with all of its topics) and its project. Every ordinary reader's
  set comes from its recall scope (`readSetOf`), with the same results as
  before. `readSetSql` tests a column against the set in SQL with one `text[]`
  parameter (a whole group is written `<group>/*`), and `readSetGroups` lists
  the groups a set touches.
- **The answer's pass.** A turn's pass may name a private answer in a signed
  `answer` claim (32 hex characters), only with a non-null `scope` that is a
  Telegram user ID and a `space` equal to it: the asker's own private chat. It
  is never an owner pass, so every gate on `scope` null stays closed, and its
  runtime profile is the scoped one. A pass that carries the groups itself
  (`reads`) is refused.
- **Resolved on the server, every request.** The storage service, the security
  broker (through storage) and the Telegram turn check resolve the read set
  from the record on each request, never from the pass: the row the claim
  names, claimed by this very turn (its `/start` event), in the asker's private
  chat, pressed or answered, and within its time. Its whole groups are the
  frozen groups that Nocheh still serves; the asking group must still be one of
  them. Anything else is `private_answer_closed`, and an answer whose read set
  was not resolved reads nothing.
- **What an answer reads.** A message in one of its groups, by search, by
  reading it or by a page of that group (any group of the set; the asking
  group by default; any other chat is `conversation_not_permitted`), and of its
  own private chat only its own `/start`. Relations, learned entries, people
  and the project as an entity are read within the same groups, and the
  record's project only while it is active. Honcho memory is read by plain
  search only, through the sessions of those groups; context and recall are
  limited. Sharing releases and filters and the owner's fact grants are those
  of the asking group, never those of any other group of the set, and never
  anything shared or granted into the private chat. The delivery check passes
  only for a Telegram send to the asker's private chat.
- **Read-only, in three places.** One route list serves the storage service
  and the broker, so neither lets more through than the other: archive search,
  page and message, a message's file, the pending imports of the set's groups,
  memory search, the turn's memory and shared context, the delivery check, the
  task list and a task, context preparation, the turn's binding and files, and
  model calls. Every other route, every write and post among them, is
  `private_answer_read_only`. The MCP endpoint offers an answer only
  `archive_search`, `archive_read`, `archive_page`, `memory_search` and `tasks`,
  and `tasks` only lists and reads. Telegram actions, controlled actions and
  background jobs also refuse an answer on their own. The brain's own tool list
  is the third place (last section).
- **The record.** One `private_answers` row per offered button: the question's
  event, the asking group or topic, the project, the asker (raw Telegram IDs
  until chats, members and accounts get their own IDs; `member_id` null is the
  owner), the frozen groups, the private chat it was claimed in, the state and
  its times. Its id is an HMAC of the question's event, so a retried reply
  offers the same button. A tap, a `/start` and a refusal each return a fixed
  code (`only_asker`, `used`, `expired`, `changed`, `not_yours`) and never
  model text.
  - Offer: only under the owner's answer in a served group or topic that is
    assigned to an active project with at least one other served group.
    Offering the same question again returns the same row.
  - Tap: only the asker, under the answer it was offered for; anyone else
    changes nothing. It checks the project again and freezes every served group
    of the project that the asker may read (for the owner, all of them). An
    archived project, an asking group that left it or no other group left with
    it refuses the tap for good (`changed`). The asker then has ten minutes to
    send `/start`; tapping again in that time changes nothing.
  - `/start`: only the asker, only in their own private chat, once. The same
    `/start` claims the same row again, so a retried turn reads the same
    groups; any other is `used`. The project is checked again, and the answer
    then has an hour to be delivered, recorded once per send.
  - Expiry: the storage worker marks stale rows expired every hour (an unused
    button after a day, a tap without `/start` after ten minutes, an
    unanswered claim after an hour), and each step checks the time itself.
    Rows are the record and are never deleted.
  - The owner's list: `GET /v1/private-answers`, owner only, newest first,
    by project, page by page.
- **Members, later.** The owner's record reads all of its frozen groups. A
  member's record reads none until step 4, where the same place narrows its
  groups to the groups that member is in at the time of each request.
</decision>

<button_delivery_and_brain>
**Button, delivery and brain.** Placeholder, filled by the button's change in
the same step: the button under the owner's group answer, the link that opens
the private chat, the private answer's Hermes profile, role and prompt, its
editable texts, the sends it records and the brain's read-only tool list.
</button_delivery_and_brain>

<alternatives>
- Putting the groups in the signed pass: a pass lives up to an hour, so an
  expired, used or unserved answer would keep reading, and the brain would
  hold its own permissions. Resolving from the record on each request closes it
  at once.
- Running the answer as the owner with filters: every owner gate would open,
  and one missed filter would read the owner's private side.
- Freezing the groups when the button is offered: the asker decides at the
  tap, and a project changed in between would answer from groups the asker
  never saw offered. The tap checks the project again instead.
- A list of refused routes for an answer: every new write route would be open
  until someone added it. The allowlist fails closed.
</alternatives>

<consequences>
- A later project change never widens an old answer; it can only narrow it
  (a group Nocheh stops serving) or close it (an asking group no longer
  served).
- An answer reads text, transcripts and extracted text, not a message's
  original file: a turn's files are those of its own `/start`.
- Tasks open to an answer only as far as the task list gives that reader;
  until tasks follow data access, a private answer's task list fails closed.
- In step 2 every private answer in the owner's private chat runs in one
  scoped runtime profile.
- Checks: read sets ([spaces](../../test/spaces.test.ts)); the record, the
  read set from it, what an answer reads, its grants, its turn and its pass
  ([store](../../test/store-private-answers.test.ts)); the route list, the
  storage service and broker binding, the MCP tools and the delivery check
  ([unit](../../test/private-answers.test.ts)); Honcho plain search
  ([memory](../../test/store-native-memory.test.ts)).
</consequences>
