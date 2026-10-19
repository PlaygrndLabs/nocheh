# ADR-0163: Task scopes and domains

<status>
Accepted on 2026-10-19. The owner asked that tasks be flagged by scope and
domain, that life and personal tasks be separate from projects, and that each
project have its own private scope and list. The owner chose that a
project's chats can use that project's list. This extends ADR-0160, whose
assistant access was owner-private only.
</status>

<context>
ADR-0160 kept one list that only the owner's private chat and the dashboard
could reach. Projects already group chats and topics, and group memory
already stays inside its own audience.
</context>

<decision>
- A task's scope is personal, or one project from the control store's
  `projects`; each scope is its own list. A domain is a short label of up to
  40 characters. A new task is personal unless it is given a project.
- The owner's private chat, the dashboard and the mini app reach every list,
  list them with their open counts, and can move a task between lists. A task
  can be added to or moved into an active project only.
- A live turn in a chat whose effective project is active reaches that
  project's list only. The scope is fixed to that project, a task in another
  list answers as not found, and only that project is named in the result. A
  chat with no project reaches no list. Jobs and review runs reach none.
- Allowed people in that chat use the list as the owner does there, because
  it holds nothing from outside the project.
</decision>

<consequences>
- Sharing one project's list into another project is not possible.
- A project that is archived keeps its tasks readable, but no new task joins it.
</consequences>
