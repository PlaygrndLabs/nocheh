# ADR-0243: Project boards get the private side only through a card

<status>
Accepted on 2026-11-12, in "Members step 1: keep the owner's private side out
of groups", after the owner reviewed the plan and asked: "task access and edit
should behave like data access for project and groups." Supersedes the claim of
[ADR-0164](0164-task-lists-links-and-tags.md) that allowed people in a
project's chat use the list as the owner does there "because it holds nothing
from outside the project". Refines [ADR-0167](0167-tasks-like-a-notion-table.md).
Both stay as they were accepted.
</status>

<context>
- A project's list can hold what only the owner should see. A personal task
  moved into it kept its earlier comments and history, its archived messages
  and their labels, its IDs in outside tools and every owner column. A task
  added from the owner's private chat could carry text the owner wrote with all
  of their memory in view.
- A project's chat read and changed the list through the same rows as the
  owner. An edit there that sent a task's attachments or columns back without
  the hidden parts would have removed them.
- The owner's rule for the Members work is that nothing crosses from the
  private side into a group without a card in the private chat that names who
  will see it, and that anything not clearly a group or topic counts as
  private.
</context>

<decision>
- `owner_tasks.project_since` records when a task joined its current project's
  list. It is set when the task is added to a list, moved into one (with its
  subtasks), or repeated, and cleared when it leaves every list. A move locks
  the task and every task under it before it reads the joining time from the
  clock, and records the move at that time, so nothing written to any of them
  before the move counts as written on the new list. A task on a list with no
  `project_since` shows a project's chats no comments or history; its next
  change or comment gives it one, so a task listed before the column existed
  keeps its past private and shows what is written from then on.
- A project's chat sees the board view of a task: comments counted and listed
  only from `project_since`, history only from then (the joining entry shows
  only the list it went to), links but no archived messages, only reminders
  still to come, blockers only on the same list, a parent only on the same
  list, no `external` IDs, no source message, and only the columns marked
  shared. Its `group_id` shows only when it is one of the chats that see the
  list or a topic of one, and that chat finds tasks by no other group;
  `created_by` and `finished_by` show only when the task was made or finished
  on the list. Task settings in that chat list only the shared columns.
- Each owner column has `shared`, false unless the owner ticks "Project chats
  can see this column" in Settings › Tasks. Settings saved before the flag read
  as not shared; a value that is not true or false is refused.
- A write from a project's chat never removes hidden parts: an unshared column
  is an unknown column there, new attachments keep the task's archived
  messages and replace only the links, and new `blocked_by`, `related` or
  `duplicate_of` links replace only the links to tasks on that list. A task
  holds up to 20 archived messages and up to 20 links, counted apart, so how
  many links the chat may set never depends on what the owner attached.
- The chats that see a project's list are its assigned chats whose ID is a
  group (a negative Telegram ID) or one of its topics. Anything else counts as
  private and is never named or shown the list.
- From the owner's private chat, the task tool holds a change that the
  project's chats would see and offers a new approval card kind, `task`:
  adding a task to a project's list, moving one into a list, commenting on a
  listed task, or a change to a listed task that sets anything beyond status,
  state, priority, start and due days and times, archive, trash and its list.
  Group, repeat and reminders are held too. A change that only sets the listed
  fields, or that takes the task out of every list, applies directly. This is
  the plan's recommended default for this step, pending the owner's
  confirmation.
- Holding runs the change in a transaction that is rolled back, so it is
  checked exactly as the real change and its board view can be shown. The
  request is kept in `owner_task_requests` with an ID from its operation, the
  project, the chats, the board view, a digest of which tasks move in under a
  moved task and at what revision, the revision of a commented task, and a
  fingerprint of all of them, so a repeated ask returns the same request.
- The card, in the owner's private chat as a reply to the ask, names the
  project and each chat with its topic, says when no chat sees the list yet and
  that chats added later will, says what stays private, and shows each changed
  field exactly. A move shows every task under the task too, archived and in
  the trash as well, each with what the chats will see of it, and says how
  many move with it. Its layout is the owner-editable "Approval card for a
  project’s task" text; its outcome lines are in the approval texts. A card longer than a Telegram
  message, or with too many links, is not sent: the request is refused with
  `task_card_too_long`, and the change is made from the dashboard.
- Only the owner's press decides the card. Approve makes the change again with
  the card's project and chats; if the task (its revision), the tasks under a
  moved task (which, and their revisions), its list or those chats changed
  since the card, nothing changes and the card says so. Reject changes
  nothing. A request is decided once.
- Moving a task into a project's list from the dashboard or the mini app asks
  first, naming the chats that will see it, how many tasks under it move with
  it (archived and in the trash too) and what stays private. The owner's task
  scopes carry each project's `chats`, and the owner's task detail carries
  `descendants`, for this. Ticking "Project chats can see this column" asks
  first too, naming each project's chats and saying that the values already in
  the column show there.
</decision>

<consequences>
- Project chats lose sight of every owner column until the owner shares it,
  and of the comments and history of tasks that joined their list before
  `project_since` existed.
- Task cards are not listed in the dashboard Inbox or by the approvals
  command yet; they are decided from Telegram.
- A card that could not be posted leaves its request proposed; asking again
  returns it.
- A change to which columns are shared after a card is shown is not part of
  its fingerprint.
- Checks: the board view, shared columns, hidden-part keeping, the move that
  races a comment and the card flow, with the tasks under a moved task
  ([check](../../test/store-tasks.test.ts)), the column flag
  ([check](../../test/task-settings.test.ts)), the card text
  ([check](../../test/prompts.test.ts)) and the dashboard move and column
  confirms ([check](../../test/dashboard-pages.browser.mjs)).
</consequences>
