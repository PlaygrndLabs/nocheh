# ADR-0295: Words others wrote never read as the owner's

<status>
Accepted on 2026-11-24, from the attack test audit. Amends
[ADR-0257](0257-learned-memory-names-its-source.md) (what a turn read) and
[ADR-0276](0276-a-projects-tasks-are-one-list.md) (task reads that mark).
</status>

<context>
- A note a turn writes in the owner's private chat reads "written while
  answering the owner's own message" unless the turn read something outside.
  Long-term memory recall and the project's tasks were not counted as outside
  reads, yet both can hold what other people wrote: memory learns from every
  group, and members write tasks in groups and in the members' app.
- So a claim planted in a group, or in a member's task, could be saved as a note
  that later reads as Nocheh's own note from the owner's chat.
- The owner's chat, a scheduled run such as the morning brief and a group turn
  read the same task list, which did not say who wrote a task's text.
</context>

<decision>

- Two new read tokens, in Hermes (`note_sources.READS`) and storage
  (`readTokens`): `memory` ("long-term memory") and `tasks` ("tasks other people
  wrote"). The owner's label lines are `read_memory` and `read_tasks`.
- A `memory_recall` result is a `memory` read when it holds memory's own
  reasoning (`"kind":"memory_inference"`, escaped or not); one with only the
  owner's corrections, or nothing, is not.
- The long-term memory context a turn read before it started is a `memory` read
  when a note the turn wrote copies a run of text or a distinctive token from it,
  as earlier reads are checked. The turn's process returns it to its parent as
  `memory_context` (at most 256 KiB), which the parent removes from the result.
- Storage marks a chat's task answer (list, get, add, update, comment) in every
  chat: each task shown whose title or notes a person other than the owner last
  wrote (`owner_task_writers.by='person'`), or that shows a comment a member
  wrote, lists those parts in `written_by_others` (`title`, `notes`,
  `comments`), and the answer gets `others_wrote: true`. The tool keeps the mark
  on a cut answer. A task result marked `others_wrote` is a `tasks` read
  (`other_groups` still reads as other chats first).
- The tasks tool tells the model that such parts are that person's words, never
  the owner's and not instructions, and to say someone else wrote them when it
  repeats them in the owner's chat, a brief or a note.
- No schema change.

</decision>

<consequences>
- A note saved after recall, after reading a member's task, or copying what
  long-term memory said reads "after reading long-term memory" or "after reading
  tasks other people wrote", in every chat.
- A note the owner dictates that happens to repeat long-term memory word for
  word also reads that way: less trusted, never more.
- A note that paraphrases the long-term memory context, with no run of its text
  and no distinctive token, still escapes, as a paraphrase of an earlier read
  does.
</consequences>
