# ADR-0250: Chats get Nocheh's own ids; existing ids are kept

<status>
Accepted on 2026-11-14 as step 2b-1, "Nocheh's own chat ids", of the owner's
Members design, approved on 2026-11-12 ("I just review the tables and seems
what I want if there is a important point or need my answer ask, else start
build."), whose step 2b is "Chat records ready for Slack" (owner: "want ensure
the db design cover slack for future"). The owner sees no change in what
Nocheh serves, and redeploying main undoes the step: no stored value is
rewritten. Amends
[ADR-0242](0242-private-chats-stay-out-of-group-sharing.md),
[ADR-0135](0135-group-topics-share-memory.md),
[ADR-0249](0249-answer-privately.md),
[ADR-0238](0238-record-every-send-to-a-chat-app.md),
[ADR-0214](0214-allow-a-site-or-command-in-one-chat.md),
[ADR-0092](0092-exact-topic-action-destinations.md),
[ADR-0163](0163-chat-conversation-carries-into-new-guard-epochs.md),
[ADR-0168](0168-superseded-epoch-profiles-are-removed.md),
[ADR-0151](0151-chat-role-and-skills-in-hermes-profiles.md),
[ADR-0230](0230-portable-export-carries-owner-work.md),
[ADR-0235](0235-nocheh-owns-the-telegram-bot.md) and
[ADR-0244](0244-owner-defaults-posts-and-machine-reports-stay-private.md)
(see Amendments). Keeps [ADR-0053](0053-original-only-archive.md): the archive
holds originals only and is never rewritten or indexed by chat. Step 2b-2,
"Only the owner adds Nocheh" (adoption, leave-and-tell, the Telegram "which
project?" card, and the served set kept in `chats` with `TELEGRAM_GROUP_IDS`
retired), gets its own record.
</status>

<context>
- Every chat value Nocheh stored was a Telegram id: `'-1001000000001'` for a
  group, `'-1001000000001/topic/7'` for its topic 7, and the owner's user id
  (`'123'`) for the owner's private chat. These values sit in about 48 control
  and derived columns, learned entries, memory audiences, Honcho session keys,
  Hermes profile folders and the archive's `events.scope`.
- Code in storage, the dashboard, Hermes, the bot and the tester read that
  shape to decide whether a chat is private, a group or a topic, which group a
  topic belongs to, and whether a group is served.
- Telegram gives a group a new id when it upgrades it to a supergroup; the chat
  then lost its project, rules, tasks, switches and memory. A Slack chat is
  named by a team and a channel, which no shape rule covers. Replacing the bot
  must not change any chat. Members (step 3) need private chats tied to
  accounts, and `TELEGRAM_OWNER_ID` stood for both the owner's account and the
  owner's private chat.
- Converting every stored value to a new id would take one irreversible rewrite
  of about 50 columns in two stores, plus Hermes folder names and learned entry
  ids. One missed column would silently turn a group's tool switch back on
  (a missing row means on) or make Honcho drop and relearn memory, and raw ids
  the owner typed into roles, skills and schedules would stop resolving.
</context>

<decision>

## Records and ids

- **Tables** (control store, `src/stores/chat-schema.ts`; each created only
  if missing):
  - `chat_connections`: one per app (UNIQUE app). Its id is
    `digest(['connection', app])`, with no bot in it, so a new bot keeps the
    connection and every row that refers to it. `secret_ref` names where the
    credential lives (`env:TELEGRAM_BOT_TOKEN`), never the credential.
  - `chat_accounts`: a person or bot in an app (team `''` on Telegram).
    `member_id` stays null until step 3; `standing` (member, external, guest,
    deleted) is for Slack.
  - `chats`: private chats, groups and topics. A topic has `parent_id` and
    `topic_key` and is found by them; a private chat names its account.
    `state` is active, off, pending, left, removed, could_not_leave or
    archived. The `added_by_*`, `add_event` and `state_seq` columns are for
    step 2b-2.
  - `chat_ids`: every app id a chat has had, `current` or `old`. A topic has
    none of its own.
  - `chat_memberships`: one row per group and account (`in` or `left`), with
    `since`, `seen_seq` and `seen_bot`.
  - `chat_directory_state.revision`: bumped whenever a chat or chat id is
    added.
  - `chat_details` (`src/stores/chats.ts`): what the owner's lists show and
    nothing decides with: the public username, the last title Telegram showed,
    when a chat or topic last had a message, whether a topic is closed, and the
    owner's last refresh (its answer and the title and username it gave).
  - `chat_seed_state`: how far the seeder and the membership backfill have
    read the archive.
- **Old values are kept.** Every chat value stored before step 2b stays,
  unchanged, as its chat's Nocheh id: `'-1001000000001'`,
  `'-1001000000001/topic/7'` and `'123'` keep naming the same chats. No stored
  value is rewritten and the archive is never changed. From then on an
  old-looking id is only a name: its kind, parent, owner flag and state come
  from its row.
- **New chats get a digest, with no bot in it.** A chat first seen after step
  2b gets `chatIdFor(app, external[, topic])` =
  `digest(canonical(['chat', app, ...external, 'topic', key]))`. Telegram
  names a chat by one id; Slack by `[team, channel]`. A chat keeps the id made
  from the first app id it was seen under. Only a Telegram forum topic is a
  topic: a Slack thread, like a Telegram reply chain, stays at message level
  and is never a chat, so `chatIdFor('slack', …)` refuses a topic. The served
  list's `owner_account` names one app's owner account until a second app's
  front door needs its own (the Slack step).
- **One chat id check.** `chatIdPattern`, `chatIdSql` and `chatIdListSql`
  (`src/chats.ts`) accept a 64-hex digest or the frozen old Telegram shapes,
  nothing else. Every chat CHECK uses them.
- **The adapter is the only reader of Telegram's formats.**
  `src/chats-telegram.ts` (`legacyChat`, `parseTelegramLink`,
  `telegramDestination`, `legacyShapeSql`), the seeder through `legacyChat`,
  and the front door (`src/frontdoor/telegram.ts`) read Telegram ids.
  `test/chat-id-format-gate.test.ts` fails on any other site beyond an
  allowlist that, after step 2b-1, holds only adapter sites (Telegram ids the
  owner types, the policy document, archive intake, the bot), three legacy
  sites (the old storage layout and version 1 reset snapshots, read once to
  convert them) and one unrelated match.

## The chat directory

- Code asks `chats()` (`ChatDirectory` in `src/chats.ts`): `get`, `kind`,
  `isGroup`, `isPrivate`, `parentOf`, `groupOf`, `topicsOf`, `topicOf`,
  `ownerChat`, `isOwner`, `served`, `appIds`, `resolve`, `expand` and
  `rawScopes`. It is a synchronous snapshot of every `chats` and `chat_ids`
  row.
- **An unknown id is private.** An id with no row is no group, counts as
  private, is not served, expands to nothing and reads nothing (ADR-0242,
  fail closed). Before the first load the directory knows no chat, so
  everything fails closed.
- **Reload.** `ChatDirectoryLoader` is installed in the app and the security
  service before they serve. It reloads when a capture, seeding, import or
  topic change in this process adds a row; when a guard epoch newer than its
  snapshot is read (`GuardRepository.state`); and when a lookup misses while
  the revision or epoch has moved, checked at most once every two seconds. A
  load that fails, or rows that break the directory's rules, leave the
  previous snapshot in place.
- **A chat recorded a moment ago.** A process that misses the chat it is asked
  about looks again before refusing. The security service and the app server
  check a turn pass whose space they do not know once more after the loader's
  `current()` (`currentReader`, `chatsAfterMiss`). Preparing a message's
  attachments and Telegram dispatch look again before they skip a message as
  outside or refuse its turn (`settleTelegramChat`), as a capture records a
  new Telegram id in the same commit that queues them. nocheh-telegram and
  Hermes read their served list again, at most once a second, when it lacks
  the chat, topic or Telegram id they are asked about. A chat still unknown is
  refused.

## Recording chats

- **At intake.** `ChatRepository.capture` runs in the capture's own control
  transaction, under a savepoint, so a failure never fails the capture. It
  records the connection, chats, topics, chat ids, accounts and memberships a
  Telegram update shows, and links an upgrade's old and new ids on one chat:
  on `migrate_to_chat_id` and `migrate_from_chat_id`, or when the owner's
  refresh finds a group migrated, the old Telegram id becomes `old` and the
  new one `current`, and the group stays the same chat. No message text is
  read or stored. Bots, anonymous admins, channel posts and `sender_chat` are
  never members. A live message in a private chat whose row names no person
  (one a reset or an owner-record import restored) names its person then
  (`namePrivateChats`), unless another private chat already names that
  person.
- **Order.** A change applies only when its update is newer than the one that
  last set the row. Within one bot the update id decides, unless the two
  updates were taken in more than seven days apart (the later one wins then);
  across bots the capture time decides. A replay changes nothing. The spool
  hands each batch of up to 100 Telegram updates off in update order. Only a
  live capture names the installation's bot on its connection.
- **Imported history keeps old ids.** A chat whose originals arrive in an
  import (intake transport `import`) is the owner's own history: it gets the
  id its old stored value had, as the seeder gives one, and so do its topics.
  A portable import brings the package's `chats` and `chat_ids` before its
  archive, so a chat the package names by a digest keeps that digest.
- **Seeding.** At app start, before capture, workflows and the HTTP server,
  `src/stores/chat-seed.ts` gives every stored chat value a `chats` row (and
  a `chat_ids` row for its Telegram id). It reads every chat column
  (`chatSeedColumns`; a schema-introspection test fails when a chat-like
  column is in neither that list nor its list of non-chat columns), topics in
  `owner_tasks.group_id` included; the archive's scopes and observed topics,
  in windows of 20,000 events; `TELEGRAM_OWNER_ID` and `TELEGRAM_GROUP_IDS`;
  and `telegram_chat_observations` and `telegram_topic_registrations`, which
  step 2b-1 keeps read-only and step 2b-2 drops. It sets a private chat's
  account, a group's `is_forum` and the owner's last refresh (its answer, name
  and username, in `chat_details`) from what it reads. It only inserts, with
  one fill: a private chat whose row names no person, as a reset or an
  owner-record import restores it, gets its person's account, unless another
  private chat already names that person; Answer privately needs it. A second
  run changes nothing (a test checksums every policy table before and
  after). `owner`, `*`, `system`, `desktop:*`, import scopes and digests get no
  row. After the first seeding, a chat found only in the environment or the
  archive gets a digest id. A background loop then fills memberships from the
  archive in batches of 500, by the same ordering rule. The app logs
  `chat_records_ready` with how long seeding took, and its health check allows
  120 s at first start. `nocheh deploy` waits 180 s for the app to be healthy;
  if a very large archive takes longer, the deploy reports a timeout while the
  app keeps seeding and starts serving when it is done. Nothing restarts an app
  that is still starting, and a manual restart reads the archive again from
  the start.

## What is served in step 2b-1

- `TELEGRAM_GROUP_IDS` still decides. At app start `chats.state` follows it: a
  group with any of its Telegram ids, current or old, in the list is active,
  and so is the owner's private chat; every other chat is off.
- `servedPolicy` gives every process the same served view: `owner_chat` as the
  directory names it, and `group_ids` holding every Telegram id, current and
  old, of the served groups. `group_ids` is used only to compare archive
  originals. The policy document and its guard epoch are unchanged.
- `GET /internal/chats` (service token) gives nocheh-telegram and Hermes the
  served chats and their topics, each with its state and its Telegram ids
  (`current` or `old`), the owner's private chat and the owner's account, and
  the guard epoch. The services take every chat state but serve only an
  `active` chat and a topic of one. A list that cannot be read serves nothing.
- Group access (`TELEGRAM_GROUP_ACCESS`) is looked up under every Telegram id
  a group has had, merged with deny winning, so an upgrade keeps who may talk
  there. The owner's conversation context shows the same merged lists
  (`groupAccessOf`).

## Reads and rules on chat rows

- The `src/spaces.ts` helpers (`groupSpace`, `groupChatId`, `parentSpace`,
  `groupWithTopics`, `servedGroups`, the read set helpers) keep their names
  and stay synchronous; they answer from the directory.
- **No SQL reads an id's shape.** SQL takes exact id lists that the directory
  expands (`col = ANY($n::text[])`): a group and every topic row under it.
  `readSetParam` binds each group and topic of a read set as `read:<id>`, and
  `readSetSql` reads only marked entries, so a hand-built list naming a
  private chat selects nothing. `readSetSessions` takes a read set, never an
  id list.
- **Archive reads go through `chat_ids`, with no event index.** A read expands
  a reader's chats, with their topics, to every app id they have had
  (`rawScopes`), reads `events.scope = ANY(...)`, and maps each original back
  to its chat (`sourceChat`) and topic row (`observedChat`). Search hits carry
  `chat_id`. A message from before an upgrade belongs to the group.
- **A turn names its chat by its Nocheh id.** `RuntimeTurnRepository.checkSpace`
  returns the turn's group or private chat as Nocheh names it, never the raw
  `events.scope`, so jobs, controlled actions, Telegram actions, knowledge
  proposals and the turn binding hold the chat's own id, also for a group first
  seen or upgraded after step 2b.
- **The owner's chat apart from the owner's account.** `policy.owner_chat`
  (`ownerChat`) names the owner's private chat wherever `owner_id` stood for a
  chat: background jobs, managed runs, browser capture and runs, schedules,
  Notion autonomy (`ownerIds`), memory reviews, native memory, knowledge
  management, learning, the job box and owner notices. `owner_id` stays the
  owner's Telegram account and is compared only with a sender. In step 2b-1 the
  two are the same value.
- **assistant-policy** decides served, owner and outside from the chat's row;
  an id with no row is outside.
- **private_answers** uses `chatIdSql`. A trigger checks `from_chat_id` (a
  group or topic), every `read_chats` entry (a group) and `reply_chat_id` (a
  private chat) against the chats rows; a value with no row is judged by its
  old shape (`legacyShapeSql`), so main, redeployed, keeps writing.
  `asker_account_id` stores the `chat_accounts` id, and an older row holding
  the raw Telegram user id still presses, claims and binds.
- **Chat tool switches** stay keyed by the chat's id, so every off stored
  before step 2b stays off. Only a chat with a row has switches of its own, a
  topic inherits through its row, and a chat with no row runs no command,
  page read or outside tool.
- **A group's topics are its topic rows.** `moveGroupTasks` and an
  organization review's inheriting topics use them.

## Turns, sends and the two front doors

- **The app binding on the pass.** A turn pass names its chat and space by
  their Nocheh ids (`scope`, `space`) and also carries `app: {app, chat,
  topic}`: the chat's current app id and the topic key, or null, signed by
  storage from the directory (`AudienceRepository.turn`, `appBindingOf`). A
  scope pass that names an app is refused; a job's or the dashboard's pass
  names none, and storage does not require one. Storage refuses a reader whose
  space is neither its scope nor a topic of it (`parentOf`). A private answer's
  pass reads only in the chat the directory marks as the owner's private chat;
  ADR-0249 still binds its read set on the server by record id. Nothing else
  is added to the pass.
- **Every front door checks the binding.** nocheh-telegram accepts a reply or
  presence only when the binding names that Telegram chat and topic. Hermes
  runs a turn only when the binding names the update's chat and topic, by its
  Telegram id now or before, and both agree with the served list. The owner's
  own turn is answered only in the owner's private chat itself, never in a
  topic of it, by both.
- **Translation at the front door.** Storage names a chat by its Nocheh id
  everywhere. `src/frontdoor/telegram.ts` alone translates:
  `telegramTarget`/`telegramAddress` give a chat's current Telegram id and its
  topic as Telegram's thread number for replies, presence, cards, notices,
  owner notices and approved sends, so a send follows a group Telegram
  upgraded; `telegramChat` turns an incoming Telegram id (current or old) and
  thread into the Nocheh chat or topic; `telegramScopes` lists a chat's
  archive scopes; `telegramLink` builds a link from the current id. A chat the
  directory does not know is never sent to (409 `chat_not_found`), and an
  approved send to it waits rather than goes anywhere else.
- **Destinations are chat ids.** A destination written as a t.me/c link or a
  Telegram id is read once, in `telegramDestination`, into the chat or topic
  it names; an unknown one is refused. The bot's delivery check
  (`/internal/actions/authorize`) also requires the chat and topic it is about
  to send to be the destination's address now.
- **Telegram dispatch** builds Hermes turns on the Nocheh chat and space plus
  the binding, and waits until the directory knows both. Private answers get
  the Nocheh chat id.
- **nocheh-telegram** (`services/chats.py`) reads the served list from the app
  and no longer reads `TELEGRAM_OWNER_ID` or `TELEGRAM_GROUP_IDS`. It reads the
  list again when older than its caller allows, when a pass carries a newer
  guard epoch, or when it lacks the chat asked about.
- **Hermes** takes a turn's chat, space and binding from its pass, and the
  owner, the owner's private chat and the served groups from the same list.
  The owner flag comes from the claims; the sender must be the owner's account
  in the list. A chat the list no longer serves gets no turn; a list that
  cannot be read fails the turn so it is retried. Management, the native
  admin, runtime profiles, managed runs and memory reviews ask the same list.
  A turn is resolved off the event loop. `Scopes.profile`, the session cursor
  `digest(chat + ':' + (topic or 'main'))` and profile-history matching keep
  their formulas over the Nocheh id. A profile's `space.json` marker also
  records its chat, so a topic inherits its chat's preferences without reading
  its id; an older marker finds its chat in the served list.
- **Runtime profiles, cards and destinations** are named from `chats` rows and
  `chat_details`, not from the read-only Telegram tables. As before step 2b, a
  runtime profile's label and an action destination's name are the title and
  username of the owner's last refresh (`chat_details.refreshed_title`,
  `refreshed_username`), never a title a later update showed, and a card uses
  that refresh when no captured message names the group.
