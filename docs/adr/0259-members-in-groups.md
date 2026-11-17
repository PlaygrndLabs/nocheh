# ADR-0259: Members in groups

<status>
Accepted on 2026-11-17, as step 3 of the Members design, "Members in groups".
The owner approved the design on 2026-11-12 ("seems what I want ... else start
build"), with these words for this step: members are "allowed by default in the
groups they are in", and the owner "needs an option to control a member's
access"; a "permission scope per user something like telegram GP"; talk to
Nocheh in groups stays on by default ("keep it on"); no daily limit on members'
small jobs in groups; "No approval for anything" for members' web pages and
outside tools in groups; small jobs, posts to their other groups and web pages
and tools are sub-permissions of talking to Nocheh in groups; one "Tasks: read
and write (or read only)" setting, where task access is data access; and the
daily message cap stays, high. The step's own decisions of 2026-11-17 are
recorded below under "Owner decisions for this step".

Supersedes [ADR-0062](0062-owner-managed-telegram-group-participants.md): the
grant and deny lists in `TELEGRAM_GROUP_ACCESS` give way to members kept in the
control store. Amends
[ADR-0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md) (members have
no daily job count),
[ADR-0248](0248-tasks-follow-data-access.md) (a member's tasks can be read only,
and each task call checks the member again),
[ADR-0253](0253-only-the-owner-adds-nocheh.md) (the runtime document loses
`group_access`, an add note's member flag reads the member records, and the add
card's own project moves no guard epoch) and
[ADR-0255](0255-reminders-say-who-set-them.md) (reminder labels name members).
Also amends [ADR-0244](0244-owner-defaults-posts-and-machine-reports-stay-private.md)'s
owner ID guard, [ADR-0254](0254-sends-go-only-to-chats-nocheh-serves.md)'s person
destination, [ADR-0251](0251-fixes-that-lose-nothing.md)'s voice cut,
[ADR-0159](0159-group-members-post-freely-and-approvals-go-private.md) and
[ADR-0161](0161-requesters-review-their-own-cross-group-messages.md) on posts
to other groups, [ADR-0182](0182-strangers-cost-nothing-and-reach-no-model.md)
on the fixed reply in a group, and
[ADR-0029](0029-controlled-tool-execution.md) for web pages and outside tools
asked for in a group. Keeps [ADR-0252](0252-chats-get-nochehs-own-ids.md)'s ids
and directory and [ADR-0249](0249-answer-privately.md), which stays the owner's.
</status>

<context>
- Before this step, who besides the owner may talk to Nocheh in a group was one
  `.env` value, `TELEGRAM_GROUP_ACCESS` (`{group's Telegram id: {granted,
  denied}}`). Five places parsed it: the app's policy and send destinations,
  `nocheh-telegram`, Hermes, the installer and the CLI. Each process read it at
  start, so a change needed Apply and a service restart, and since it was part of
  the runtime document, every change also moved the guard epoch.
- It had one switch per person and group: no pause, no permissions, no daily
  cap, and every job a member started counted toward three a day in each group.
- Step 2b gave every chat and person Nocheh's own id and records
  (`chat_accounts`, `chat_memberships`, ADR-0252), and step 2b-2 made which
  groups are on a chat record (ADR-0253). `chat_accounts.member_id` was left
  for this step.
- Telegram only narrows. A bot that is not an admin sees every message that
  addresses it, and the `new_chat_members` and `left_chat_member` service
  messages, but `chat_member` updates come only to admins, and Telegram has no
  member list. Each message proves its sender is in the group at that moment;
  capture writes their 'in' row before the turn runs.
</context>

<decision>

## Owner decisions for this step

The step 3 thread decided four questions on 2026-11-17. They replace the plan's
earlier wording where the two differ.

1. **A member's group with no switch counts as on.** Members are allowed by
   default in the groups they are in (the owner's design comment of
   2026-11-12). A member talks in a served group unless its switch for them is
   off. The "New here" badge only informs. Decisions made without a message from
   that group still need Telegram's 'in'. The carry keeps today's exact reach,
   and the add flow writes a row for every group it shows.
2. **No "Asked, not allowed" list.** There is no `not_allowed_people` table, no
   record at dispatch and no list on the page. Someone who writes in a group
   already shows among that group's people, because capture records every human
   sender, so the add flow covers them. The fixed reply stays. The bot no longer
   skips people on its own list: the core decides, and a member who is paused or
   switched off in a group gets the same reply as a stranger, at most once a UTC
   day per group.
3. **Keep "Add by Telegram user ID"**, so the step loses nothing the owner had.
   On the Members page the owner enters an ID and ticks groups from every group
   Nocheh is in, none ticked at first. The account is made with `ensureAccount`.
   They talk from their first message; decisions without a message wait for
   Telegram's 'in'.
4. **The owner's own web page reads and outside tools in a group skip the card
   too.** The owner answered yes on 2026-11-17. It is built behind one switch, so
   "no" is a one-line change (see "Web pages and outside tools").

## Members and their switches

- Control store tables, created only if missing (`src/stores/member-schema.ts`):
  - `members`: `state` (`active` or `paused`), `group_talk`, `group_jobs`,
    `group_post_other` and `group_tools` (each on by default), and `tasks`
    (`write` by default, or `read`).
  - `member_chats`: a member's switch for one group. A trigger takes only a
    `chats` row of kind `group`, so a topic follows its group.
  - `member_directory_state`: the member `revision`, `carried_at` and
    `daily_messages` (200 by default, 1 to 10,000).
  - `member_turns`: the daily cap's count, one row per member and event.
  - `chat_accounts.member_id` gets its foreign key, `ON DELETE SET NULL`.
- A member's id is `digest(canonical(['member', account]))` of the first account
  it was made for. Only Nocheh ids are stored; Telegram user ids stay in
  `chat_accounts`.
- Remove deletes the member. Its switches and counts go with it, its accounts
  are unlinked, and Telegram's membership rows stay. Tasks and reminders name
  people by account, so they stay as they are.
- The owner is never a member and has no `members` row; the owner stays
  `TELEGRAM_OWNER_ID` (ADR-0244). An add naming the owner is refused
  (`member_account_invalid`). If the owner's account is linked to a member
  anyway, the directory never counts it, and the Members page warns
  (`owner_linked`). This replaces ADR-0244's settings check, which refused an
  owner ID listed in the access lists: the lists are gone.

## What a member may do

The member directory (`src/members.ts`) answers every person check. It takes a
`chat_accounts` id and a Nocheh chat id, and a topic counts as its group:

- `talks(account, chat)`: the group is served and the member is active, has
  talk on, and the group's switch is on or absent. It never reads Telegram's
  rows, because a live message proves its sender is there.
- `may(account, chat, 'jobs'|'post'|'tools')`: `talks`, plus that permission.
  With talk off every sub-permission is off, and each keeps its own value for
  when talk is back on.
- `reaches(account, chat, permission?)`: `may` (or `talks`), and Telegram's
  newest row for one of the member's accounts in that group says 'in'. No row,
  or 'left', is not reached. Every decision made without a live message from
  that group uses it: a post into another group, a person destination, a running
  job, a job card's presser.
- `tasks(account)`: `write` or `read`.
- `accounts()`: each member account that reaches a served group, with those
  groups.

Each caller checks the owner first and keeps the owner's own outcome, an owner
card or an owner approval, never a member refusal. An unknown account, a private
chat, an unknown chat and a group that is not served are false everywhere.

| Permission (dashboard words) | Default | Checked at |
| --- | --- | --- |
| Talk to Nocheh in groups they joined | on | admission, the voice cut, the final reply check, task calls |
| · Small jobs (no daily limit) | on | job start, a running job, the job card's buttons |
| · Post to their other groups (they confirm each post with a card) | on | the proposal, the reviewer, the destinations list, the send |
| · Web pages and outside tools (no approval) | on | the tools grant and the claim |
| Tasks: Read and write / Read only | read and write | each task call |

## The directory is current without a guard epoch

- The directory lives in `nocheh-app` only. Its loader (`src/stores/members.ts`)
  reads members, linked accounts, switches, member accounts' newest group
  memberships and the daily cap in one REPEATABLE READ snapshot. It starts in
  `startChatRecords` after the carry. It loads again after every commit in this
  process that moves the member revision, and watches the revision every 2 s for
  other containers, such as a reset or a restore. A failed load keeps the
  previous directory. A process that never loads one has the empty directory,
  which admits only the owner; `nocheh-security`'s broker needs none.
- The member revision moves with every member command, when a member account's
  membership row is made or switches between 'in' and 'left', when a group
  upgrade moves switches, and with the carry.
- Member commands are owner commands run with `{epoch:false}`. They keep the
  admin check, the receipt, idempotency by operation id and request hash, and the
  conflict error. They move no guard epoch and ask for no Honcho or memory review
  refresh, and the receipt keeps the current epoch with `holds_memory` false. No
  member change restarts a service.
- The runtime document is `{enabled, owner_id}`. The first start after the
  upgrade writes one new revision and one guard epoch.
- A refusal at admission looks again with a fresh directory first, so someone
  added a moment ago is answered.

## Where a member is checked again

In step 3 a group turn reads only its own group, so in its last seconds a
member's turn reads only what the member could read when the turn was admitted.
That is how this step reads the design's check on every read and tool call: the
per-call membership check comes with step 4, whose member private chat reads many
groups. Here each effect checks the member again just before it happens:

- **Replies.** `conversationScope` admits the owner, or a sender who is not a
  `sender_chat` post or a proxy account and `talks` there. Every caller follows:
  admission, the turn's own check, continuations, a job's live turn, a send's
  requester, owner commands, and the final check before a reply is delivered. A
  member paused mid-turn gets no reply. Hermes and `nocheh-telegram` keep no
  person check: Hermes admits the human sender the core admitted and signed this
  event's pass for, and never a `sender_chat` post.
- **Daily message cap.** After the addressing check, a member's turn adds
  `member_turns(member, event, UTC day)`, so a retry counts once, and rows older
  than yesterday are pruned. Over `daily_messages`, the turn ends as
  `member_daily_limit`, with no model, and the owner's `telegram.member_daily_limit`
  reply goes at most once a UTC day per person and group. The owner is never
  counted.
- **The fixed reply.** A stranger, or a member who is paused, has talk off or is
  switched off there, gets `telegram.not_allowed` when they address Nocheh, at
  most once a UTC day per person and group. The bot keys the reply
  `refusal-<kind>-<chat>-<user>-<day>`, where the kind is `not_allowed` or
  `daily_limit`. Only a reply that may have reached Telegram uses up the day's:
  one Telegram refused, such as in a closed topic, or that never left keeps it
  for that person's next message. The private reply works the same way and is
  otherwise unchanged. A post in a chat's own name or from a proxy account gets
  nothing.
- **Voice notes.** `allowedSender` asks `talks`, so someone who is not the owner
  or a member who talks there has a live recording cut to 15 minutes (ADR-0251).
- **Tasks.** A non-owner sender must still pass `talks` in the group at each task
  call, or gets 403 `member_access_changed`, so a member paused mid-turn writes
  no task or reminder. A member whose tasks are read only gets a read-only turn,
  which lists and reads but adds, changes, comments on and sets reminders on
  nothing. Which tasks a group sees is unchanged (ADR-0248).
- **Send destinations.** `allowedIn(group, user, permission)` is `reaches`, and
  `allowedAccounts()` is the directory's `accounts()`. A member's private chat is
  a destination while they reach a served group, always behind the owner's card
  (ADR-0254).
- **Jobs.** The daily job count is gone, with `member_daily_jobs`, its setting
  and the card's `member_limit` line. A member needs `may(..., 'jobs')` where they
  ask, else 403 `job_not_permitted`. A running job asks `reaches(..., 'jobs')`, so
  a pause, a switch or permission turned off, or Telegram saying they left stops
  it. Their own card's buttons work only while that holds. A job over the cost
  limit or with no price still needs the owner's card, and machines, the box and
  GitHub copies stay the owner's.
- **Posts.** A post in the same group is part of talking. A member's post to
  another group needs `may(..., 'post')` in the group where they ask, else 403
  `member_post_not_allowed`, with no card. Their own card for it (ADR-0161) comes
  only for a target group they reach with that permission, where Telegram has
  shown them; otherwise the owner gets the card. The request keeps
  `asker_account`. Before the send runs, and in the bot's check before each
  message, the asker must still talk in the group they asked in, and for another
  group still may post. Otherwise the send is cancelled as `member_changed`, and
  its card says why (`reason_member_changed`). That also covers a send the
  member confirmed, or the owner approved, before a pause.

## Web pages and outside tools

- `groupToolsGrant` in `src/stores/controlled-actions.ts` approves without a card
  a web page read (`browser`) or an outside tool (`mcp`, never a Notion
  connection), asked for in a live group turn, not in a job, a scheduled task or
  a follow-up, by a member with `may(..., 'tools')`. The row keeps
  `authority='group_tools'` and the member's `asker_account`.
- Deny rules and the owner's tool switches for the chat come first. A member
  with the permission off gets 403 `tool_not_permitted` before anything is
  recorded or checked for secrets. A command still needs the owner's card.
- The claim evaluates with the row's authority. For a member's row it checks
  again that they still talk there and, under `group_tools`, still have the
  permission; otherwise it blocks the run as `member_changed`. An owner decision
  on the row clears its authority.
- The model is told the result from the editable `telegram.group_tools_texts`
  lines, `allowed_follow_up` and `allowed`.
- The owner's own request in a group gets the same grant, with no
  `asker_account` (owner decision 4). The one switch is
  `let ownerGroupTools=true` in `groupToolsGrant`'s file; setting it to `false`
  gives each of the owner's group requests its card again.

## The Members page and its routes

- Owner routes, in the three route allowlists: `GET /v1/members`,
  `POST /v1/members`, `POST /v1/members/<id>`, `POST /v1/members/<id>/remove`
  and `POST /v1/members/settings` (the daily cap).
  - The list reads `chat_memberships` directly, with no cap on groups or people.
    It holds the member revision, the cap, every group Nocheh is in (`groups`),
    each member with their permissions and groups, and `people`: human accounts
    seen 'in' in a group Nocheh is in that are not members, never the owner, a
    bot or a proxy account.
  - A member's group shows `on` (the row, or on with no row), `telegram` ('in',
    'left' or none) and `new` ('in' with no row).
- An add names `account_id`, a person Nocheh has seen, or `telegram_id` (owner
  decision 3), and a map of groups to true or false with at least one true. True
  writes a switched-on row and false a switched-off row; a group left out gets
  none.
  - With `account_id`, each true group needs Telegram's newest row for them to
    say 'in' (Rule 1, 409 `member_group_not_seen`).
  - With `telegram_id`, any group Nocheh is in may be true.
  - Every group named must be one Nocheh is in (400 `member_group_invalid`).
- A change switches a group off for any group Nocheh is in. Switching one on
  changes an existing row, or makes one only where Telegram shows them 'in'.
- On the page:
  - Members sits in the sidebar after Chats.
  - Every control saves at once as an owner command, with no Save bar.
  - Each member page has "Talk to Nocheh in groups they joined", with its three
    switches disabled while it is off, "Read and write / Read only" for tasks,
    and each group with its switch and what Telegram last said ("Seen here",
    "Left the group (Telegram says)", "Nothing from Telegram yet", and "New
    here"). It also has "Pause this member", Remove, which asks first, and the
    daily cap for every member.
  - Add picks someone seen in the groups, with their groups all ticked, or takes
    a Telegram user ID with every group Nocheh is in shown and none ticked. Every
    group shown is sent, ticked or not.
  - Names come from `/v1/telegram/identities`. It now lists each member account
    with a switch in a group (`member: true`), seen there or not, and the
    management side asks Telegram for those names only (`getChatMember`). Nothing
    at runtime asks Telegram who is a member.
- The group card in Chats becomes "Members here", read only:
  - You, always.
  - Each member, as "Can talk here", "Off here", "Paused" or "Talk switched off",
    linking to their page.
  - "Seen here, not members", with "Make member".
  - The Chats people Save path, the group access helpers, Settings' "Who can talk
    in groups" and System's "Jobs a member may start each day" are gone.
- Texts:
  - New: `telegram.member_daily_limit`, `telegram.group_tools_texts` and
    `reason_member_changed` in `telegram.approval_texts`.
  - Reworded defaults: `telegram.not_allowed`, `rule_note`, `person_chat`,
    `person_chat_more` and the reminder lines `person`, `person_gone` and
    `unnamed_person` now say "member".
  - `background.texts` loses `member_limit`.
  - Texts the owner changed are kept.

## Carrying the lists, and retiring `TELEGRAM_GROUP_ACCESS`

- **When.** The carry (`src/stores/member-carry.ts`) runs once, at the app's
  start after the chat seeder and the owner's chat, guarded by `carried_at`. It
  only inserts.
- **What it reads.** Its source is the newest `assistant` runtime document that
  still has a `group_access` key: the lists the last start before step 3
  admitted. No setting is read, and a fresh install only sets the marker.
- **How it reads.**
  - Each key is resolved through `chat_ids` by any id the group has had, and the
    lists of one group are joined; a denial under any key wins there.
  - Person ids go through `isTelegramAccount` and `accountIdFor`, with no new
    Telegram-shaped pattern.
  - Skipped and counted in one `member_carry` log line: malformed entries, keys
    with no group row, the owner, proxy accounts, accounts recorded as bots, ids
    that are no Telegram user id, people only ever denied, and a group a granted
    person is denied in.
- **What it writes.** Each remaining person:
  - gets an account (`ensureAccount`) if Nocheh never saw them;
  - becomes a member with every permission on and tasks read and write;
  - keeps exact reach: a switched-on row for each group they were granted in, and
    a switched-off row for every other group chat Nocheh has a row for (owner
    decision 1).
  - Telegram's rows are not asked, because the owner's list is the authority.
  - A database error stops the start, like any start step.
- **Retired.** `TELEGRAM_GROUP_ACCESS` leaves the policy, Compose, `.env.example`,
  the installer's defaults and checks, the dashboard's settings, `nocheh-telegram`
  and Hermes. The `group-access` command is deleted. An old `.env` line is hidden
  and cannot be saved. It never makes Settings ask for Apply, and no service
  reads it.
- **Reset snapshots.** A reset snapshot is format v3 only. It carries `members`,
  `member_accounts` (`member_id`, `app`, `external_id`), `member_chats` and
  `daily_messages`. A restore makes the accounts again with `ensureAccount`,
  links them and sets `carried_at`, so the carry never runs over a restored
  setup. A v1 or v2 snapshot, or a runtime document holding `group_access` or
  `group_ids`, is refused (`reset_setup_snapshot_invalid`). The Python reset
  tools follow. Members stay out of the owner export, as grants do.

## Group upgrades and the add card

- When an upgrade's new chat folds into the old one, members' switches move to
  the old id before the new chat goes. When the two stay apart, they are copied
  to the new id. A switch already there and off stays off, and both moves bump
  the member revision. `ON DELETE CASCADE` is only a backstop.
- An add note's `member` flag (ADR-0253) means the adder's account is linked to a
  member.
- The add card's own new project, holding only that group, runs its owner command
  with `{epoch:false}`. It changes no one's reach, so a reply already running in
  the group sends on its first try. **Move to** presses keep the epoch move.

</decision>

<alternatives>
- **New groups off until the owner switches them on.** The plan's first answer
  to the "New here" question; replaced by owner decision 1.
- **An "Asked, not allowed" list.** Cut by owner decision 2: the group's people
  already show who wrote there.
- **Asking Telegram (`getChatMember`) at runtime.** Not in step 3. Talk needs no
  proof beyond the message itself. The check before a member's private reads
  comes with step 4.
- **The per-call member check on every storage and broker call now.** Moved to
  step 4. In step 3 a turn reads only its own group, and every effect is checked
  again at its own site.
- **A copy of the member list in `nocheh-telegram`, Hermes or `nocheh-security`.**
  Rejected: copies drift, and the core is the only checker.
- **Keeping members in `.env` or in the runtime document.** Rejected: every
  change would restart services and move the guard epoch.
- **A per-member daily job count.** Dropped at the owner's word. The cost limit
  and the members' spend marks (ADR-0251) stay.
- **Restoring v1 and v2 reset snapshots.** Refused in development mode.
- **A member row for the owner, or a defaults table for members.** Not built:
  the owner stays `TELEGRAM_OWNER_ID`, and defaults live in code.
</alternatives>

<consequences>
- The owner manages members in one place, and every change applies at once: no
  restart, no Apply and no guard epoch. The first start after the upgrade writes
  one runtime revision and one guard epoch.
- `nocheh-app` alone decides who talks. The bot no longer skips anyone on a list
  of its own, so a member who is paused or switched off in a group gets the
  fixed reply like a stranger, once a day per group.
- A stranger who keeps writing in a group gets one fixed reply a UTC day there,
  where before each addressed message got one.
- Talk is never narrowed by a stale Telegram row. Decisions made without a
  message fail closed: a post into a group Telegram never showed the member in
  goes to the owner's card. A member who left silently, which a bot that is not
  an admin may not see, keeps reach there until a leave arrives. The docs
  recommend making the bot an admin in member groups, but do not require it.
- A carried member keeps exactly the groups they had. A group Nocheh is in for
  the first time after the carry has no row for them, so it counts as on, like
  it does for every member.
- A member someone added by Telegram user ID talks from their first message.
  Posts into a group from another one, and jobs there, wait until Telegram shows
  them in it.
- A member's web page reads and outside tools in their groups run without the
  owner's card, and so do the owner's own. Text others post in the group can
  steer them; the owner accepted that. Deny rules and the per-chat tool switches
  still apply, and commands still ask.
- A paused member's turn in flight may still read its group's data for a few
  seconds. Its reply, sends, tool runs, jobs and task writes are stopped at their
  own checks.
- One Hermes profile per chat is shared by speakers with different permissions.
  No permission lives in profile configuration: each is checked in the core, at
  each call site.
- The carry reads only the stored runtime documents. A group list for a group
  Nocheh was never in is not carried, and the carry can be removed once every
  installation has run it.
</consequences>
