# ADR-0265: Member mini app

<status>
Accepted on 2026-11-19, as step 5 of the Members design, "Member mini app". The
owner approved the design on 2026-11-12: a limited mini app for members with the
shared tasks of their groups' projects, settings and a chat page later; member
identity from Telegram's signed launch data with a short maximum age; an active
member check on every call; separate member routes on `nocheh-app`, never the
dashboard proxy; one "Tasks: read and write (or read only)" permission for
groups and the app, where task access is data access and write includes trash;
"Reminders to themselves" under it; and reminders that go to whoever set them.
The owner's final answers to the step's four questions are recorded below under
"The owner's answers", and the step follows them.

Extends [ADR-0162](0162-telegram-mini-app.md) (one more page on the same
service, address and tunnel) and [ADR-0189](0189-mini-app-password.md) (the
members' page has no password). Replaces, each only as named under "Named
replacements": a line of ADR-0162 and two details of ADR-0189 that the code had
already left; how [ADR-0255](0255-reminders-say-who-set-them.md) delivers a
person's reminder; the card rule of
[ADR-0254](0254-sends-go-only-to-chats-nocheh-serves.md) and
[ADR-0262](0262-member-private-chat.md) for one kind of send; what
[ADR-0248](0248-tasks-follow-data-access.md) lets a project's chats read of a
task; and the menu button gap of
[ADR-0238](0238-record-every-send-to-a-chat-app.md). Amends
[ADR-0260](0260-members-in-groups.md) (the Tasks permission covers the app, and
a new permission under it) and ADR-0262 (the private chat's task shape, and the
group query shared with the app). Keeps [ADR-0256](0256-nochehs-own-messages-carry-a-send-class.md):
a member's reminder is sent as `reminder`, which is never learned.
</status>

<context>
- Before this step, only the owner had a mini app ([ADR-0162](0162-telegram-mini-app.md)).
  Members reached tasks only by asking Nocheh in a group (read and write) or in
  their own private chat (read only, ADR-0262).
- The mini app service (`nocheh-miniapp`) is the only part of Nocheh a tunnel
  exposes. It holds no credentials, and it sat on Compose's `default` network
  with the database, the machines and the Telegram bot.
- Every reminder a person set went to the owner's private chat, merged per group
  (ADR-0255). A member's own private chat was a destination only behind the
  owner's card (ADR-0254, ADR-0262).
- A project's chats read a task with its `people` and `assignees` as the owner's
  names for people, and with the values of person columns the owner shared.
- Telegram signs a Mini App's launch data with Ed25519 for third parties, so a
  service can check it with Telegram's public key and the bot's public id, with
  no bot token. The launch data names the user and, optionally, `chat_type`.
</context>

<decision>

## The owner's answers

1. **Trash (Q1).** Write includes trash, with no switch (the owner, 2026-11-12:
   "task access = data access … write includes trash").
2. **Languages (Q2).** English only. The members' page has no other language
   and no language choice, and stores none. Bot texts, the member's reminder
   included, stay the owner's editable texts, in the one task time zone.
3. **Who uses the app (Q3).** Only members. A member whose private chat or
   "Reminders to themselves" is off keeps the app as the Tasks permission
   allows; "Remind me" is then hidden, with one line saying why. Anyone who is
   not an active member gets the closed page. A reminder a member set in the app
   that cannot reach them is skipped, with a System › Health line; one they set
   in a group goes to the owner, as before.
4. **Assignees (Q4).** The owner's own labels for people (the names in
   Memory › People, such as "Ali (client)") never reach a member or a group. An
   assignee shows by their Telegram name, the name "Made by" uses, only when the
   owner linked them to a person's Telegram account that is in one of the groups
   the view reaches now; every other assignee is counted as "N other people".
   Every project view follows this: a group or topic, a member's private chat
   (D14) and the app. "Made by" and "Finished by" show only where the board shows
   them (when it happened on that board), with Telegram names.

## A separate page at `/m/` (D1)

