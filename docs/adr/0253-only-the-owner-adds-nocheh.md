# ADR-0253: Only the owner adds Nocheh to groups

<status>
Accepted on 2026-11-16 as step 2b-2, "Only the owner adds Nocheh", of the owner's
Members design, approved on 2026-11-12. In that design the owner answered that only
the owner adds Nocheh to groups, with no card asking whether to keep it: when a
member adds Nocheh, it leaves and tells the owner in one line, so the owner can add
it; when anyone else adds it, it leaves and keeps only a content-free record. On
2026-11-14 the owner chose that groups Nocheh is already in but the owner never
turned on stay silent and are listed as Off. Builds on
[ADR-0252](0252-chats-get-nochehs-own-ids.md): `chats.state` now alone says which
groups are on, and `TELEGRAM_GROUP_IDS` is retired. Amends
[ADR-0252](0252-chats-get-nochehs-own-ids.md),
[ADR-0062](0062-owner-managed-telegram-group-participants.md),
[ADR-0235](0235-nocheh-owns-the-telegram-bot.md) and
[ADR-0238](0238-record-every-send-to-a-chat-app.md) (see Amendments). Keeps
[ADR-0182](0182-strangers-cost-nothing-and-reach-no-model.md): a chat Nocheh does
not serve is archived but never prepared or shown to a model, and
[ADR-0254](0254-sends-go-only-to-chats-nocheh-serves.md): Nocheh sends only to
chats it serves.
</status>

<context>
- Until this step the owner listed served groups by their Telegram ids in
  `TELEGRAM_GROUP_IDS`, and the 2b-1 bridge copied that list into `chats.state` at
  each start. Anyone could add the bot to a group. It then sat there, silent but
  archiving, until the owner listed the group.
- The list was part of the policy document, so every on or off moved the policy
  fingerprint and needed a settings save and apply. Group access keys had to be
  in the list, and turning a group off in the dashboard dropped its allowed
  people.
- Telegram tells the bot when its own status in a chat changes
  (`my_chat_member`): who added it, who removed it, and when it left. Nocheh
  archived these updates and read nothing from them.
- A group Telegram upgrades to a supergroup has a new id. The bot's own
  `my_chat_member` for the new supergroup can arrive before the upgrade
  messages that link the two ids.
</context>

<decision>

## Which groups are on

- A group is on, so Nocheh serves it, when its chat row is `active` (a topic
  follows its group). That is the only rule. `TELEGRAM_GROUP_IDS` is not read
  anywhere: not by the app, the bot, Hermes, the tools or Compose. An old `.env` may keep the line; it is
  ignored and never shown. The applied settings revision still counts it at its
  old default, empty (`RETIRED_DEFAULTS` in `settings.py`), so an upgrade asks
  for no Apply: an empty line stays out of the revision, and a line that lists
  groups was in it before and stays in it.
- `AssistantPolicy.group_ids` stays, derived only: `servedPolicy` fills it with
  every Telegram id, current and old, of the active groups, for comparing archive
  originals. A configured value or a policy file's `group_ids` is ignored.
- The policy document and its fingerprint are `{enabled, owner_id,
  group_access}`. The first start after the upgrade writes one new revision and
  starts one guard epoch. Later on or off changes never touch the fingerprint.
- `TELEGRAM_GROUP_ACCESS` keys are checked by shape only (a negative Telegram
  chat id), in the app (`groupAccess`), the installer (`configuration.py`) and
  `group-access`. A key for a group that is off, or under an earlier Telegram id,
  is valid and grants nothing until that group is on. Turning a group off keeps
  its people.
- The directory revision also moves on every state change.
  `ChatDirectoryLoader.watch` checks it every 2 s, so every process sees an add,
  a leave or the owner's switch within about 2 s, with no guard epoch.
  `settleTelegramChat` also waits for a reload when it knows a chat that is not
  on, so a refusal never rests on an older snapshot.
- A group first seen starts off: one Nocheh is in with no add on record (for
  example after a long downtime) stays off and silent, and Nocheh never leaves it
  on its own. The seeder, an owner-record import and a version 1 reset snapshot
  bring groups back off; an import also clears the add and its order. A version
  2 reset snapshot keeps each chat's state, except a group still waiting to be
  left: it comes back off with its topics (`restoredChats`). The reset does not
  carry the leave, so no add is on record, and the group stays silent and is
  never left on its own. A group Nocheh could not leave stays that way. A group
  Telegram upgraded before step 2b stays `removed`.
