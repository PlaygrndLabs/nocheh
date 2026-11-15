# ADR-0255: Reminders say who set them

<status>
Accepted on 2026-11-15, as the reminders half of the third set of fixes from
the review of how text from outside reaches Nocheh (risk 9, "Member reminders
reach your private chat"). The owner approved it on 2026-11-14 ("all yes") with
its wording: each reminder stores who set it and gets a fixed "Set by … in …"
line; a member's edit no longer deletes the owner's own reminders; reminders
that come due together are merged, with at most one message per group every 10
minutes; no daily cap, and no reminder is ever dropped. Amends
[ADR-0167](0167-tasks-like-a-notion-table.md) (how reminders are replaced,
skipped and sent), [ADR-0230](0230-portable-export-carries-owner-work.md) (the
export carries who set a reminder), [ADR-0248](0248-tasks-follow-data-access.md)
(a group's view of a reminder) and
[ADR-0251](0251-chats-get-nochehs-own-ids.md) (new chat columns). The sends
half is [ADR-0254](0254-sends-go-only-to-chats-nocheh-serves.md), whose chat
words and name rules reminders share.
</status>

<context>
- A person allowed in a project's group manages its tasks there, reminders
  included, and every reminder goes to the owner's private chat. A reminder
  carried no setter: in the owner's chat it read like one the owner set, with
  a title and notes anyone in the group could write.
- Any change to a task's reminders deleted every pending one and wrote the
  list again, so a person's edit removed the owner's own reminders.
- Many reminders due at once were many messages, one each.
- Notes were cut at 500 UTF-16 units. A cut inside an emoji left half a
  character, which the bot refuses; the reminder then stayed "sending",
  sorted first on every later pass, and held back every reminder after it.
</context>

<decision>

## Who set it, and who wrote the task

- Each reminder stores `set_by` (`owner` or `person`, no default, so an insert
  that names no setter fails), the person's account (`set_by_account_id`, a
  `chat_accounts` id) and the name Telegram showed then (`set_by_name`), and
  where it was set: `set_in_chat_id` (the group or topic) and
  `set_in_group_id` (that chat's group at set time, the key of the gap below).
  Both are null for the owner's private chat, the dashboard, the mini app, the
  API and a card the owner approved. A person whose account cannot be told is
  allowed and named "someone you allowed". The new chat columns are registered
  for seeding as ADR-0251 requires.
- `owner_task_writers` keeps, per task and field (`title`, `notes`, `due`,
  `closed`), who last wrote it anywhere but the owner's private chat or the
  dashboard, and where. The owner there takes a field back by writing it; a
  task open again loses its `closed` row; archiving or trashing marks the
  tasks under it closed by the same writer. A repeat copy keeps its
  reminders' setters and the writers of its title, notes and due day.

## Lists and limits

- A list is matched to the stored reminders by the minute. The owner's list
  changes every reminder still to come. A person's list changes only the
  reminders people set: the owner's stay, and the answer lists them as
  `reminders_kept`, with a note for the model that only the owner removes them.
  People still remove one another's reminders.
- A listed minute that matches a reminder already sent, unclear, refused or
  sending is kept as it is, so a list read before a reminder went out still
  saves; one that matches only a skipped reminder comes back as the editor's.
- A new time must be in the future, with a minute's grace
  (`task_reminder_past`). Each editor, the owner or one person, keeps at most 10
  of their own reminders still to come on a task, and a list holds at most the
  reminders still to come plus 10 (`task_reminder_limit`). A time that cannot
  be read is `invalid_task_reminder`. The data tool answers these with a note
  on what to ask for, and the broker relays exactly these codes from the task
  routes.
- A reminder's id is the task and time for the owner's, and the task, time and
  account (or name) for a person's, so one setter's reminder never takes
  another's.
- When the owner's message in a group removes reminders that were set
  elsewhere, the owner's private chat gets one notice, `removed_in_group`, with
  the task and the times; the same removal never tells twice. What others
  posted in that group can steer the owner's turn there, and the removal is
  otherwise only in the task's history.

## What a reminder says

- A reminder set anywhere but by the owner in the private chat or the
  dashboard starts with `set_by` ("👤 Set by {who} in {place}"). Lines for who
  last wrote the title, notes or due day elsewhere (`written_by`, with
  `field_title`, `field_notes`, `field_due`) and who closed the task
  (`closed_by`) follow. These lines are written by code, come first and are
  never cut.
- With any such line, the task's title shows on one line, and its notes show
  with hidden characters written out, at most three marks on a letter, runs of
  spaces as one, empty lines folded to one between paragraphs, every line after
  the `note_line` mark ("┆"), at most 20 lines and 500 characters. A reminder
  with none of these lines reads exactly as before, from the owner's template.
- {who} is "you", or a person by the name Telegram shows now, else the name at
  set time, else their @username, quoted and isolated as on cards, as "a person
  you allowed", or "a person you no longer allow" when no served group allows
  them now. A name that reads like another person's, the owner's chat's or a
  served chat's gets the person's @username, or else a short id. {place} uses
  the approval texts' chat words (ADR-0254), so there is one set of them.
- Every cut keeps whole characters, and every message stays within 4000 UTF-16
  units: the lines stay whole and the body is cut. A text Telegram could not
  take is never sent.
- The lines are owner-editable in a new labeled text, `tasks.reminder_texts`
  ("Reminder lines: who set it and where"); a saved line that drops a value
  Nocheh fills in is refused, and a stored one reads as its default.

## Delivery

- **The owner's reminders** come one message each, at their time, as before.
  On a task a person finished, archived or trashed they are sent with the
  `closed_by` line; only a task the owner closed skips them.
- **People's reminders** due in one group come merged into one message: at most
  one message per group every 10 minutes, counted from the last one sent or
  unclear; a refused one takes no turn. Each message takes the group's due
  reminders round-robin by who set them, so one person's many never hold back
  another's, as many as fit and always at least one. It has a `merged` header
  when it holds more than one, then one `set_by` line per setter and place, and
  a `more_waiting` line when more are due. The message is kept and sent again
  unchanged under the same id after a lost answer. A person's reminder is
  skipped only when its task closed before it came due; waiting for its turn
  never drops it.
- **Worst-case delay.** The first message for a quiet group goes within one
  pass of the worker (15 seconds or less). Each further message waits 10
  minutes, so with a backlog the k-th message leaves about 10 × (k − 1)
  minutes after the first. For example, 20 reminders with 500-character notes
  make about 5 messages, and the last arrives about 40 minutes late. Nothing is
  dropped, and nothing is cut beyond the 500 characters of notes.
- **Answers.** Sent is sent; unclear is `uncertain` and never sent again; "not
  connected yet" puts it back to wait. A refusal Telegram gives before
  anything is sent marks it `failed` and the next one goes on. A conflict or a
  server error tries the same id again, up to 5 tries, then `uncertain`.
  Transport errors and rate limits end the pass, as before, and the same id is
  sent on a later pass, which the bot's receipts make safe. A `failed` or
  `uncertain` end writes a send record (`reminder_refused`,
  `reminder_unconfirmed`), so it shows in System › Health and, as a notice
  kind, never causes another notice.
- The owner's task view gives each reminder `{at, state, set_by, source}`,
  `source` being the same `set_by` line Telegram shows, or null; the drawer
  shows it, and "Not sent" for `failed`. A group's view gives
  `{at, state, set_by}` for the reminders still to come. The drawer sends an
  entry the owner did not touch back exactly as stored, so it keeps its setter
  and seconds.
- The portable export carries the setters and the writers by account; the
  names people gave themselves are cleared, a merged message's id and the tries
  are reset, and the merged messages are not exported. An older export's
  reminder arrives as the owner's.

</decision>

<alternatives>
- **A cap on pending reminders per group, or per day.** Not built: the approved
  wording has no cap, and a capped reminder is a lost one.
- **Holding a removed person's reminders.** Rejected: a held reminder never
  arrives. They come labeled "a person you no longer allow".
- **Merging the owner's reminders set in a group.** Rejected: it would delay
  the owner's own reminders, which arrive at their time.
- **A Health problem for reminders waiting over 30 minutes.** Rejected: the
  wait is the approved gap, and the backlog is told in the message itself.
- **A copy of these rules in the bot.** Not built: reminders are composed in
  the app, and the bot sends only to the owner's private chat.
</alternatives>

<consequences>
- The owner always sees who set a reminder people set, and where, before
  anything they wrote. A person's edit never removes the owner's reminders.
- People's reminders that come due together arrive as one message per group;
  with many due at once the last can come tens of minutes late, as stated
  above. The owner's own arrive at their time, now also on a task a person
  closed.
- A reminder whose notes end inside an emoji arrives, and a reminder Telegram
  refuses no longer holds back the ones after it.
- Each editor may keep 10 of their own on a task, where a task held 10 in all.
- Two behaviour changes the review left open are built as recommended: the
  owner's reminders on a task a person closed are sent with the `closed_by`
  line, while the owner's own closing still skips them (before, any closing
  skipped them); and the `removed_in_group` notice.
- In a development database, reminders pending before this change read as the
  owner's.
- **Residuals:**
  - The owner's reminders set in a group are not merged or held by the gap; they
    arrive at their time and carry the `set_by` line.
  - A chat the directory did not know when a reminder was set keeps that chat
    as its own gap key.
  - Notes can still hold text that imitates a line, but the real lines come
    first and every notes line is marked.
</consequences>
