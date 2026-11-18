# ADR-0262: Member private chat

<status>
Accepted on 2026-11-18, as step 4 of the Members design, "Member private chat",
together with step 4b, "The owner asks about a member". The owner approved the
design on 2026-11-12, including that group talk switched off does not stop a
member's private chat. The owner answered the step's three questions on
2026-11-18; their answers are recorded below under "Owner decisions for this
step" and replace the plan's earlier wording where the two differ.

Amends [ADR-0182](0182-strangers-cost-nothing-and-reach-no-model.md) (a member's
own private chat that is open is prepared and answered; a paused member, or one
with private chat off, gets the stranger's private reply),
[ADR-0249](0249-answer-privately.md) (its answer reader becomes one of three
bound readers, with the same server-side binding, route list and tool list),
[ADR-0256](0256-nochehs-own-messages-carry-a-send-class.md) (a new send class,
`member_read`, that no consent can make learnable) and
[ADR-0260](0260-members-in-groups.md) (its residuals: the per-call member check
comes here, and Nocheh now asks Telegram `getChatMember` at runtime before a
member's private turn). Keeps [ADR-0242](0242-private-chats-stay-out-of-group-sharing.md)
(a member's private chat is a private chat: it never shares, is never shared
with and never joins a project), [ADR-0244](0244-owner-defaults-posts-and-machine-reports-stay-private.md)
(a member's private chat reads the groups default role) and
[ADR-0254](0254-sends-go-only-to-chats-nocheh-serves.md) (a member's private chat
stays a destination only behind the owner's card).
</status>

<context>
- Before this step, Nocheh talked privately only with the owner. Anyone else who
  wrote to it privately, a member included, got one fixed reply a day, and the
  chat was archived but never prepared or shown to a model (ADR-0182).
- Step 3 (ADR-0260) gave members a group turn that reads only its own group. A
  private chat that reads every group the member joined needs a check on every
  read and tool call, which step 3 left for this step.
- "Answer privately" (ADR-0249) already has a reader that is not the owner in a
  private chat: its pass names a record, storage binds what it may read on the
  server for every request, and it reaches read routes and read tools only. This
  step reuses that model rather than building a second one.
- `nocheh-security`'s broker binds readers too and loads no member directory, so
  the member check must be answerable from SQL alone.
- A bot that is not a group admin sees joins and leaves only from Telegram's
  service messages. A missed `left_chat_member` (bot downtime, hidden service
  messages) would otherwise let a member read a group forever.
</context>

<decision>

## Owner decisions for this step

1. **The owner's ask about a member is a separate message, then dropped (Q1,
   yes).** When the owner asks in their own chat what a member said, the answer
   comes as its own message in the owner's private chat, naming the member's chat
   as its source, and is never carried into the owner's ongoing conversation.
2. **Member saved notes wait (Q2, ok).** A member's private chat gets no `memory`
   tool and writes no Hermes notes in this step. Its conversation itself still
   carries from turn to turn, as every chat's does.
3. **Members see tasks in their private chat too, read only (Q3: "they can see
   tasks in both").** This replaces the plan's cut of tasks from the member
   private chat. See "Tasks, read only".

## Who may talk privately

- `members.private_chat boolean NOT NULL DEFAULT true`, added if missing.
  Existing members get private chat on. The Members page has **Private chat with
  Nocheh** per member; `POST /v1/members/<id>` takes `changes.private_chat`
  (boolean), and `GET /v1/members` returns `permissions.private_chat`. Adding a
  member does not take it: a new member starts with it on. Reset snapshots (v3)
  carry it.
- `MemberDirectory.privateTalks(account)`: the account is linked to a member who
  is active with private chat on, never the owner's account. Group talk, group
  switches and presence do not count: group talk off does not stop private chat.
- `memberPrivate(chat)` (`src/spaces.ts`): a private chat itself, never a topic,
  not the owner's, whose person `privateTalks` admits. `otherPrivate(chat)`: any
  known private chat, or topic of one, that is not the owner's (members' and
  strangers' alike).
- `conversationScope` admits a message in such a chat when its sender is the
  chat's own person, not the owner, not a proxy account, and `memberPrivate` holds;
  the scope then carries `member` (the member id). A stranger, a paused or removed
  member and one with private chat off get `telegram.not_allowed_private`, at most
  once a UTC day, with no model. Its default now reads "Sorry, this is a private
  assistant. It only works for its owner and the people they add."
- Every message in a member's private chat addresses Nocheh. It counts against
  the daily message cap together with the member's group turns (`member_turns`).
  Over the cap the turn ends as `member_daily_limit`, and the member gets
  `telegram.member_private_daily_limit` at most once a UTC day; the bot keys it
  `refusal-private-daily_limit-<user>-<day>`, apart from the not-allowed reply's
  `refusal-private-<user>-<day>`.
- Preparation skips chats Nocheh does not serve (ADR-0182). A member's private
  chat that is open now is prepared anyway (`preparedMemberChat`, which looks the
  member directory up again before a final skip). It stays out of every other
  reader. Member chats are never `served()`: `/internal/chats` lists each one that
  is open now with `member_private: true`, and the bot and Hermes take a member
  pass only for a chat so marked.

## Claims and bound readers

- A turn pass may carry `member` (64 hex, the member id), `member_read` (32 hex,
  the ask id) or `lane` (64 hex, a member id). `verifiedReader` refuses each
  anywhere but a turn pass, and refuses more than one of `answer`, `member` and
  `member_read` in one pass:
  - `member` only where scope and space are the same private chat that is not the
    owner's;
  - `member_read` only where scope and space are the owner's private chat itself,
    as `answer`;
  - `lane` is checked for shape and dropped. It never reaches a `Reader` and
    grants nothing; only Hermes reads it.
  - A pass naming `reads`, `member_chat`, `memberChat` or `memberRead` is refused.
- `boundReader(principal)` names the bound reader: `answer`, `memberRead` or
  `member`, else null. Every check that holds for any bound reader asks it, not
  one claim. The sites that stay answer-only are pinned by a unit test.
- `memberChat` is server-only. `bindReads` sets it on every request, in
  `nocheh-app` and in the broker:
  - **member:** `memberReads(chat)` (`src/stores/member-reads.ts`, SQL only) must
    find the pass's chat to be, now, an open private chat of the very member the
    pass names. Its reads are a read set of their joined groups, with the member's
    own chat as `home` and as `memberChat`.
  - **memberRead:** `memberAskReads(ask)` must find the ask running, inside its
    time, about an active member with private chat on and exactly one private
    chat; the ask's owner event must be the pass's turn event. Its reads hold no
    group (`home` is the owner's chat), and `memberChat` is the asked member's
    chat.
  - Anything else is 409 `member_chat_closed`. An answer keeps
    `private_answer_closed`.
- The `ReadSet` helpers are unchanged and still drop every private chat; a member
  chat travels only as `memberChat`.
- A turn built for a member, or for an ask, is checked again before its reply:
  the chat bound now must be the same, and the groups bound now must hold every
  group the turn was given. Otherwise the reply is withdrawn as
  `member_chat_closed`. A group the member may read now that the turn was not
  given changes nothing.
- `telegramDeliveryAllowed` delivers a member's reply only into that member's own
  chat, from their own update there, with that very chat bound. An ask's answer
  goes only into the owner's private chat, from the owner's own update, with the
  asked chat bound. Any other turn whose chat is a private chat that is not the
  owner's delivers nothing.

## What a member's private chat reads

- Its own chat, whole, and the groups it reads now (D5): served groups where the
  member's switch is not off and the newest `chat_memberships` row of one of the
  member's accounts says 'in' with `checked_at` within 30 days
  (`MEMBER_READ_STALE_DAYS`). A message or event in the group refreshes
  `checked_at`; so does a check.
- **Private chat reads a joined group's whole history**, as group turns do.
  Reading only from when the member joined (`read_from`) is a later step.
- **The 30-day stale rule and the re-check.** Before each private turn, joined
  groups whose `checked_at` is more than 6 hours old (`MEMBER_RECHECK_HOURS`) are
  asked of Telegram with the bot op `telegram.member_status` (`getChatMember`),
  oldest first, at most 10 (`MEMBER_RECHECK_LIMIT`). The bot asks only about a
  served group, where it is in Telegram now.
  - `creator`, `administrator`, `member`, and `restricted` with `is_member` true
    are 'in'. `left`, `kicked`, and `restricted` with `is_member` false are
    'left'.
  - The answer is written with source `'checked'` (the `chat_memberships.source`
    CHECK gains it) and `checked_at` now. A switch between 'in' and 'left' moves
    the member revision, and the directory reloads.
  - Anything Telegram does not answer plainly changes nothing.
  - Groups that needed a check past the cap are left out of that turn's input.
  - "Unknown = fail closed" is kept: a member quiet for 30 days in a group where
    Telegram does not answer (a bot that is not an admin) loses that group until
    they write there again.
- Search narrows to the bound groups and the member's chat before ranking, so
  other chats' hits never crowd theirs out. `canRead` still decides each hit.
- Long-term memory by plain search only, over the bound groups' sessions. A
  member's own chat is never learned, so it has no session.
- No shared or granted context: `/v1/memory/context` answers nothing, and grants'
  context answers no sources.
- Source tags name an asked member's chat as `“{name}”'s private chat`
  (`modelSourceWords.places.member`), or `a member's private chat` with no name.
- A member reads no original file but their own turn's (and its album), as an
  answer reader.

## Read only

- Routes: a member's private chat reaches an answer's read routes, without shared
  or approved context opened by id. An ask reaches only archive reads, context
  preparation, the guard, its own files and model calls: no long-term memory, no
  tasks, no imports and no shared or granted context. Anything else is 403
  `member_private_read_only`.
- Tools (MCP and Hermes): a member's chat gets an answer's tools,
  `archive_search`, `archive_read`, `archive_page`, `memory_search` and `tasks`
  (list and get), plus Hermes's `session_search` and skills reading. It gets no
  `memory` toolset. An ask gets only `archive_search`, `archive_read` and
  `archive_page`.
- Effect sites refuse any bound reader, and any turn whose chat is a private chat
  that is not the owner's, before anything is recorded (`readOnlyReader`,
  `assertActingReader`): message proposals, controlled actions, background jobs
  and group-turn requests. An action continuation is never started from a member's
  chat, and the old assistant path suppresses a member scope.
- Hermes runs a member's turn with chat type `dm`, the `reply.member` rules (read
  only, joined groups and own chat, tasks read only, "If asked who can see this
  chat, say truthfully that the owner can read it"), and the groups default role.
- **Own role is cut.** A member's private chat has no role of its own:
  `RuntimeProfileRepository.entry()` and Hermes's `allowed_chats` refuse any chat
  that is neither the owner's nor a served group. `reply.member` is editable.
- The bot never puts **Answer privately** under a reply in any private chat.

## Tasks, read only (D14)

- The task resolver gives a member's private turn one view per active project
  assigned at least one of the groups `bindReads` resolved for this request. Each
  view sees the tasks set on that project itself and the tasks of those groups of
  it only, with their topics when topics share memory, as a project's chat sees
  them (ADR-0248). A member turn never gets `project: null`, so never every list.
- `chatList`: `scope` must name one of the views, or the only view is used. With
  no scope and several views, 400 `task_project_required` names the views only
  (`projects: [{id, name}]`), and the broker and the MCP tool pass that list on.
  With no view, 403 `task_project_required`. A named project that is not a view
  gets 403 `task_scope_denied`.
- `chatGet`: the task's own project picks the view; no view, or a task the view
  does not reach, gives 404 `task_not_found`.
- Writes: 403 `task_read_only`. Groups in no project have no tasks there.
- An ask about a member has no tasks.

## The owner's turns never read a member's chat

- `canRead`'s order for every reader but the dashboard: retired and stale
  reaction sources; then what someone Nocheh doesn't serve wrote, unless it is
  the reader's own bound `memberChat`; then any private chat that is not the
  owner's, of every kind (updates, Nocheh's replies there, browser), unless it is
  that bound chat; then a delivered message with send class `member_read`; only
  then the owner's return and the scoped readers. `readable()` (ADR-0261) keeps
  the same order in batch.
- This also closes a gap that predates this step: an owner turn could read
  Nocheh's replies in a stranger's private chat.
- The owner's turns cannot page a private chat that is not the owner's
  (`conversation_not_permitted`). The dashboard (admin) reads everything.
- **Recall allowlist (D7).** For a non-admin owner reader, storage passes
  `allowed: {spaces: [the owner's chat and its topics, every served group and its
  topics]}` to `recallNotes`. Hermes keeps a profile only when its `space.json`
  names neither `member` nor `member_read` and it is the owner's own, one of the
  owner's private answers, or its space is in `allowed.spaces`. A malformed list
  is refused. Hermes never works the list out itself. The dashboard passes none
  and reads every profile.
- Member receipts mark `member`, and ask receipts mark `member_read`. Hermes
  compares both in `_same_chat`, so a member's chat carries only that member's
  own conversation.
- Member chats stay out of `served()`, so `owner_read conversations` and the
  owner's conversation lists keep hiding them.

## Member chats are never learned

- `canLearn` refuses, before the owner's learning consent is read:
  - any original in a private chat that is not the owner's, of any kind, imports
    included;
  - a delivered message of send class `member_read`.
- `setConsent` answers 409 `learning_consent_member_chat` or
  `learning_consent_member_read`, and its GET says `consentable: false`.
  `notLearned` ignores consent for `member_read`.
- The owner's notes review skips both (`sender_not_allowed`).
- A fact whose evidence rests on either is never granted, even confirmed (409
  `memory_grant_member_chat`), never requested and never suggested. A source the
  archive no longer holds counts as such evidence (fail closed). No suggestion is
  made from a member's turn or an ask's.
- Long-term memory (Honcho) never learns a member's chat: the learning jobs that
  feed it ask `canLearn` for every piece of evidence.

## Turn order

- Hermes runs a member's turns one at a time: `lane:<member id>` first, then
  the space's lane, then capacity. A member's private pass carries their own
  lane, and a group pass started by a member's message carries theirs. The
  owner's, an answer's and an ask's passes carry none and skip the first lock.
- Lanes before spaces, for every turn, so no two turns wait on each other. A
  member's group turn that waits for their running private turn holds no group
  lock, so the owner's and other members' turns in that group go on. A later
  turn in a group can then start before that member's earlier one; Nocheh
  still sends the group's replies in arrival order (`earlierReply`).
- **Owner-first priority gate: cut.** Capacity is already 3, so the owner waits
  only while three members' turns run at once, and lanes stop one member taking
  two slots.

## The owner asks about a member (4b)

- `ask_member_chat {member, question}` is an MCP tool whose route,
  `POST /v1/member-asks`, checks the owner's live private turn first
  (`knowledge.ownerTurn`). The ask guard (D12) records a row only when the asking
  message is:
  - the owner's own Telegram message in the owner's private chat
    (`conversationScope` says owner; not in a chat's own name);
  - not forwarded (no `forward_*` field, no automatic forward);
  - naming that very member in its own text or caption, by a name Telegram shows
    for them now (`peopleNames`: display name or @username, compared by skeleton
    and as a whole word). A name only in the tool's arguments, a quote, a forward
    or a tool's output records nothing. A name two members share is refused
    (`member_name_ambiguous`).
- The member must be active with private chat on and exactly one open private
  chat, else 409 `member_chat_closed`. One owner message asks about at most three
  members (`member_ask_limit`); the same message asking again about the same
  member gets the same row.
- `owner_member_asks` (control store, added if missing; removing a member removes
  their asks): `id`, `owner_event`, `member_id`, `question` (up to 4,000
  characters), `state` (`queued`, `running`, `answered`, `failed`, `expired`),
  `error_code`, times, `expires_at` (30 minutes), `send_key`, and the worker's
  attempts, input and binding. Reset snapshots never carry asks.
- The worker (`src/stores/owner-member-ask-turns.ts`, workflow job `ask:<id>` in
  the telegram family, modelled on action continuations):
  - It waits for the asking turn's own reply, up to 10 minutes.
  - It then runs one read-only turn under a pass naming the ask, on the asking
    message with attempt `m<n>-<ask id>`. The turn reads only `telegram.member_read`
    (the editable first line) and the owner's question, under the
    `reply.member_read` rules.
  - The answer goes to the owner's private chat as one separate message of send
    class `member_read`, whose first line comes from `telegram.member_read_texts`
    (`source`) and names the member's chat.
  - A turn that ends without an answer runs once more. When the chat closed, the
    ask expired or no answer came, the owner gets one short notice (`closed` or
    `failed`) instead. An uncertain send is never repeated.
- **Never carried.** Hermes never carries an ask's profile into the owner's
  conversation or carries anything into it, prunes it like an answer's once
  nothing can run in it, and the owner's recall never reads it (D7).
- **Dropped.** A `member_read` message is unreadable to every reader but the
  dashboard. A reply that quotes it has the quote dropped on search, read and
  page (D13). The bot accepts the `member_read` class only under an ask's own pass
  in the owner's private chat, or as a notice there.

## Dashboard and texts

- Members: the owner-only line **members.local_laws** at the top ("Before you
  read your members' private chats with Nocheh, check what your local laws
  allow."); **Private chat with Nocheh** on each member's page; "Private chat off"
  in the list; Pause and Remove say they stop the private chat too.
- Messages: other people's private chats are left out of the default list
  (`private_chats=hide` on `/v1/data` and `/v1/search`) and kept under **Members’
  chats** (`private_chats=only`), so they do not show when the owner shares their
  screen.
- Memory › Assistant notes names a member's profile "Member · <name>" and an ask's
  "Your question about a member · <date>", listed after the owner's own chat and
  the groups.
- New editable texts: `reply.member`, `reply.member_read`,
  `telegram.member_private_daily_limit`, `members.local_laws`,
  `telegram.member_read` (with `{member}`) and `telegram.member_read_texts`
  (`source`, `closed`, `failed`). `telegram.not_allowed_private` is reworded.

</decision>

<alternatives>
- **A second reader model for members.** Rejected: the answer reader (ADR-0249)
  already binds on the server, per request, with route and tool lists. Member and
  ask readers join it as bound readers.
- **Private chats in the `ReadSet`.** Rejected: every read set helper drops
  private chats, and keeping that true means no old caller can be widened by
  accident. The one private chat travels as `memberChat`, set only by
  `bindReads`.
- **Making member chats `served()`.** Rejected: owner lists, owner reads and
  sharing all lean on `served()`. A separate `member_private` mark feeds the bot
  and Hermes only.
- **Keeping the last state seen when Telegram cannot confirm.** The plan's first
  answer. Replaced by the approved design's "unknown = fail closed", with a
  30-day window and the re-check.
- **A `membership_checks` table.** Cut: `chat_memberships.checked_at` already
  moves with every message and event, and a check writes it too.
- **Carrying the owner's ask into the owner's conversation.** Rejected by Q1:
  every later post, search or task change would then need the owner's approval
  until the conversation starts over. A separate, dropped message keeps member
  text out of the owner's Hermes session, so no session taint is needed.
- **Member saved notes now.** Deferred by Q2: notes reset on every guard epoch
  anyway (ADR-0163), while the conversation itself carries.
- **Tasks only in groups.** Replaced by Q3; built read only, one view per project.
- **Own role per member chat.** Cut: opening `entry()`, `list()`, `resolve()`,
  labels, Hermes's management and a role editor is a step of its own, and the
  groups default plus `reply.member` covers it.
- **An owner-first priority gate in Hermes.** Cut (see "Turn order").
- **Deleting `prepareReviews` here.** Left for its own pull request: it removes
  `workflows/memory.ts` and two tests.
- **Still cut from the design:** invite links, a "you're in" message, members'
  own "Answer privately", monthly counts, notes across epochs and backfill.
</alternatives>

<consequences>
- A member asks Nocheh privately about the groups they joined, across projects
  and groups in no project, and reads those projects' tasks, without posting,
  acting or changing anything. Group talk off leaves that on.
- Every read is bound on the server for each request. A pause, a removal,
  private chat off, a group left, switched off or no longer served closes or
  narrows the next read, and a reply built on wider reads is withheld.
- A member's private chat reaches no group, no other member, the owner's own turns
  (except the owner's ask about that member), learning, Honcho, grants,
  suggestions, sharing previews or the owner's recall. Failures close: a chat
  that cannot be told apart is refused.
- The owner can ask about a member and gets a separate, unlearned message that
  the owner's later turns cannot read.
- Member chats are archived like any chat and shown to the owner in Messages,
  under their own filter. Members are told the owner can read them.
- Nocheh asks Telegram `getChatMember` at runtime, at most 10 times before a
  private turn. A member who is quiet in a group for 30 days, where Telegram does
  not answer, loses that group until they write there.
- Residuals:
  - The 10-check cap narrows only the turn's own input. A tool call binds again and
    can still read a group past the cap that is within the 30-day window.
  - `/v1/search` applies `private_chats` after its first 200 hits, so matching
    results can be missed.
  - A member with several accounts that have private chats is never asked about
    (4b reads nothing).
  - The Messages filter hides nothing while the chat directory has not loaded.
  - An ask's Notes label has no answer date.
  - The owner's notes review's sender check (`notesSender`) does not tell member
    or `member_read` sends apart; `canLearn` refuses them first.
</consequences>
