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
  is never an owner pass, so every gate on `scope` null stays closed, and it
  runs in a scoped runtime profile of its own, named after its record. A pass
  that carries the groups itself (`reads`) is refused.
- **Resolved on the server, every request.** The storage service, the security
  broker (through storage) and the Telegram turn check resolve the read set
  from the record on each request, never from the pass: the row the claim
  names, claimed by this very turn (its `/start` event), in the asker's private
  chat, pressed or answered, and within its time, with its project still
  active. Its whole groups are the frozen groups that Nocheh still serves and
  that are still in that project; the asking group must still be one of them.
  Anything else is `private_answer_closed`, and an answer whose read set was
  not resolved reads nothing.
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
  page and message, the pending imports of the set's groups, memory search, the
  turn's memory and shared context, the delivery check, the task list and a
  task, context preparation, the turn's binding, the turn's own files, and
  model calls. The file route opens only the files of the answer's own
  `/start` and its album; any other message's original file, in the set's
  groups too, is `original_file_requires_owner`. Every other route, every write and post among them, is
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
  - Offer: only for a question the owner asked, under the owner's answer in a
    served group or topic that is assigned to an active project with at least
    one other served group.
    Offering the same question again returns the same row.
  - Tap: only the asker, under the answer it was offered for; anyone else
    changes nothing. It checks the project again and freezes every served group
    of the project that the asker may read (for the owner, all of them). An
    archived project, an asking group that left it or no other group left with
    it refuses the tap for good (`changed`). The asker then has ten minutes to
    send `/start`; tapping again in that time changes nothing.
  - `/start`: only the asker, only in their own private chat, once. The same
    `/start` claims the same row again, so a retried turn reads the same
    groups. Any other is `used` while the claimed answer is on its way or once
    it was answered; a closed row says why instead (`changed`, or `expired`
    when its time ran out or its answer never went out). The project is checked again: the frozen
    groups are narrowed to those still in it, never widened, and with no other
    frozen group left beside the asking group the `/start` is refused for good
    (`changed`). The answer then has an hour to be delivered, recorded once per
    send.
  - Not delivered: a claimed answer that ends without its reply closes for
    its own `/start`, expired once its hour is up, else refused (`changed` when
    its record closed, `not_delivered` otherwise). An untapped row whose group
    reply did not go out is refused `not_delivered`.
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
**Button, delivery and brain.** This half amends
[ADR-0235](0235-nocheh-owns-the-telegram-bot.md) (a turn's reply may carry
one button, and a press's answer may open a link),
[ADR-0227](0227-hermes-lists-chats-by-their-names.md) (a private answer's
session is named `Private answer`, not after the chat),
[ADR-0238](0238-record-every-send-to-a-chat-app.md) (a press's answer that
opens a link is recorded like any other, without the link) and
[ADR-0244](0244-owner-defaults-posts-and-machine-reports-stay-private.md) (a
private answer in the owner's private chat never loads that chat's role and
skills or the owner's default).

- **The button.** When the owner's own question in a group or topic gets a
  reply, Nocheh offers the record (Offer, above) and the reply carries one
  inline button, `🔒 Answer privately`, under its last part. Its data is `np`
  and the record id (34 bytes, within Telegram's 64). No button goes under a
  fixed reply, an empty or silent answer or one that is only archive citations
  (the bot sends nothing for it), a private answer, a member's
  question, a reply in a private chat, or a reply in a group whose project is
  archived or has no other served group; when the record cannot be offered,
  the reply goes without it. A follow-up after approved operations, a job's
  report and a scheduled run are not answers to a question and never carry
  one. A retried reply carries the same button, as the record is the same.
- **The bot checks it.** The Telegram service accepts a reply's button only
  as exactly `{text, data}`, never in the owner's private chat, with a label
  of 1 to 40 characters and data equal to `np` and the HMAC it computes itself
  from this turn's question with the service token; anything else refuses
  the whole reply (`invalid_reply`). The outbound check binds every send to
  the one keyboard it was given: a send that carries another keyboard, or one
  when none was given, is held. Approval cards and notices are bound to their
  own keyboards the same way.
- **The tap.** A press with `np` data goes to the record (Tap, above), never
  to the approval buttons. The tapper gets a short popup, never model text:
  only the asker (`only_asker`), already answered (`used`), too late
  (`expired`) or changed (`changed`). The asker's tap answers with `open` and
  a link, `https://t.me/<bot username>?start=<record id>`, which Telegram opens
  as the asker's private chat with the bot. The bot builds the link from the
  username Telegram gave it and refuses a `start` that is not 32 hex
  characters; without its username there is no link, and the tap gets the
  `retry` popup instead: nothing changed, and tapping again within the ten
  minutes opens the private chat.
- **`/start <id>`.** Only the exact text `/start` and 32 hex characters, in
  the owner's private chat, opens a private answer; a plain `/start`, or
  anything else after it, is an ordinary message. It is checked before the
  owner's own pass is built: the record is claimed (`/start`, above) and the
  whole turn is built under the answer's pass, never as the owner. A `/start`
  that cannot be answered gets the fixed reply for its code in the owner's
  own turn and runs no model. Anyone else's private `/start` gets today's
  stranger reply ([ADR-0182](0182-strangers-cost-nothing-and-reach-no-model.md)).
- **What the brain gets.** The question's own text, voice transcripts and
  extracted file text, read under the answer's pass (an original image is
  never sent as an image), with the question's speaker line
  ([ADR-0222](0222-a-group-turn-knows-when-the-owner-speaks.md)) and the
  asking group's recent unaddressed messages before it. Before them comes one
  first line from the owner's template: where it was asked (`{group}`, with
  its topic) and every group it may read (`{groups}`, the asking one first),
  named from the guarded copies of their messages that the answer may read, as
  the speaker line is, never by ID. A question retired since, or no longer
  readable, gets the `changed` reply and closes the record; a guard or binding
  change meanwhile builds the turn again. The question is a source of the
  answer too, so retiring it withholds the answer's history.
- **The brain's side.** Hermes takes the `answer` claim only for the owner's
  private chat with that chat as its scope, and only together with the
  framed question; either one alone does not run. The turn runs as that chat,
  never as the owner (`owner` false), in its own profile (above), with
  `chat_type` `dm`. It loads the project's role and skills, else the groups
  default, and never the private chat's own or the owner's default. Its tools
  are `session_search`, `skills_list`, `skill_view` and the five read tools;
  native memory is left out, so it writes no notes. Its reply rules are the
  common rules and `reply.private`.
- **Delivery.** The answer is a reply to the `/start` message in the owner's
  private chat, with no button, sent under the answer's pass, which the
  delivery check passes only there. When it went out, the record is answered
  once with the send's key. A record closed while the answer was being written
  (its hour passed, or the project's groups changed) withdraws it
  (`private_answer_closed`), and the private chat gets the `expired` or
  `changed` text instead, once, as a notice keyed by the record. An answer that
  ends in silence or is withdrawn for any other reason closes the record with no
  notice. A group reply the bot did not send takes its untapped button's record
  with it. Every send it took is
  recorded content-free ([ADR-0238](0238-record-every-send-to-a-chat-app.md)):
  the group reply, the popups (`button_answer`, without the link) and the
  private answer.
- **Editable texts.** Settings › Assistant holds `reply.private` (the
  private answer's reply rules), `telegram.private_answer` (its first line;
  `{group}` and `{groups}` must stay) and `telegram.private_answer_texts`
  (one `name: text` line each for the button and the `open`, `only_asker`,
  `expired`, `used`, `changed`, `not_yours` and `retry` popups; a removed line keeps
  its default).
- **Where the owner sees it.** A project's page lists its buttons, newest
  first: where each question was asked, the groups its answer could read, its
  state and reason, and a link to the question. Each private answer's profile
  shows in Memory › Notes as `Private answer` and the end of its name. No
  later turn opens it and no newer profile of a chat replaces it, so every
  turn's profile preparation removes, with its conversation, each answer
  profile unused for two hours (`prune_answers`): by then its answer has
  arrived or can no longer arrive.
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
  (a group that leaves the project or that Nocheh stops serving) or close it
  (an archived project, or an asking group that left the project or is no
  longer served).
- An answer reads text, transcripts and extracted text, not a message's
  original file: a turn's files are those of its own `/start`.
- Tasks open to an answer only as far as the task list gives that reader;
  until tasks follow data access, a private answer's task list fails closed.
- Each private answer runs in its own scoped runtime profile: the record's id
  is part of the profile's name, the same in storage (`runtimeProfile`) and in
  Hermes (`Scopes.apply_revision`), and an answer's profile carries no earlier
  conversation into a new guard epoch. One answer never sees another answer's
  text, which may come from groups outside its own set.
- Checks: read sets ([spaces](../../test/spaces.test.ts)); the record, the
  read set from it, what an answer reads, its grants, its turn and its pass
  ([store](../../test/store-private-answers.test.ts)); the route list, the
  storage service and broker binding, the MCP tools and the delivery check
  ([unit](../../test/private-answers.test.ts)); Honcho plain search
  ([memory](../../test/store-native-memory.test.ts)) and its sessions and
  receipts in Postgres ([provenance](../../test/store-provenance.test.ts)); the
  answer's own profile in Hermes and its removal
  ([scopes](../../services/hermes/test_scopes.py),
  [history](../../services/hermes/test_profile_history.py)). The button, the tap and
  `/start` end to end in storage
  ([button](../../test/store-private-button.test.ts)); the button, the link
  and the bound keyboard in the bot
  ([service](../../services/telegram/test_service.py),
  [cards](../../services/telegram/test_approval_cards.py),
  [sends](../../services/telegram/test_sends.py)); the pass, the role, the
  tools, the first line and the title in Hermes
  ([turns](../../services/hermes/test_brain_turns.py),
  [persona](../../services/hermes/test_persona.py),
  [turn process](../../services/hermes/test_turn_process.py)); the texts
  ([prompts](../../test/prompts.test.ts)); and the full tester's
  `project_groups_stay_apart`.
</consequences>