- At each start `startOwnerChat` makes the owner's private chat (the
  `TELEGRAM_OWNER_ID` chat) on and turns any other private chat off. Groups keep
  their state. Upgrading needs no carry: the last 2b-1 start already wrote each
  group's state from the old list.

## Adds and removals

- **Reading the bot's status.** `telegramUpdateFacts` reads a `my_chat_member`
  update about this bot as `bot_status`: in before and after (creator,
  administrator and member are in, restricted counts its `is_member`, left and
  kicked are out), who changed it, whether that adder was hidden (Telegram's
  anonymous admin, a channel, or no `from`), and whether the bot changed its own
  status.
- **Where it applies.** `ChatRepository.adopt` runs in the capture's own
  transaction, only for a live update about a group's current Telegram id that
  was taken in after adoption began. An import, a private chat (block and
  unblock) and an update about an old id change nothing. A promotion, demotion
  or restriction that keeps the bot in changes nothing.
- **Where adoption begins.** The first start of this build sets it once, before
  anything captures: `startAdoption` stores the archive's last capture sequence
  then as `chat_seed_state.adopt_after`, and later starts keep it. The
  `chat_records_ready` log line shows it as `adopt_after`. An older original
  that the capture sweep records only now keeps its chats, names, topics and
  memberships, but its adds, removals and upgrades are history: no state change,
  no record, no leave, note or card, and no fold. After a reset the stores start
  empty, so the boundary is 0. A backup restore brings it back with the stores; a
  backup from before this build has none, and the next start sets it.
- **Order.** A bot-status update applies only when it is newer than the last
  state change (`state_seq`, `state_bot`, `state_at`, by the same rule as
  memberships). The owner's switch and Nocheh's own changes leave `state_seq`
  and `state_bot` empty and set `state_at` to now, so an older update recorded
  late never undoes them.
