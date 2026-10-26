# ADR-0167: Tasks like a Notion table

<status>
Accepted on 2026-10-26. The owner asked whether the task structure and design
is like Notion and other task managers, and wanted to see and cover all
domains to prevent migration and change in the future. After a review of the
gaps, the owner chose "Everything, plus board and Today": every missing piece
of the task data, a board, and Today and Upcoming views, in one change.
Calendar and saved views come later. Extends ADR-0160 and ADR-0164. The
project is in development, so the old task tables are replaced, not converted.
</status>

<context>
A task had a title, notes, a due day, a list, a group, people and tags, and was
open, done or dropped. Notion, Todoist, Linear and similar tools also carry
custom statuses, priority, start and due times, repeats, reminders, subtasks,
dependencies, assignees, manual order, custom columns, comments, history,
attachments, archive and trash. Adding each later would change the stored
shape each time.
</context>

<decision>
- Statuses are the owner's own list in Settings › Tasks, each with a name, a
  colour and one of four fixed kinds: not started, active, done or cancelled.
  The kind sets the task's state (open, done, dropped), so every view and the
  assistant can rely on it. Each kind keeps at least one status; removing a
  status moves its tasks to the first status of the same kind.
- Priority has five fixed levels, 0 to 4, whose names and colours the owner
  edits.
- A task has an optional start day and time, due day and time, and a repeat
  (every N days, weeks on chosen weekdays, months or years, counted from the
  due day or from the day it was done). Finishing a repeating task adds the
  next one with its dates moved and remembers it, so finishing twice never adds
  two.
- Reminders are exact moments. The worker sends each one once to the owner's
  private chat through the Hermes gateway with an idempotent receipt, using
  the "Task reminder" text in Settings › Assistant. A reminder whose send is
  not known to have failed is marked uncertain, never sent again. Reminders of
  a task that is no longer open are skipped.
- Subtasks are tasks with a parent in the same list. Tasks can wait on other
  tasks (blocked by), be related to them, or be a duplicate of one.
- Assigned to (who does it) is kept apart from People (who it is about).
- Tasks have a manual order inside their list and parent, which the board's
  drag and drop sets.
- The owner adds columns in Settings › Tasks: text, number, select, multi
  select, date, checkbox, link or person. Removing a column or a choice clears
  it from tasks.
- Comments, links and archived messages can be attached. Every change is kept
  in the task's history with who made it: the owner, a named member in a
  project chat, or the assistant. A task keeps who created and who finished it.
- Notes are Markdown, up to 20,000 characters, and shown safely without HTML.
- Finished tasks can be archived, and any task can be moved to the trash and
  restored. Only a task in the trash can be deleted for good.
- Each task has an empty `external` map for IDs in an outside tool such as
  Notion. Chat cannot set it.
- Today and Upcoming use the time zone in Settings › Tasks. The dashboard has
  Open, Today, Upcoming, Board, Done, Dropped, Archive and Trash views, and a
  task panel with Save and Discard at the top. The mini app reaches the same
  task routes except saving task settings.
- The assistant's `nocheh_tasks` tool lists, reads, adds, updates and comments
  with the same fields, within the list rules of ADR-0164.
</decision>

<consequences>
- Existing tasks are dropped once on the first start after this change.
- A calendar view and saved views can be added without changing stored data.
- Linking to Notion later fills `external` instead of adding columns.
</consequences>
