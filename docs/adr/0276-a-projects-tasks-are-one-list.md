# ADR-0276: A project's tasks are one list

<status>
Accepted on 2026-11-22. The owner chose, on a decision card, that every chat of an active
project sees and changes all of the project's tasks, whatever its "Share group chats" switch:
"Yes, always (like connectors)". The owner also accepted that people in the project's groups
who are not members can then see every task of the project. Supersedes
[ADR-0248](0248-tasks-follow-data-access.md) (a group sees only its own tasks and its
project's tasks). Amends [ADR-0247](0247-projects-replace-the-share-box.md) (what a group
joining a project will see of its tasks, and `task_projects`),
[ADR-0249](0249-answer-privately.md) (the tasks an "Answer privately" answer reads),
[ADR-0262](0262-member-private-chat.md) D14 (a member's private chat reads only their groups'
tasks), [ADR-0265](0265-member-mini-app.md) D5, D7, D9 and Q4 (the app's boards, where a new
task goes, which reminders reach a member, and whose assignee names a view shows),
[ADR-0267](0267-share-group-chats.md) (tasks no longer follow the switch, and its first known
gap closes) and [ADR-0274](0274-people-names-everywhere-and-private-notes.md) (the members'
app assignee rule). Keeps [ADR-0243](0243-project-boards-get-the-private-side-only-through-a-card.md)
(a project's board view and the owner's card) and
[ADR-0242](0242-private-chats-stay-out-of-group-sharing.md). An earlier draft under this
number, in which the members' app showed a sharing project's other groups' tasks read only,
was never accepted and is replaced by this one.
</status>

## Context

Under ADR-0248 a task's group decided who saw it: a group saw its own tasks and the tasks set
on the project itself, and never another group's. ADR-0267 then let a project's groups read
each other while "Share group chats" is on, and tasks followed that switch for groups and a
member's private chat, but not for the members' app or reminder delivery. The same member saw
a task in one place and not in another, and the draft that tried to close that gap added a
read-only kind of task to the app.

The owner wants a project's tasks to work like its connections
([ADR-0268](0268-notion-per-project-or-person.md), [ADR-0269](0269-github-per-project.md)):
they belong to the project, and every chat of the project uses them. A group in a project is
then a place to work on the project's list, and a task's group only says where it came from or
whom it is about.

## Decision

1. **One list per project.** Every chat of an active project sees and changes the project's
   whole list, whatever each task's group and whatever the project's "Share group chats" switch:
   each group and topic assigned to it (with topics keeping their own memory too), and the owner.
   A project's chat sees a task only on its own project's list (`sees` and `seesSql` in
   [`src/stores/tasks.ts`](../../src/stores/tasks.ts) test the project alone), still only as it
   is on that project's board (ADR-0243): no task of another list, no personal task, no other
   project's name, and no manual position. A group in no project, and a project that is not
   active, still have no list in any chat. Personal tasks stay the owner's.
2. **A task's group is a label.** `owner_tasks.group_id` is kept as a label and a filter:
   - A group or topic shown on a task or in its history shows to a project's chat only when it is
     a group, or a topic of a group, assigned to the project now (`seesGroup`); otherwise it
     shows as none. The owner sees it as stored. So a group that left the project, another
     project's group, or anything that is not clearly a group or topic, never shows.
   - A task added in a group or topic is labelled with it, unless it names another group or
     topic of the project, the project itself (`group: null`) or a parent, whose group a subtask
     takes unless it names one. A task may have another group than its parent:
     `task_parent_other_group` is gone.
   - A group label must be a group or a topic: anything else, such as a private chat, is
     refused with 400 `invalid_task_group` for every writer, the owner included. From a
     project's chat, the members' app included, a group must be one of the project's now, else
     403 `task_group_denied`.
   - A list filtered by a group finds the tasks labelled with that group or one of its topics,
     and a project's chat filters only by a group of its project.
3. **Only a list change is a move.** A task joins a project's chats when it joins the project's
   list, and only then is `project_since` set (ADR-0243). A group change is a change in place:
   it keeps the joining time, and its history entry shows its sides through the label rule
   above. From the owner's private chat a label-only change is made at once, with no card, like
   status or priority.