- **Reset preferences.** The reset's preference snapshot
  (`nocheh-runtime-preferences-v2`) keys each profile by its chat's Nocheh id
  and records the owner's chat, each served group with every Telegram id it
  has had and each topic with its chat, read from the configuration snapshot's
  `chats` and `chat_ids` rows. A `v1` snapshot still restores.

## Owner screens and the dashboard

- Conversations, people, topics and the Telegram refresh read `chats`,
  `chat_details`, `chat_accounts` and `chat_memberships`, not the archive or
  the old Telegram tables. People who left a group are listed as left. A
  refresh writes a name only where no captured update gave one, keeps its own
  answer apart in `chat_details`, never changes whether a chat is served, and,
  when Telegram reports a group migrated to an id that already names another
  chat, keeps the migrated notice and asks nothing more. A topic name the owner gives stays over the one Telegram
  shows; removing it brings Telegram's back. A chat with no original here
  that is neither served nor configured is kept out of the owner's own turns,
  as a stranger's chat is.
- `GET /v1/conversations` gives each chat `kind`, `parent_space`,
  `topic_key`, `app_ids` (`{app, external, state}`; a topic shows its
  group's), `is_forum`, `state` and `owner`. Its `q` matches a chat's id, its
  name, its group's name and every Telegram id it has had
  (`conversationMatches`).
- The dashboard reads those fields and never parses an id. Chats shows a
  "Telegram ID" label, with the earlier one after an upgrade, and finds a chat
  by name or any Telegram ID; a digest is never shown, and an id the
  directory lacks is "Unknown chat" with no switch or project. Sharing rules
  and organizing permissions match search hits by `chat_id`, keep a chat
  still being looked up, and save once it is known. Until step 2b-2, turning a
  group on writes its Telegram id to `TELEGRAM_GROUP_IDS`, and a group's
  allowed people are saved under a Telegram id that list names.
- Send records (version 2) keep the app's chat, thread and message ids as text
  and name the Nocheh chat in `chat_id`; `reaction_states.update_id` is
  numeric. Version 1 files still read.
- Owner records and reset snapshots (`nocheh-reset-configuration-v2`) carry
  `chats` and `chat_ids`. Only names the owner gave travel; an imported chat
  arrives off, with no account (a private chat gets its person back at the
  next start or its next live message); a row that would break the directory
  is refused. Older records import through `legacyChat`.

</decision>

<amendments>
- ADR-0242: "counts as private" means the chat has no group row, never that
  its id is not shaped like a group.
- ADR-0135: a topic's group is its row's parent, and topics share memory
  through the topic rows under the group; topic memory still reads the
  group's sessions.
- ADR-0249: `private_answers` names chats by their Nocheh ids and the asker by
  the `chat_accounts` id; its earlier raw values are those chats' ids,
  unchanged. A private answer's pass is checked against the owner's private
  chat as the directory knows it.
- ADR-0238: a send record keeps the app's chat, thread and message ids as text
  and names the Nocheh chat.
- ADR-0214: a chat rule's `space_id` is a Nocheh chat id; stored rules keep
  theirs, and a chat with no row has no switches of its own.
- ADR-0092: a destination is a chat id from the directory; a topic has its own
  chat id, and a link or Telegram id is read once at the front door. A request
  is recorded under the Nocheh chat it came from. Approval of a topic still
  never falls back to General.
- ADR-0163 and ADR-0168: step 2b-1 starts no guard epoch; carry and pruning
  match the Nocheh chat id, which a Telegram upgrade does not change.
- ADR-0151: a topic finds its chat through the turn or its profile's marker,
  never through its id.
- ADR-0230: owner records carry `chats` and `chat_ids` instead of
  `telegram_topic_registrations`.
- ADR-0235: nocheh-telegram checks each turn's app binding and reads which
  chats are served, and where they are in Telegram now, from the app.
- ADR-0244: the owner's private chat is `policy.owner_chat`, a directory row,
  apart from `owner_id`, the owner's account.
</amendments>

<alternatives>
- **Convert every stored value to a digest in place.** Rejected: an
  irreversible rewrite of about 50 columns in two stores, a profile key
  indirection for Hermes folders, `logical_profile` and learned entry ids. One
  missed column fails open, and raw ids the owner typed would stop resolving.
- **Put the bot in the chat id.** Rejected: replacing the bot would change
  every chat id.
- **An `event_chats` index with an archive backfill.** Rejected: the archive
  keeps originals only (ADR-0053), its size is unknown, and expanding a few ids
  at query time is enough.
</alternatives>

<consequences>
- Formulas that hash a chat value are unchanged, because old chats keep their
  strings: the Honcho session key and audience, learned entry ids,
  `Scopes.profile` (Hermes profile folders and `logical_profile`) and the
  conversation cursor. No sweep rebuilds anything.
- A group Telegram upgraded before step 2b stays two chats, the old one
  removed, as it was. A group upgraded later stays one chat with its project,
  tasks, switches, allowed people and history.
- Every read depends on chat rows being there: the app seeds before it
  serves, and the security service loads its directory before it serves.
- Small owner-visible changes:
  - Chats: a chat's header reads "Telegram ID -1001000000001" (with the
    earlier id after an upgrade) where it read "ID -1001000000001/topic/7";
    an id the directory lacks is "Unknown chat"; the people list shows people
    who left; a topic name the owner gave stays over Telegram's.
  - The chat picker no longer offers "Use the ID …" for a typed id Nocheh has
    not seen, since a Telegram id is no longer a chat id; its placeholder and
    the chat list's say "name or Telegram ID", and its empty text says "No
    chats match. Search by name or Telegram ID."
  - A served group's Topics card shows only for a forum or a group topics were
    already seen in, where main showed it for every supergroup.
  - Tasks and task settings name a chat the dashboard cannot find "A group",
    where main said "A topic" for a topic-shaped id.
  - A send or action to a topic Nocheh has never seen is refused until a
    message there, or adding the topic in Chats by link or number, makes it
    known.