- **The owner adds Nocheh** (the adder's account is `TELEGRAM_OWNER_ID`): the
  group is on at once, and a card follows (below).
- **Anyone else adds Nocheh**, a person, another bot or a hidden adder: the
  group is `pending`, silent, and the stage leaves it. With no owner set, every
  add is someone else's.
- **An add that changes nothing.** An add to a group already on (a restore, a
  repeat, an upgrade) keeps it as it is, with no card and no note. An upgrade is
  never an add: any add, the owner's too, to a group that is off, pending or
  could not be left, within 10 minutes of Telegram upgrading it, is the
  upgrade's echo and changes nothing. Nocheh is still in that group, and
  Telegram reports the join from whoever upgraded it. So an upgrade never undoes
  the owner's Off, and a pending group's own leave goes ahead under its new id.
- **Leaving and removal.** Nocheh leaving on its own makes the group `left`.
  Anyone removing it makes the group `removed`.
- **The record.** Each add or removal writes one row in `chat_state_events`,
  keyed by the archive event: the chat, the Telegram id named, added or
  removed, the adder's role (`owner`, `other`, `anonymous`), their account,
  whether they are a member (granted in some group's `TELEGRAM_GROUP_ACCESS`),
  what is left to do (`card`, `leave`, `tell` or `none`), the stage's state,
  outcome, tries and notice. It holds no names and no message text. An add also
  writes who added Nocheh and when on the chat row (`added_by_account_id`,
  `added_by_role`, `added_at`, `add_event`).
- **An upgrade.** `migrate()` never changes a group's state. When both
  Telegram ids already have chats, because the new supergroup's update came
  first, a live update taken in after adoption began folds the new chat into
  the old one if only its own add ever served it: it is not on, or it is on only
  from an owner add whose card still waits. The new chat must also have no
  project answer of its own: once the card made its project, or the owner gave
  it one, the two stay apart, so no project is left naming no chat. The fold
  checks this after it locks both chats, so it sees a card's project committed
  meanwhile. Its ids, memberships, topics (except one whose key the old chat
  has) and add records move to the old chat, which keeps its state and its add.
  An owner add folded into an old chat Nocheh was not in (left, removed or
  archived) turns it on: the owner added it again. Into an old chat that is
  off, pending or could not be left, the add is the upgrade's echo: the stage
  finds the moved card or leave superseded, and a pending group's own leave
  goes ahead. Otherwise the two stay apart, as before.

## The stage

- The storage worker runs `ChatAdds.settle` every 5 s: up to 20 waiting rows
  that are due. A row is claimed for 5 minutes, and Telegram calls run outside
  any transaction. Every Telegram call has its own id and every owner command
  its own operation id, so a try repeated after a crash never leaves, sends or
  makes a project twice.
- **Leave**, 30 s after the add, so an upgrade can fold first. A group no longer
  pending from this add (the owner turned it on or off, or it was added again)
  ends the row as `superseded`. Otherwise the app asks the bot's
  `telegram.leave` for the group's current Telegram id. Left, or already gone,
  makes the group `left`. A Telegram refusal makes it `could_not_leave`: silent,
  and the owner can still turn it on or off. Any other answer, or an error, is
  tried again after 1, 2, 4 and up to 60 minutes, with no limit.
- **Notes to the owner.** After a leave, only an add by a member or by a hidden
  adder gets a note in the owner's private chat: `left_member`,
  `left_anonymous` or `could_not_leave`. A stranger's add gets only its record.
  In 24 hours a group gets at most one note about a leave, and the owner gets
  at most ten notes about leaves in all. Only sent notes about leaves count,
  and a note past a cap is marked `capped` and not sent. Removal from a group
  that was on gets one line (`removed`), outside the caps: it always goes, once
  per removal, and does not count toward them. Only a group the owner had on
  gets one, so these lines cannot flood the owner, and strangers' adds cannot
  use up a cap to hide one. Removal from any other group gets none. With no
  owner chat there is no note. A note that fails ten times is marked `failed`.
- **The card**, 30 s after the owner's add, unless the group was turned off or
  added again meanwhile. A group that already has a project answer of its own
  keeps it and gets no card, so a re-add keeps its project. Otherwise one owner
  command makes a project named after the group ("Group" when it has no name)
  and puts the group in it. The card then says the group is on, in its new
  project, with one row of up to three "Move to …" buttons for the active
  projects updated last, and a row with No project and Turn off. A bot that
  refuses the buttons gets the card as text alone.
- **A press** on the card counts only when the owner presses it in the owner's
  private chat; anyone else is told only the owner can do this. Each press is
  its own owner command, with the operation `chat-card:` and the press's own
  archived callback event id, for Turn off as for Move and No project. The
  dispatch trying the same press again gets that press's receipt. A later press
  on a card that still has its buttons (after a send whose answer was lost, or
  an edit that failed) runs again on the group as it is now. Move and No
  project write the group's project, in one command that also archives the
  card's project once no group is in it; a move to the project the group is
  already in writes the same assignment again. Turn off is the owner's switch,
  and on a group already off it keeps it off. The card then shows the answer
  under its text and loses its buttons. A press on a card that is out of date,
  and Turn off after Nocheh was removed, are answered "This card is out of
  date. Change it in the dashboard."
- **Texts.** Every line is the owner's to edit (`telegram.chat_adds`, under
  **Groups: when someone adds Nocheh** with the other built-in texts). Code
  fills `{group}`, `{name}` and `{project}`: a name someone chose is quoted,
  and a group's name also gets the short id the Chats page shows, as on send
  cards (ADR-0254), because strangers choose these names.

## The owner's switch

- `POST /v1/chats/state` (`ChatRepository.setState`) takes `{chat_id, state:
  'active'|'off', operation_id, project?}` and runs as one owner command: a
  receipt, one guard epoch and the Honcho and memory review refresh, also when
  the state does not change. Only a group has a switch (400
  `chat_not_group`). A group Nocheh left, was removed from or knows only from
  imported history is refused (409 `chat_not_joined`): the owner adds Nocheh
  there in Telegram. A pending group turned on or off is no longer left.
- `project`, only when turning on, is written in the same command: `{mode:
  'new'}` (a project named after the group), `{mode: 'assigned', project_id}` or
  `{mode: 'none'}`. The answer is `{chat_id, state, project_id}`.
- The dashboard's switch calls the route at once, with no draft. Turning on a
  group with no project answer first asks which project it joins: one of the
  owner's, a new one named after the group, or none. Turning off asks first
  and says Nocheh stays in the group, silent, and the people the owner allowed
  are kept. Each state has its label and text; only an on, off or
  couldn't-leave group has a switch. An add made without showing who (role
  `anonymous`) has its own texts for Leaving, Left and Couldn't leave, apart
  from someone else's (role `other`); its Left text says to turn off Remain
  anonymous and add Nocheh. A topic shows its group's state: it says on or off
  only when the group is on or off, and otherwise shows the group's label and
  text.
