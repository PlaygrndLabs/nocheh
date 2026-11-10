# ADR-0230: Portable export carries the owner's work and choices

<status>
Accepted on 2026-11-10, after the owner asked for a full export that includes
tasks, schedules and sharing rules. Extends the portable package of
[ADR-0032](0032-isolated-upgrades-and-portable-memory.md). Keeps the inactive
import rules that portable import already follows for saved authority.
</status>

<context>
- The portable package carried originals, derivatives, Honcho memory and Hermes
  native notes. The owner's own records in the control store did not travel:
  tasks with their comments, reminders, people, links, files and history; which
  project each chat belongs to; sharing rules; hidden sources; learning choices;
  topic names; edited built-in texts; and task, Notion and background-work
  settings. Hermes's own scheduled jobs (`cron/jobs.json`) were left out too.
- These rows use dates, times, text arrays, decimals and composite keys, which
  the derivative record format does not carry.
- A sharing rule, a reminder or a schedule can act. Portable import must not
  start anything by itself.
</context>

<decision>
- The package gets an `owner/` domain (`nocheh-owner-data-v1`): one
  `records.ndjson` with a manifest, a record count and a checksum. Each record
  is `nocheh-owner-record-v1` with its table, key, row and a SHA-256 over them.
- The tables come from one fixed list, parents first: task settings, tasks,
  task people, links, reminders, comments, activity and attachments, project
  assignments, sharing rules, learning consent, source retirements and their
  history, Telegram topic names, built-in text edits, Notion settings and
  background-work settings. Projects and people arrive earlier, with the
  derivatives.
- Export reads each row as Postgres renders it (`row_to_json`), in key order
  with a text cursor. Import writes it back through `json_populate_record`,
  so every column keeps its type.
- Import adds rows that are missing and never overwrites one already there. A
  row with other content is kept and counted as `kept`. A setting row replaces
  the destination's default only while that default was never changed
  (revision 0). Activity rows get new numbers; an identical row counts as the
  same entry. A task whose parent task has not arrived yet waits for the next
  pass; a pass without progress stops the import.
- Nothing imported acts by itself: sharing rules arrive switched off, and a
  reminder that is past due or was interrupted while sending arrives skipped. A
  future reminder stays pending. The freedom level, Telegram policy, grants,
  approvals, job history and receipts stay out of the format.
- Native export also copies each profile's `cron/jobs.json`. Like the rest of
  the native package, it is staged inactive and never replaces a live Hermes
  home.
</decision>

<consequences>
- After an import, the owner turns sharing rules back on, and adopts the staged
  scheduled jobs if they want them to run.
- A new owner table is added to the list on purpose; the export never takes a
  table it does not name.
- Development mode: older packages without `owner/` are not accepted.
</consequences>
