# ADR-0247: A group sees only its own tasks and its project's tasks

<status>
Accepted on 2026-11-13, in "Members step 2: projects and the private button",
after the owner approved the Members design ("I just review the tables and
seems what I want if there is a important point or need my answer ask, else
start build.") and asked: "task access and edit should behave like data access
for project and groups. user Bob can manage(crud) other tasks that are for
project1 or all joined groups." Supersedes three claims of
[ADR-0164](0164-task-lists-links-and-tags.md): that group and people links are
labels that never widen who can read a task, which only its scope decides; that
a task added from a group's chat points to that group unless it names another;
and that a live turn in a project's chat reaches that project's list. Refines
[ADR-0243](0243-project-boards-get-the-private-side-only-through-a-card.md):
what `project_since` records, which chats see a task, and when a card says that
chats added later will see it. Both stay as they were accepted.
</status>

<context>
- Under ADR-0243 every group and topic of a project saw every task on the
  project's list. A task one group added, with its title, notes and comments
  from when it joined, was seen by every other group of the project, and was
  counted and tagged there.
- In the Members design a project holds groups, and data access follows them:
  an answer in a group uses only that group's knowledge and what the project
  shares. The owner's rule for tasks is the same: a person manages the tasks
  of the project itself and of the groups they are in, and no other group's.
- A group's topics either share what they know (`topic_memory` `group`) or
  keep it apart (`topic`). A turn's read set
  ([`readSetOf`](../../src/spaces.ts)) already says which groups and topics it
  reads.
- An "Answer privately" reply (ADR-0248) answers in the asker's private chat
  from the group it was asked in and the project's other groups the asker is
  in, frozen when the button is tapped. It is not a turn in any of those
  groups, and nothing in it should change their tasks.
</context>

<decision>
- A task on a project's list is set on the project itself (`group_id` null)
  or belongs to one group or topic of it. The owner sees every task. A group
  or topic turn reaches, on its project's list only, the tasks set on the
  project itself and the tasks of the groups and topics in its read set: the
  whole group with its topics when topics share what they know, else only its
  own chat or topic. Another group's task is not found (`task_not_found`) by
  get, change, comment or parent, is left out of lists, counts, open counts,
  tags, filters, links, blockers and subtask counts, and is never named. A
  group or topic shown on a task or in its history shows only when the turn
  reaches it, else as none. A task's parent shows only when the turn sees
  that parent; otherwise the task shows with none, at the top of the list,
  and no list by that parent finds it. A turn is never given a task's manual
  position, which counts the tasks of every group of the list. A chat that is
  not clearly a group or topic reaches nothing
  ([ADR-0242](0242-private-chats-stay-out-of-group-sharing.md)).
- A task added in a group or topic belongs to that chat. It is set on the
  project itself only when the request says so (`group: null`); a parent
  given as null or empty, or an empty group, names nothing and leaves the
  task the chat's own. Naming a group or topic the turn does not reach is
  refused with `task_group_denied`.
- A subtask has its parent's list and group. Naming another group for it is
  refused with `task_parent_other_group`, and a change to a task's list or
  group moves every task under it with it.
- `owner_tasks.project_since` records when a task joined the chats that now
  see it: it is set when the task joins a list and again when its group
  changes, for the task and every task under it, under the same lock and
  clock as a move (ADR-0243). The history entry of a group change, like that
  of a move, shows only where the task went. So a group that takes a task, or
  a project whose chats get a group's task, sees nothing from before.
- An "Answer privately" reply reads tasks with the read set and project bound
  on the server from its record (`Reader.reads`), never from its pass: the
  tasks of those groups and topics and the project's own. It changes nothing:
  adding, changing or commenting is refused with `task_read_only`. Without a
  bound record in an active project it reads no list
  (`task_project_required`).
- The chats that see a task are worked out per task. A task set on the
  project itself is seen by every group assigned to the project and by chats
  added to it later. A group's task is seen only while its group is in the
  project, as a topic always follows its group's project
  ([ADR-0246](0246-projects-replace-the-share-box.md)): when topics share
  what they know, by the group's chat and all its topics, named as the group;
  else only by the task's own chat or topic.
- The owner's card (ADR-0243) names those chats. Only a task set on the
  project itself says that chats added later will see it (`task_later`); a
  group's task says that other groups of the project don't see it
  (`task_group_only`) or, when its group is not in the project, that the
  group will see it once it is added (`task_group_later`). A group change on a
  listed task is a move with its own card lines (`task_move_group`,
  `task_move_group_family`), and setting a group's task on the project it is
  already in says that every group of the project gets it
  (`task_move_project`, `task_move_project_family`). `owner_task_requests`
  keeps the group, the request fingerprint covers it, and approving changes
  nothing unless the list, the group and the chats that see the task are as
  the card showed.
- `GET /v1/tasks/<id>/audience?scope=&group=` (and the mini app's
  `/tasks/<id>/audience`) returns the project, group, kind (`project` or
  `group`) and chats that would see a task after a move, as the card works
  them out. Before it saves a move into a project's list or a group change on
  a listed task, the dashboard and the mini app name those chats. A
  subtask's group cannot be chosen there; it says that it follows its parent
  task.
- A group's tasks move with it. `moveGroupTasks(db, group, from, to)` in
  [`src/stores/tasks.ts`](../../src/stores/tasks.ts) moves, in the caller's
  transaction, every task of the group and its topics on the `from` list that
  is not under another task, with every task under it, to the `to` list. They
  keep `project_since`, as the same chats keep seeing them; a task under them
  set on the project itself joins their group and gets a new one. A task of
  another group under them, written before subtasks followed their parent's
  group, stays on the `from` list at the top, with every task under it, so
  only its own group keeps seeing it; its history says only that it no longer
  sits under a task. A task of the group under a task of another group or of
  the project itself stays with its parent. Each gets a history entry. A move
  to no project, or from none, moves nothing: the group's tasks stay on the
  old list, where only the owner sees them. The project's own tasks always
  stay on its list. The project assignment write (`writeAssignment` in
  [`src/stores/projects.ts`](../../src/stores/projects.ts)) calls it in its
  transaction when a group changes from one project to another.
- The chat task tool and the group prompt say that a group or topic reaches
  only its own tasks and the project's, and that a task added there belongs to
  it.
</decision>

<consequences>
- Tasks that groups added before this decision carry their group and are now
  seen only by it. A task the owner pointed to a group not in its project is
  seen by no chat until that group joins it or the owner sets the task on the
  project itself.
- A group that takes a task set on the project itself, or the project that
  gets a group's task, loses sight of its earlier comments and history.
- The chats named for a task set on the project itself are still the
  project's assigned groups, as in ADR-0243.
- A task under a task of another group, written before this decision, keeps
  its group until its family's group or list changes. Its own group sees it
  with no parent; when its parent's group moves to another project it stays
  behind, no longer under that task.
- Checks: who reaches which task in groups and topics under both topic
  memories, counts, tags, links, parents and manual positions, a parent
  another group's task sits under, the group of a new task, also with an
  empty parent or group, and of a subtask, read-only private answers, the
  audience of a task, a group change as an arrival and its race with a
  comment, the card for a group's task, for a group change and for setting
  it on its project itself, and a group's tasks moving with it, without
  another group's task under them
  ([check](../../test/store-tasks.test.ts)); the card lines
  ([check](../../test/prompts.test.ts)); the audience route
  ([check](../../test/mini-app.test.ts),
  [check](../../test/fixtures/owner-storage-paths.json)); the dashboard's
  move and group confirms and the subtask's group
  ([check](../../test/dashboard-pages.browser.mjs)).
</consequences>