- `nocheh-miniapp` serves the members' page at `/m/` (and `/m/index.html`) and
  its script at `/assets/member.js`, on the same address and tunnel as the
  owner's page at `/`, which is unchanged. `tools/build/build-dashboard.mjs` builds
  `dashboard/member.tsx` and copies `dashboard/member.html`.
- Both pages share one origin, so the members' page keeps apart from the owner's:
  it imports none of the owner's pages or API client, uses only its own storage
  keys (`nocheh.member-launch` in sessionStorage, `nocheh.member-ui` in
  localStorage) and never reads the owner's, never renders raw HTML, and opens
  only http(s) links. `/m/` and `member.js` are served with the owner page's CSP
  plus `require-trusted-types-for 'script'`.
- Tabs: Tasks, Groups, Chat (greyed, "Coming later.") and Settings. Instead of
  data the page can show: "Open me again from the menu button" for a launch the
  server refuses as too old, older than an add, un-pause or sign-out, or invalid;
  "This app is closed for you. Ask the owner if this is a mistake." for anyone
  who is not an active member; and "This page is for members. Use your own menu
  button." for the owner, where it clears its own keys and stores nothing.

## Identity: Telegram's launch data on every call (D2)

- `src/telegram-launch.ts` holds `verifyLaunchUser`, moved out of `mini-app.ts`:
  at most 8192 bytes, each key once, the Ed25519 signature for this bot, at most
  60 s in the future, and a maximum age. It returns the user id, `auth_date`, a
  checked `language_code`, and `chat_type`, which may only be absent (the menu
  button) or `sender`; anything else is refused. It never says whether the user is
  a member. The owner's `verifyLaunch` wraps it with its own day and
  `owner_required`, unchanged; `management.ts` imports it from there.
- Members' launches are accepted for at most an hour (`MEMBER_LAUNCH_MAX_AGE`
  3600). There is no password, session table or token: the launch data in
  `x-telegram-init-data` is the credential on every call, checked twice, by
  `nocheh-miniapp` at the edge and again by `nocheh-app`, which decides who the
  owner is from its own policy and chat directory.
- `nocheh-app` gets `TELEGRAM_BOT_ID` and `TELEGRAM_TEST_ENVIRONMENT`, both
  public. `launchKey(env, botId)` picks Telegram's production or test key. A
  fixture key, `TELEGRAM_LAUNCH_PUBLIC_KEY`, is honoured only with
  `NOCHEH_INSTALLATION_FIXTURE=1`, the fake bot's id `123456` and 64 hex
  characters; set without them, the process refuses to start
  (`telegram_launch_fixture_key_refused`). Neither is written into
  `docker-compose.yml`; the tester adds both.
- The launch data is never logged; every member answer is `no-store`, and the
  page strips the address hash at once.

## No new credential, a separate listener and a smaller network (D3)

- `nocheh-app` opens a second listener, `MEMBER_APP_PORT` 8790, that serves only
  `/v1/member-app/*` (`src/stores/member-app.ts`). The main listener on 8780
  answers 404 for that prefix before anything else runs. The member listener
  refuses any `Authorization` header (400 `member_app_no_bearer`), so no turn
  pass or service token mixes in, and it builds its own principal, never a
  `Reader`, and never runs a turn.
- `nocheh-miniapp` forwards `/api/member/<route>` to
  `http://nocheh-app:8790/v1/member-app/<route>` (`NOCHEH_APP_URL`) through a new
  `AppClient`, only for `MEMBER_APP_ROUTES`, with a query only on `GET tasks` and
  at most 600 characters, a body of at most 64 KiB, and only the launch header,
  the content type and the body. No phone session, cookie or header goes either
  way. It keeps the cross-site Origin refusal, refuses the owner's launch with 403
  `member_required` and maps every launch failure to 401
  `member_app_launch_invalid`. The owner's routes are unchanged: a member's launch
  on `/api/nocheh/*` still gets 403 `owner_required`.