4. **The owner's card names every chat of the project.** For a task on a project's list the
   card names every group and topic of the project and says that chats added later see it too
   (`task_later`). `audienceOf` is always the project's chats, the audience route
   (`GET /v1/tasks/<id>/audience`, and the mini app's) always returns `audience: 'project'`
   (null for a personal task) with `group` as the label, and the card's kinds are add, move,
   move with the tasks under it, change and comment. The lines `task_group_only`,
   `task_group_later`, `task_move_group`, `task_move_group_family`, `task_move_project` and
   `task_move_project_family` are no longer used: a stored text under those names is read and
   never shown.
5. **Tasks stay when a group moves.** `moveGroupTasks` is gone. When a group moves to another
   project or leaves every project, its tasks and its topics' tasks stay on the old project's
   list, where that project's chats keep seeing them, as the project's connections stay with it.
   Their group label then points outside the project and shows as none to its chats. The group
   sees the new project's list instead. The owner's review and a project's "Add a chat" say a
   chat will see and change a project's list whenever that project has any task
   (`task_projects` no longer asks `group_id IS NULL`).
6. **Members.** A member's boards come from the groups they joined and Telegram confirmed
   lately (`memberTaskViews`): one board per active project that holds one of them, each the
   project's whole list, with `home` the member's first own group there.
   - The members' app reads and, with Tasks read and write, changes every task of each board.
     The read-only marks and refusals of the draft (`read_only`, `task_shared_read_only`,
     `TaskView.writes`) do not exist. A plain add is labelled with `home`. `GET /me` lists each
     board's groups by Telegram title (`MemberMe.projects[].groups`, every group assigned to the
     project now), which the page uses for task labels, the group filter and a task's group; the
     member's own `groups` stay the groups they are in.
   - A member's private chat stays read only: it lists and reads each board's whole list, one
     project at a time, and changes nothing. An "Answer privately" answer reads the whole list
     of the project bound for it and changes nothing (`task_read_only`).
   - A reminder a member set reaches their own private chat, under the other conditions of
     ADR-0265 D9, while the task's project is one they have a board of, whatever its group
     (`onBoards` in
     [`src/stores/task-reminder-delivery.ts`](../../src/stores/task-reminder-delivery.ts)).
   - `withSharedGroups` is no longer used by any task path. It stays only for what a member's
     private chat reads of the groups' messages and memory (`bindReads`).
7. **Assignee names follow the project's groups.** A project's chat, a member's private chat,
   an "Answer privately" answer and the members' app name an assignee only when the owner linked
   them in Memory › People to a Telegram account that is in one of the project's groups now
   (`assigneesSeen`); every other assignee is counted, as before.
8. **What a group learns while sharing is off.** A group still does not share what it knows
   with the project's other groups while the switch is off. So a group or topic turn's task
   answer (a list, a read, or a change) that shows a task labelled with a group or topic outside
   what that chat shares what it knows with (its parent, subtasks and linked tasks too) carries
   `other_groups: true`, kept on a result cut to fit (`TaskRepository.marked`). A task with no
   group label never marks. Hermes counts such a read as a read of other chats' words
   (`services/hermes/note_sources.py`), so a native note written after it is labelled that way
   ([ADR-0257](0257-learned-memory-names-its-source.md)), and the tool text and the group prompt
   say never to write those tasks into the chat's notes. With sharing on nothing changes: the
   group reads those groups anyway.
9. **Texts.** The chat task tool, the group prompt, the dashboard's join, move and leave notes
   and the members' app say that a project's tasks are one list for all its chats, whatever "Share
   group chats" says, and that a group is only a label.

## Consequences

- Everyone in any of a project's groups, members or not, can see every task of the project
  through Nocheh's answers there: titles, notes, comments from when a task joined the list,
  labels, and who made or finished it on the list. The owner accepted this. The project's
  "Share group chats" switch no longer changes what any chat sees of tasks.
- A task on a project's list whose group is not one of the project's, such as one left behind
  by a group that moved, or one the owner labelled with another project's group, is now seen by
  every chat of the project, with no label.
- Comments and history written before an earlier group change stay hidden from the project's
  chats, since `project_since` was reset then. That is the cautious default; nothing is
  backfilled.
- Making an archived project active again shows all its tasks, whatever their group, to all its
  chats at once.
- A pending owner card for a group's task, stored before this change, names fewer chats than
  the project has, so pressing Approve answers 409 `task_request_changed` and changes nothing.
  Nocheh is in development mode, so no compatibility code is added.
- A member who left every group of a project loses that project's board; their reminders on its
  tasks then go to the owner (set in a group) or are skipped (set in the app), as before.
- Connections and tasks reach different chats: a project's Notion and GitHub work in its groups
  and topics and the owner's private chat, but not in a member's private chat (ADR-0268's known
  gap), while a project's tasks reach a member's private chat, read only, and the members' app.
- Checks: `test/store-tasks.test.ts` (every chat of a project sees and changes every task,
  labels outside the project hidden, a private chat refused as a group, a label-only change
  from the owner's private chat with no card, a pending card stored with fewer chats answering
  `task_request_changed`, a group's move leaving its tasks behind),
  `test/store-member-app.test.ts`, `test/store-member-app-server.test.ts`,
  `test/store-member-reminders.test.ts`, `test/store-member-reads.test.ts`,
  `test/store-private-answers.test.ts`, `test/store-knowledge-management.test.ts`,
  `test/member-app-contract.test.ts`, the dashboard browser test, and the full tester's
  `project_groups_stay_apart`, `member_private_chat_reads_joined_groups`, `member_app_tasks`
  and `member_app_drops_a_left_group`.
</content>
</invoke>