- **What is lost or deferred:**
  - An upgrade whose new group's messages are captured in an earlier spool
    batch than both upgrade messages stays two chats, as an upgrade before step
    2b does.
  - A package made after step 2b that names a group by its digest, imported
    where this installation's first start already gave that group its old id,
    keeps naming the digest: a chat with no Telegram id here, so its records
    do not reach the group until adoption (step 2b-2 or later).
  - After a rollback to main, a private answer offered under step 2b (its
    asker stored as a `chat_accounts` id) cannot be pressed (`only_asker`) and
    expires within a day. Rows main writes after the rollback keep working.
    A chat first seen under step 2b has a digest id main does not know. Main
    still serves such a group under its Telegram id from
    `TELEGRAM_GROUP_IDS`, but everything step 2b kept under the digest is
    out of its reach: the group answers with no project, a tool the owner
    turned off for it reads as the every-chat setting (on by default), its
    sharing rules, tasks and Answer privately are gone, and its
    memories are not read. Redeploying step 2b brings them back; what main
    set for the group in between is not applied (below). Topic names given
    and refreshes made under step 2b live only in `chats` and `chat_details`
    rows, so main does not show them; the old Telegram tables are as they
    were.
  - After a redeploy that follows a rollback, a value main stored under the
    Telegram id of a chat step 2b had given a digest (a project, a tool
    switch or a rule set during the rollback) gets no row of its own, so it
    is not applied, and nothing says so; the owner sets it again. A topic
    value under that Telegram id gets its row when the topic has none yet.
  - Formats written under step 2b do not read on main: an owner export
    (it holds `chats` and `chat_ids`; main refuses it with
    `owner_format_unsupported`), a reset snapshot
    (`nocheh-reset-configuration-v2`; main reads only v1), and send records
    of version 2 still in the spool at rollback, which main drops from
    System › Sent to apps.
  - Changed column types stay after a rollback: `chat_sends.topic` and
    `message_id` are text and `reaction_states.update_id` is numeric, with
    their values unchanged.
  - The first seeding reads the whole archive before the app serves: about
    23 s per 300,000 archived events in a local benchmark; the
    `chat_records_ready` log gives the time on a real archive.
  - A refresh's `not_found` mark and the old tables' timestamps are copied
    into `chat_details` only as the seeder found them.
  - An imported or restored chat is served only after the next app start,
    when the bridge reads `TELEGRAM_GROUP_IDS` again.
  - A Telegram turn in flight at deploy has no app binding and is refused
    once, then retried.
  - Step 2b-2 retires `TELEGRAM_GROUP_IDS`: the served set lives in `chats`,
    the owner alone adds Nocheh, and `group_ids` leaves the policy
    fingerprint, which starts one guard epoch (ADR-0163, ADR-0168).