- `GET /v1/conversations` (and `/v1/owner/conversations`) takes optional `kind`
  (`private`, `group` or `topic`) and `state` (any chat state; a topic is in
  its group's). They apply with `q` before paging, so a page and its cursor
  hold only matching chats; a bad value is refused (400
  `invalid_conversation_kind`, `invalid_conversation_state`). The dashboard
  reads every group that is on this way, page by page, and uses later pages
  only when they were read after the first page's current cursor, so the list
  is never stitched from pages read at different times. The import page offers
  all of them and says "Some groups may be missing" when it cannot read the
  whole list. Its share confirm asks whenever a chat is mapped anywhere but the
  owner's private chat, as the server checks it. Refresh group names is
  available whenever any group is on, or when that list cannot be read.

## The bot and the tools

- `nocheh-telegram` gains `/internal/telegram/leave` (`{id, chat_id}`). It leaves
  only a group, supergroup or channel that is neither the owner's chat nor on in
  the app's served list, read again when that list says it is not on; a list it
  cannot read leaves nothing. Its outbound check allows only `leaveChat` for
  that chat. A final answer is kept as a receipt by id; a try whose answer never
  came keeps none and is tried again, since leaving twice changes nothing.
- Once it holds the send lock, after any receipt replay and right before
  `leaveChat` goes, the bot reads the served list once more: a chat now on, or
  the owner's, is refused with a 400, and a list it cannot read answers
  `served_list_unavailable`. It then asks the app, through
  `POST /internal/chats/leave` (`{id, chat_id}`, the service token, answer
  `{valid}`), whether the group whose current Telegram id is `chat_id` is still
  pending from the add `id`. A no answers `leave_superseded`, and no answer
  `leave_check_unavailable`. None of these keeps a receipt, so the stage asks
  again later and finds the leave superseded: a group turned on, turned off or
  added again while the leave waited behind other sends is never left.
- Telegram answering a leave that Nocheh is not there (any 403, or a 400 such
  as "chat not found" or "not a member") counts as left. Its send record keeps
  the code `already_left`, shown as "Nocheh was no longer in the chat", and is
  not a problem. A failed or uncertain leave try followed within 15 minutes by a
  sent or `already_left` try of the same leave shows as sent on a retry. A
  refusal keeps its own code and stays a problem.
- The poller asks Telegram for exactly the updates Nocheh reads: messages,
  channel posts and their edits, button presses, reactions and reaction counts,
  the bot's own and other people's membership changes, and join requests. It
  never asks for inline queries, business messages, payments, polls or boosts.
  `/health` shows what `getMe` says the bot may do (`can_join_groups`,
  `can_read_all_group_messages`, `supports_inline_queries`,
  `can_connect_to_business`), and the bot starts whatever they say.
- Notice buttons may come in up to three rows of up to three, and a card press
  (`ng`, the choice, 32 hex of the add's event) is an allowed callback.
- The tools read active groups from the app's served list
  (`GET /internal/chats`): an import maps a chat only to the owner or to a
  Telegram id an active group has had; Hermes reads served chats only from the
  app; the people directory asks Telegram only about active groups.
  `configure-telegram --group-id` is refused with a line saying to add Nocheh to
  the group from the owner's own account.

</decision>

<amendments>
- ADR-0252: "What is served in step 2b-1" no longer holds. `TELEGRAM_GROUP_IDS`
  is retired, the seeder no longer reads it, and the bridge `serve()` is replaced
  by `startOwnerChat`. Every chat state comes from adds, removals, Nocheh's own
  leaves and the owner's switch. `group_ids` holds only the active groups' ids
  and has left the policy document. The directory also reloads every 2 s when
  its revision moved, and the revision moves on a state change too. Turning a
  group on no longer writes a setting, and a group's people may be kept under
  any of its Telegram ids. A chat an owner-record import or a version 1 reset
  snapshot brings is on only once the owner turns it on; a version 2 reset
  snapshot keeps each chat's state, except a group still waiting to be left,
  which comes back off. `telegram_chat_observations` and
  `telegram_topic_registrations` stay, read-only, for now: step 2b-2 does not
  drop them.
- ADR-0062: group access keys are checked by shape only, not against a list of
  selected groups. Keys for a group that is off stay and apply when it is on
  again.
- ADR-0235: the bot's routes gain `leave`, which asks the app's
  `POST /internal/chats/leave` right before it goes; its poller asks for an
  explicit list of update kinds, and `/health` shows what `getMe` allows.
- ADR-0238: a send record has the kind `leave`, shown as "Leave a group". A
  leave that found Nocheh gone keeps the harmless code `already_left`, and a
  later try of the same leave that went or found Nocheh gone recovers an
  earlier failed or uncertain try.
</amendments>

<alternatives>
- **A keep-or-leave card for someone else's add.** Rejected by the owner on
  2026-11-12: only the owner adds Nocheh, and a member's add gets a one-line note
  so the owner can add it.
- **Leave every group with no add on record.** The design's first rule.
  Replaced by the owner's choice of 2026-11-14: such a group stays Off and
  silent, and the owner can turn it on.
- **Ask which project before an owner's add is on.** Not built: the owner may
  mention Nocheh right after adding it. The group is on at once in its own new
  project, and the card lets the owner move it, take it out or turn it off.
- **A one-time carry of `TELEGRAM_GROUP_IDS`.** Not needed: the last 2b-1 start
  already wrote each group's state from that list.
- **A guard epoch for each add or leave.** Rejected: the directory revision and
  the 2 s watch tell every process, and an epoch would restart sessions for
  every chat on an event a stranger can cause.
</alternatives>

<consequences>
- The owner adds Nocheh to a group in Telegram and it answers there at once.
  The card follows about 30 s later. Someone else's add is left about 30 s
  later. Turning a group on or off in Chats takes effect at once, with no Save.
- Messages from a group Nocheh is leaving, has left or could not leave stay in
  the archive like any chat Nocheh does not serve: never prepared, learned or
  shown to a model (ADR-0182). Nocheh answers nothing there and sends no fixed
  reply.
- Upgrading keeps every group's state. The first start writes one runtime
  configuration revision and starts one guard epoch. It also sets where
  adoption begins, so adds and removals already in the archive are never acted
  on, whether or not the 2b-1 build recorded each update once. Settings asks
  for no Apply for an old `TELEGRAM_GROUP_IDS` line.
- The bot asks the app before each leave, so `nocheh-app` and `nocheh-telegram`
  run the same build. A bot newer than the app gets no answer from the new
  route, and its leaves wait (`leave_check_unavailable`) until both match.
- Each switch, each card's project and each press on a card (Move, No project
  or Turn off) is its own owner command, with one guard epoch. Adds, removals
  and leaves move none.
- Rollback to 2b-1 needs `TELEGRAM_GROUP_IDS` written again from the active
  groups, and every `TELEGRAM_GROUP_ACCESS` key not in it removed, since 2b-1
  refuses to start otherwise ([deploy](../deploy.md#roll-back-to-step-2b-1)).
  A reset snapshot written under 2b-2 holds no `group_ids`, which 2b-1's
  restore refuses, so take a backup before upgrading. Where adoption begins
  stays through a rollback and a later upgrade.
- **Residuals:**
  - The upgrade echo rule and the fold follow the order the fake Telegram and
    the store tests use. Telegram's real order of updates during an upgrade
    needs a live check.
  - A leave is retried without limit while the bot cannot be reached, refuses
    the request (for example on a stale served list) or cannot get the app's
    answer. The group stays pending and silent meanwhile.
  - A leave Telegram answers by saying it upgraded the group keeps the send
    code `rejected`, so Sent to apps counts it as a problem, though the stage
    leaves the group again under its new id.
  - The caps are counted without a lock. Two stage runs at once could each send
    one note past a cap; only the app's storage worker runs the stage.
  - The card is rebuilt from the group's and the project's names when a press
    edits it, since the add record holds no names; a rename in between shows.
  - The fold runs only for a live update taken in after adoption began. A
    refresh, an import, history and a split from before step 2b keep two
    chats, and so does an upgrade whose new chat already has a project answer,
    for example when the upgrade messages come after the card made its project.
  - A rollback to a 2b-1 build without the fix that records each update once,
    then an upgrade again: updates that build took in but never marked recorded
    are after the boundary, so the next 2b-2 start may act on their adds and
    removals. A 2b-1 build with that fix marks them.
  - A group that is leaving has no switch in the dashboard, though the route
    accepts it. Settings › Telegram no longer says how many groups Nocheh is on
    in.
  - A package made after step 2b that names a group by its digest, imported
    where the group has its old id, still does not reach the group (ADR-0252).
  - Messages from a group Nocheh leaves stay in the archive like any chat
    Nocheh does not serve, and nothing deletes them.
  - `telegram_chat_observations` and `telegram_topic_registrations` stay,
    read-only, although ADR-0252 said step 2b-2 drops them (see Amendments).
- Checks: reading the bot's status
  ([facts](../../test/chats-telegram-updates.test.ts)); adds, removals, order,
  upgrades and folds, the owner's switch and the start, history before the
  boundary, upgrade echoes in both orders run through the stage, and a fold
  after the card made its project
  ([adoption](../../test/store-chat-adoption.test.ts)); the stage's leaves,
  the app's last check before a leave, notes, caps outside which a removal's
  line goes, the card and each press as its own command
  ([stage](../../test/store-chat-adds.test.ts),
  [buttons](../../test/chat-adds.test.ts),
  [route](../../test/store-server.test.ts)); leave send records
  ([records](../../test/store-chat-sends.test.ts),
  [bot records](../../services/telegram/test_sends.py),
  [labels](../../test/dashboard-system-health.test.mjs)); the policy, its
  fingerprint and the retired list's applied revision
  ([policy](../../test/assistant.test.ts),
  [configuration](../../test/store-runtime-configuration.test.ts),
  [settings](../../services/hermes/test_settings.py)); seeding, records,
  imports and resets, a waiting group restored off
  ([seeding](../../test/store-chat-seed.test.ts),
  [records](../../test/store-chat-records.test.ts),
  [portability](../../test/store-owner-portability.test.ts),
  [reset](../../test/store-reset-setup.test.ts),
  [reset tools](../../services/hermes/test_reset_preservation.py)); the bot,
  with the served list and the app asked again inside the send lock
  ([leave](../../services/telegram/test_leave.py),
  [card buttons](../../services/telegram/test_approval_cards.py),
  [health](../../services/telegram/test_health.py),
  [service](../../services/telegram/test_service.py),
  [front door](../../test/telegram-frontdoor.test.ts)); the tools
  ([configuration](../../services/hermes/test_configuration.py),
  [imports](../../services/hermes/test_import_jobs.py),
  [Hermes](../../services/hermes/test_scopes.py)); the conversations filters
  ([supervision](../../test/store-owner-supervision.test.ts)); the dashboard
  ([model](../../test/dashboard-chats-model.test.mjs),
  [served groups](../../test/dashboard-chat-directory.test.mjs),
  [pages](../../test/dashboard-pages.browser.mjs)); and the full tester's
  `owner_adds_nocheh_on_at_once`, `member_add_leaves_and_tells_owner`,
  `stranger_add_leaves_without_a_note`, `anonymous_add_leaves_and_tells_owner`,
  `member_re_add_leaves_again_with_no_second_note`,
  `member_add_that_cannot_leave_stays_silent`,
  `removed_from_active_group_tells_owner_once`,
  `off_group_turned_on_and_off_from_the_dashboard` and `unselected_group`, which
  count `leaveChat` calls and owner notes per group. Before an add that expects
  a note, the tester moves earlier sent notes about other groups' leaves out of
  the 24 hours, so a kept fixture's earlier runs never fill the cap on all
  notes; this group's own notes stay, so its own cap still holds.
</consequences>
