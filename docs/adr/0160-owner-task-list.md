# ADR-0160: The owner's own task list

<status>
Accepted on 2026-10-19. The owner asked for a Telegram mini app to manage
Nocheh and for Nocheh's own local task manager, shown in that mini app too,
with Notion through MCP as an additional, optional option. The task list is
the first step; the mini app and Notion follow.
</status>

<context>
Nocheh had no place for things the owner has to do. Learning can trace the
state of tasks mentioned in chats, but that is interpreted memory, not a list
the owner edits. A list kept only in Notion would make an outside service the
source of truth for owned data.
</context>

<decision>
- Tasks live in the control store in `owner_tasks`: title, notes, state (open,
  done or dropped), an optional due calendar day, where they were added and,
  for a chat task, the message that asked for it. Every change carries an
  operation ID and the expected revision, like other owner changes.
- The dashboard edits the list through `/api/nocheh/tasks` as the owner. The
  page is Tasks, after Inbox.
- The assistant reaches the list with one tool, `nocheh_tasks`, over fixed
  `/v1/owner/tasks` routes. Storage proves a current live owner-private turn
  on every call, as it does for the owner's directory reads; a group turn,
  a scheduled job or a review run cannot read or change tasks, even when the
  owner wrote in the group. Reads are recorded as `memory.read` effects and
  changes as `memory.write`.
- A repeated add or change from one turn returns the task it already made,
  so a retried tool call does not duplicate it.
- The due date is a calendar day, not an instant, so it means the same day
  wherever the owner is.
</decision>

<consequences>
- The mini app and an optional Notion connector can read and change the same
  list through the same owner API; Nocheh's list stays the main one.
- Tasks from groups are not captured yet; the owner adds them in the private
  chat or the dashboard.
- Nocheh does not send reminders for due tasks.
</consequences>