- Steps 3 and 4 add members on `chat_accounts.member_id` and on private chat
  rows.
- Checks: ids, the directory and its loader ([chats](../../test/chats.test.ts),
  [schema](../../test/store-chat-schema.test.ts),
  [format gate](../../test/chat-id-format-gate.test.ts)); recording, ordering,
  seeding, the bridge and the owner screens
  ([records](../../test/store-chat-records.test.ts),
  [seeding](../../test/store-chat-seed.test.ts),
  [directory](../../test/store-owner-supervision.test.ts),
  [refresh](../../test/store-telegram-chats.test.ts),
  [topics](../../test/store-telegram-topics.test.ts),
  [strangers](../../test/store-strangers.test.ts),
  [sends](../../test/store-chat-sends.test.ts),
  [portability](../../test/store-owner-portability.test.ts),
  [reset](../../test/store-reset-setup.test.ts)); reads and rules on old-shaped
  and digest chats ([spaces](../../test/spaces.test.ts),
  [tasks](../../test/store-tasks.test.ts),
  [private answers](../../test/store-private-answers.test.ts),
  [jobs](../../test/store-background-jobs.test.ts),
  [read sets](../../test/store-project-groups.test.ts),
  [provenance](../../test/store-provenance.test.ts),
  [conversation page](../../test/store-conversation-page.test.ts),
  [memory rebuild](../../test/store-memory-rebuild.test.ts)); turns, sends and
  the front doors ([front door](../../test/telegram-frontdoor.test.ts),
  [pass checks](../../test/access.test.ts),
  [dispatch](../../test/store-telegram-dispatch.test.ts),
  [destinations](../../test/store-telegram-actions.test.ts),
  [runtime profiles](../../test/store-runtime-profiles.test.ts),
  [bot](../../services/telegram/test_service.py),
  [Hermes](../../services/hermes/test_scopes.py),
  [reset preferences](../../services/hermes/test_preference_transfer.py));
  the dashboard ([model](../../test/dashboard-chats-model.test.mjs),
  [search](../../test/conversation-search.test.ts),
  [pages](../../test/dashboard-pages.browser.mjs)); and the full tester's
  `new_id_group_works_end_to_end` and `supergroup_upgrade_keeps_history`, with
  `project_groups_stay_apart` and `private_canaries_never_left_the_owner`
  running with the new-id group NG1 in P1.
</consequences>