- Network: `nocheh-miniapp` leaves `default` and joins `miniapp-back`
  (`internal: true`), shared only with `nocheh-dashboard` (the owner's routes)
  and `nocheh-app`, and keeps `miniapp` for its tunnel. It can no longer reach the
  database, the machines or the Telegram bot. `nocheh-miniapp` now also waits for
  `nocheh-app` to start.

Routes, after `/api/member` on the page and `/v1/member-app` on the listener
(`src/member-app-wire.ts`):

| Route | Answer |
|---|---|
| GET `/me` | name, Tasks mode, `reminders` (`available`, or a `reason`: `read_only`, `reminders_off` or `private_chat_off`), boards (`projects`), groups with their Telegram title, board (`open`, `none`, `closed`), project and open count |
| GET `/tasks` | one page of one board, with the board's `statuses` (`id`, `name`, `state`) and shared columns other than person ones (`id`, `name`, `type`, and `options` for a select): `project`, and optionally `group`, `mine`, `state` (`open`, `done`), `trash`, `tag`, `cursor`; any other key, `person` included, or a repeated one is 400 `task_filter_not_allowed` |
| GET `/tasks/:id` | one task in the members' shape, 404 `task_not_found` for any task the member does not see |
| POST `/tasks` | add a task: `operation_id`, `project`, and the create fields |
| POST `/tasks/:id` | `operation_id`, `expected_version`, `patch` (finish is `{state:'done'}`, trash `{trashed:true}`, reminders the member's own list) |
| POST `/tasks/:id/comments` | `operation_id`, `text` |
| GET `/reminders` | the member's pending reminders on tasks they still see, soonest first |
| POST `/sign-out` | `{}` |

## An active member, checked on every call (D4)

The listener checks, in this order: no `Authorization`; the route; the body; the
launch (one hour, this bot, `chat_type` absent or `sender`); not the owner (403
`member_required`); then one query from the launching account: linked to an
active member, not the owner's account, with the owner's private chat known.
Anyone else, a stranger, a paused or removed member and an unlinked account
alike, gets one fixed 403 `member_app_closed` before any task is read. The
owner's 60 s session cache and the member directory's cache are never used.

- `members.app_since`, set when a member is added or un-paused (never on a plain
  permission change): a launch with `auth_date` more than 60 s before it is 401
  `member_app_launch_old`, so re-adding or un-pausing kills older launches.
- Groups come from `joinedGroups` (`src/stores/member-reads.ts`), now shared with
  the private chat's `memberReads`: groups the member's accounts are in now, in an
  active top-level group Nocheh serves, with their switch there not off; the
  owner's account never counts. The app reaches only those confirmed within
  `MEMBER_RECHECK_HOURS` (6). On `GET me` and before each task write it asks
  Telegram again about older ones as a private turn does
  (`recheckMemberAppGroups`, at most once per member every 10 minutes in a
  process). A group Telegram cannot confirm drops out of the app: unknown fails
  closed.
- Task writes need write (403 `task_read_only`), then pass the write limit in
  `member_app_limits`: at most 60 writes in 10 minutes and 500 in a UTC day per
  member, otherwise 429 `member_app_busy`. Only adds, changes and comments count.

## Boards shared with the private chat (D5)

`memberTaskViews(db, groups, topicMemory)` (`src/stores/member-task-views.ts`)
makes one board per active project assigned one of the member's groups, reaching
only those groups (with their topics when topics share their group's memory). The
member's private chat (ADR-0262 D14) and the app read through it, so the two
never drift apart; the private chat keeps its own 30-day groups and turn checks.

## The members' task shape, and names hidden from every project view (D6)

- `row(view)` now drops `people`, the owner's names for assignees, the values of
  person columns and `created_by_account` for every project view: a group or
  topic, a member's private chat, an "Answer privately" answer and the app.
  Assignees become `assignees` (`{name}` each) and `assignees_other`, resolved in
  one query per page (`assigneesSeen`): an assignee bound exactly or as confirmed
  in Memory › People to the source identity of a person's Telegram account whose
  membership is `in` in an active top-level group the view reaches, not switched
  off there, shows by that account's Telegram name (else its @username); every
  other one is counted. The owner's card for a change a project would see shows
  them as those chats would.
- `memberTask` and `memberDetail` name every field they emit, so a column added
  later is hidden by default. A task carries an opaque `version` instead of its
  revision: an HMAC of id and revision under the installation's random key, kept in
  `owner_task_version_key` in the control database, made the first time one is
  needed, read once per process, and never in any answer, export or log. A write sends `expected_version`; a version that is
  not the current one, or one of the 50 before it for a replayed write, answers
  409 `conflict`. `created_at` and "Made by" show only when the task was made on
  that board, otherwise `on_board_since`; `updated_at` and `done_at` are never
  earlier than when it joined. Reminders are the reader's own pending ones and a
  count of the others, never whose. `mine` is set when one of the member's accounts
  made the task, set a reminder on it or is bound to one of its assignees. Never shown: origin, the repeat's next
  task, outside ids, the source message, position, the revision, archived
  message attachments, or the owner's time zone.
- Comments and history start when the task joined the board, and history keeps
  only a fixed list of fields; a parent or the task it repeats is shown as
  changed, never which.
- The private chat's task lists and reads (D14) return the same shape.
- The page shows a task's status, its shared columns and their choices only by
  the names in that page's `statuses` and `columns`, never by an id; a value under
  any other key is not shown. New task and Edit offer those statuses and a field
  for each shared column, and send only what is set or changed. A task's
  assignees read "Sara, Omid and 2 other people", and nothing when it has none.

## Writes outside a turn (D7)

- `TaskRepository.memberList`, `memberGet`, `memberCreate`, `memberUpdate`,
  `memberComment` and `memberReminders` take the listener's `MemberAppPrincipal`
  and reuse `page`, `detail`, `insert`, `change` and `discuss`, without the turn
  checks. The client's `operation_id` is kept as a digest of the member and that
  id, so a retry replays.
- Writes are made with origin `'app'` (allowed in `owner_tasks`,
  `owner_task_comments` and `owner_task_activity`), the actor
  `{kind:'member', name}` with the Telegram name from the launch, and the setter
  `{by:'person', via:'app'}` with no chat or group, on one board and its reach,
  with no card.
- `owner_tasks.created_by_account` is set by every person's add, in groups too,
  and kept by a repeating task's next copy.
- A member never sets `people`, `assignees`, outside ids, `scope` (no move to
  another project), the position, a revision or an archived message (403
  `task_field_not_allowed`), and never removes a comment. A column the page does
  not show, a person column (shared or not) or a private one, answers 400
  `unknown_task_property`, the same as a name no column has, so guessing names
  tells nothing. A new task goes to a group in that board's reach, or to the
  whole project; with no group and no parent it goes to the member's first group
  there; a subtask goes where its parent is, so the page sends no group with a
  parent. A task in one of a group's topics shows under that group.

## Trash follows write; delete stays with the owner (D8)

With write, a member moves any task they see to the trash and restores it, other
people's included; a subtask they do not see stays where it is. The trash lists,
at its top, a subtask trashed on its own under a task that is not in the trash,
so it can be found and restored. Deleting for good has no member route.

## Reminders go to whoever set them (D9)

- `owner_task_reminders.set_via` (`chat` or `app`): a reminder set in the app is
  a person's with their account and no chat or group, so the member's private
  chat is never stored as a place. `owner_task_writers.via` likewise, with chat
  and group null for the app. The owner's lines say "set by … in the members’
  app" (`place_app` in `tasks.reminder_texts`).
- `members.reminders`, "Reminders to themselves", on by default, nested under
  Tasks read and write. Off, a person's new reminder answers 403
  `task_reminders_off`, in groups and the app; they can still remove their own.
- The app sets a reminder only with write, "Reminders to themselves" on and an
  open private chat; otherwise a new time answers 403 `task_reminders_off` or 409
  `member_reminders_unavailable`, and the page hides "Remind me" with the reason.
  Each time carries its offset, so the owner's time zone never changes what the
  member meant. The limit stays 10 per person per task. A member removes their
  own whenever they have write, in the drawer and in Settings, even while new
  ones cannot reach them.
- A reminder is the member's own, in the app, when any of their accounts set it,
  in the app or in a group: they see it, change it and remove it, and their list
  matches only their own, so another's reminder at the same minute never stands
  in for theirs. Settings lists those on tasks not in the trash.
- A reminder set in the app is private: no chat sees it (row() leaves it out of
  every project view; the app and D14 count it among the others), and a list
  saved from a chat, the owner's in a group included, neither removes it nor
  matches it by the minute. Only the owner's dashboard and private chat list it.
- Delivery (`src/stores/task-reminder-delivery.ts`): when a person's reminder is
  due, its recipient is resolved from the store as it is then: the setter's
  account, its active member with "Reminders to themselves" on, that account's
  open private chat with Nocheh (private chat on, not a topic, not the owner's),
  and the task still on one of that member's boards. As in the app, the member's
  groups are first asked of Telegram again (`recheckMemberAppGroups`, at most
  once per member every 10 minutes, at most 10 groups), and only groups confirmed
  within 6 hours count; a re-check that fails reaches no board. Then it goes to
  that chat, one message per reminder at its time, with no 10-minute merge, after core's
  one-time yes (D10). Otherwise one set in a group goes to the owner, merged per
  group as before (ADR-0255), and one set in the app is skipped, with one System ›
  Health line per member per UTC day, in the owner's words ("2 reminders “Mira”
  set in the members’ app were not sent: their private chat with Nocheh is
  off."). A guest who is not a member keeps the owner lane.
- The member's message is `members.reminder` (`⏰ {title}\n📅 {due}\n📁
  {list}\n\n{notes}`) and the `set_by` line of `members.reminder_texts` ("👤 Set by
  you"), both editable owner texts. `{due}` is in the one task time zone and
  `{list}` is the project's name. No line names who else wrote or closed the task,
  or where, because the writer records are neither cut at the board's joining
  time nor filtered by reach.

## The bot sends to a member's chat only after core's yes (D10)

- `POST /internal/notices/authorize {id, chat, text_digest}` on `nocheh-app`,
  with the service token. Core answers `{allowed:true}` only when the reminder is
  a person's, being sent in the member lane, its stored `notice_digest` is the
  SHA-256 of that exact text, its `deliver_chat` is still the open private chat of
  the account that set it (an active member with private chat and reminders on)
  and that chat is, in Telegram, the chat asked about, with no topic. The yes
  clears the digest in the same statement, so it is given once. Anything else,
  a malformed body included, is `{allowed:false}`.
- `send_notice` in `nocheh-telegram` still sends to the owner's private chat as
  before. For any other chat it needs `send_class` `reminder`, no topic, buttons
  or edit (refused at once), then, after its receipts, a chat the served list
  marks as a member's own open private chat and core's yes: a resend of one that
  went is answered from the receipt even when that chat has closed since. It
  keeps an `.asked` mark before it asks core; a no after an earlier ask whose
  answer never came may be that spent yes, so nothing is sent and the answer is
  `ambiguous` (the reminder is unclear), never a refusal. It still passes
  `outbound_check`.

## One menu button for every private chat (D11)

Settings Apply (`tools/operations/installation/mini_app.py`) first sets the
default menu button for every private chat with the bot to the members' page
(`<address>/m/`, labelled with the first of the bot's names), then the owner's own
chat's button to the owner's page (`/`). Both are made from `NOCHEH_MINI_APP_URL`
alone; with the mini app off, both go back to Telegram's default button. After
the owner changes, Apply also sets the former owner's chat back to the default
button, so as a member they reach the members' page. Strangers, guests and paused
or removed members see the button too and get the closed page.

## English only; one time zone (D12)

The page is in English only (Q2). Its words live in one English dictionary,
`dashboard/member/i18n.ts`; the page is `lang="en"` and left to right, reads no
`language_code`, and there is no language choice, no `POST /prefs` and no stored
language. Times on the page are in the phone's own time zone; reminder messages
use the one task time zone.

## Sign out (D13)

`POST /sign-out` stores in `member_app_prefs.signed_out_auth_date` (the later
one wins) the launch's own `auth_date`, or now less the minute of slack that
covers Telegram's clock (`MEMBER_APP_SINCE_SLACK_SECONDS`) when that is later; every
later call with `auth_date` at or before it is 401 `member_app_signed_out`, on
every phone. So a launch another phone opened after the signing one, more than a
minute before the tap, ends too. The page clears its own keys and closes.

## Owner side, texts and storage

- The Members page reads "Read and write (or Read only), in groups and the
  members’ app: the tasks of the groups they joined", has **Reminders to
  themselves** nested under Tasks (disabled while Tasks is read only, its value
  kept), and a footnote: "Members open the app from the menu button in their
  private chat with Nocheh." `POST /v1/members/:id` takes `changes.reminders`, and
  `GET /v1/members` returns `permissions.reminders`.
- Settings › Telegram › Mini app shows both addresses and says "Every private
  chat with Nocheh gets the menu button. Only active members can open the app.
  Others see a closed page."
- Tasks show origin `app` as "Members’ app", and comments and history as "in the
  members’ app". The drawer's reminder hint says one a member set there goes to
  their own private chat. System › Sent to apps shows a skipped app reminder's
  line under `reminder_skipped`.
- New editable texts in Settings › Assistant: **Task reminder to a member**
  (`members.reminder`) and **Reminder lines to a member**
  (`members.reminder_texts`), and the `place_app` line of `tasks.reminder_texts`.
- Storage, all added if missing: `members.reminders`, `members.app_since`,
  `member_app_prefs`, `member_app_limits` (both cascade with the member),
  `owner_tasks.created_by_account`, `owner_task_reminders.set_via`,
  `deliver_chat` and `notice_digest`, `owner_task_writers.via`, and origin
  `'app'` in three checks. Reset snapshots (v3) carry `members.reminders`, not
  `app_since`, which a restore sets to now; the two member app tables stay out of
  the snapshot. The portable export carries the new task, reminder and writer
  columns with their rows, and an import clears `deliver_chat` and
  `notice_digest`.
- The tool description says each reminder goes to whoever set it, that project
  chats never read people, the owner's names for people or person columns, that
  they see an assignee only by their Telegram name with the rest counted in
  `assignees_other`, and what a member's private chat sees.

## Alongside ADR-0263 and ADR-0264

- [ADR-0264](0264-groups-are-read-whole-from-everyone.md) reads a group whole
  from everyone, members or not, and lets only members interact with the agent.
  Nothing here changes with it: the members' app shows tasks only, never a
  group's messages, files or transcripts, and a member's private chat reads its
  groups' history as ADR-0262 says. An assignee shows by Telegram name when their
  account is in a group the view reaches, whether or not they are a member, as
  that group reads everyone's messages too; a member switched off in that group
  is counted.
- [ADR-0263](0263-only-addresses-no-model-built-open-without-a-card.md) decides
  which web addresses and outside tools open without a card. The members' app
  opens no address and calls no tool, and a reminder to a member is a notice,
  never a tool call, so no address check or rule applies to either. A member's
  private turn still has no effect, and members' group web reads stay as
  ADR-0260 says.

## Named replacements

- **ADR-0162**, "The service opens a dashboard session for itself": no longer
  holds. Since ADR-0189 and ADR-0190 each owner call carries the phone's own
  session token, and the members' calls carry none and go to `nocheh-app`, not the
  dashboard.
- **ADR-0189**: the lock lives in `admin/owner-lock.json` (not
  `admin/mini-app/lock.json`), and the dashboard, not the mini app service,
  remembers a signed-in answer, for 60 s (not 30 s); a sign-out or a new password
  forgets it at once. The members' page has no password.
- **ADR-0255**: a person's reminder no longer always goes to the owner. It goes
  to whoever set it, as D9 says; only reminders routed to the owner are merged per
  group.
- **ADR-0254 and ADR-0262**: a member's private chat is still a destination only
  behind the owner's card, except for one send: a task reminder to the member who
  set it needs no card, only core's one-time yes (D10).
- **ADR-0238**: the default menu button is set on Apply with the owner's, from the
  dashboard container, and is not recorded either, until the call moves into
  `nocheh-telegram`.
- **ADR-0248**: a project's chats no longer read who a task is about, the
  owner's names for assignees or person columns, and see an assignee only by
  their Telegram name, the rest counted (Q4). Groups can still set people by
  name.

</decision>

<alternatives>
- **A session token after the first launch.** One more bearer secret to store,
  revoke and expire; the launch data already names the member and is checked
  on every call. Cost: an app open for over an hour must be reopened.
- **A credential for `nocheh-miniapp`.** It would be the first secret in a
  public, read-only container; the signed launch data is enough, checked again
  by `nocheh-app`.
- **A second address or tunnel for members.** Stronger against a script on one
  page reading the other's storage, but the design has one mini app address;
  Trusted Types, separate keys and no raw HTML stand in.
- **Per-member menu buttons (cut C1).** They need a table, a reconcile worker,
  a throttle, a gateway op and a trigger when a private chat appears; the server
  check is the real gate and the button is cosmetic.
- **A per-member time zone (cut C2).** The design keeps one time zone for
  reminder messages; the page shows times in the phone's zone.
- **A signed send pass for the bot.** The service token is shared by many
  services, so a self-contained pass could be forged; core's per-send yes adds no
  secret.
- **Writer and closer lines filtered by reach in a member's reminder.** Dropping
  them is simpler and cannot leak.
- **Making a board read-only when the member's group talk is off.** The owner
  made Tasks one row for groups and the app; a group switch already removes its
  board.
</alternatives>

<consequences>
- A member opens a small app from their private chat's menu button and works on
  the tasks of the projects whose groups they joined, and only those, with no
  password. Bob, in GP1 and GP3 of P1, sees GP1's, GP3's and P1's own tasks, never
  GP2's.
- A pause, a removal, sign out, a re-add or an un-pause closes the app on the next
  call; a group Telegram cannot confirm within 6 hours drops out.
- Members' reminders leave the owner's chat and go to the members themselves.
  Group answers name an assignee only by their Telegram name while they are in
  that group, and never people or the owner's names for them. The owner will
  notice both.
- Cuts, each for later: the Chat tab; deleting a member's private chat (needs a
  delete path); permanent delete for members; assigning people or setting person
  columns from the app; moving a task to another
  project; file and message attachments (links only); telling members about
  comments or changes on their tasks; telling a member when the owner removes
  their reminder; a per-member time zone (C2); per-member menu buttons and a
  "button set" status (C1); a read-only board when group talk is off; offline use
  and push.
- Risks:
  - The launch data is a bearer credential for up to an hour. It is never
    logged, answers are `no-store`, the page strips the hash, and sign out,
    re-adding and un-pausing kill it.
  - Both pages share one origin: a script injected into `/m/` could read the
    owner's phone token if the owner used `/` on the same phone. Trusted Types,
    no raw HTML, separate keys and the owner refused on `/m/` stand in for a
    separate hostname.
  - Port 8780 stays reachable from the edge on `miniapp-back`, since Docker
    cannot limit ports per network; every route there needs a token the edge
    does not hold.
  - The network move: if the dashboard were not on `miniapp-back` the owner's
    path would break (the tester's `owner_mini_app_still_works` checks it). Each
    installation has one more Docker network.
  - The fixture key seam is guarded by the flag, the bot id, a refusal to start,
    never being in Compose, and unit tests.
  - Strangers see a menu button that leads to the closed page, and paused or
    removed members keep one. The server refuses them.
  - The group check depends on Telegram: while it is unreachable, groups drop out
    of the app until confirmed.
  - Groups can still set people by name, and a group's `person` filter can still
    probe the owner's names for people; that is a separate follow-up.
  - A launch names one Telegram account: groups come from all the member's
    accounts, and a reminder goes to the setter account's own private chat.
  - Delivery to a member asks Telegram again about their groups, as the app
    does (at most once per member every 10 minutes), and needs them confirmed
    within the app's 6 hours. While Telegram is unreachable, a reminder set in
    the app is skipped with a Health line and one set in a group goes to the
    owner.
  - An assignee the owner has not bound to a Telegram account in Memory › People
    is only ever counted.
  - The new columns and rewritten checks need care in reset, restore, the Python
    reset twin and the export.
</consequences>
