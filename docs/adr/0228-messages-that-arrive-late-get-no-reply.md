# ADR-0228: Messages that arrive late get no reply

<status>
Proposed on 2026-11-10, after Nocheh's computer was offline overnight and, once
it was back, answered every update Telegram had held as a live message,
including hours-old group messages. Accepted when the owner merges it; the
30-minute default and the summary wording are recommendations the owner can
change. Extends the update order of
[ADR-0104](0104-telegram-update-order-and-untransmitted-sends.md), the
suppression without a turn of [ADR-0133](0133-group-replies-when-addressed.md)
and [ADR-0182](0182-strangers-cost-nothing-and-reach-no-model.md), and the
owner-editable texts of
[ADR-0152](0152-owner-editable-built-in-instructions.md). Amends which earlier
messages a group turn sees in
[ADR-0157](0157-group-turns-see-recent-unaddressed-messages.md). Its summary
loop runs outside Inngest, with the reason that
[ADR-0120](0120-loops-outside-inngest.md) asks for.
</status>

<context>
- Capture polls with `drop_pending_updates=False`, so no update is lost while
  Nocheh is down: Telegram holds undelivered updates for about a day and sends
  them all when polling resumes. Each is saved with `origin='live'`, exactly like
  a message that just arrived.
- The dispatcher had no age limit. After a night offline, every held message
  started a turn, so people got answers to questions asked hours earlier,
  sometimes long after the conversation had moved on.
- `events.occurred_at` is the send time capture took from Telegram (`date`, in
  whole seconds) and `events.received_at` is when the archive saved the update.
  After an offline gap they differ by the length of the gap. A reply that failed
  and is retried later keeps both, so comparing them never mistakes a delayed
  retry for a late message.
- Only Hermes decides whether a group message addressed Nocheh
  (`group_trigger`, with the bot's own Telegram name). A late message nobody
  addressed to Nocheh would not have been answered anyway.
- Owner commands in a message (`/approve`, `/deny`, `/revoke`) run while
  Nocheh builds the turn, before Hermes sees it.
</context>

<decision>
- `TELEGRAM_LATE_MINUTES` (Settings › Telegram, "Messages that arrive late",
  30 by default, 0 = always answer, at most 1440) is read by `nocheh-app` and
  takes effect after Apply. The policy field `late_minutes` is off when absent.
- A message is late when `received_at - occurred_at` exceeds the limit
  (`arrivedLate`). A missing or non-numeric `occurred_at` is never late.
- For a late message the dispatcher builds the turn input as usual but runs no
  owner command (`control_reply` is null), sends no fixed refusal to someone
  Nocheh does not serve, and adds `late: true` to the stored input. The flag is
  part of the attempt's input, so a resend of the same attempt carries it.
- The gateway checks addressing first, so unaddressed group chatter stays
  `not_addressed`; then a message turn with `late: true` closes as
  `suppressed`/`too_old` before any receipt, lane, typing or reaction.
  Continuations are exempt: they answer an approved operation and reuse the old
  asking message. `too_old` joins `turnResultCodes` and the gateway's `CODES`.
  Approve and Reject button presses are decided as before.
- A late turn gathers no recent group messages, since it is never answered.
  Other group turns list recent messages in Telegram update order instead of
  save order. The list includes messages saved up to two minutes after the
  turn's own message when they were sent before it. It passes over `too_old`
  outcomes and late messages whose dispatch is still open, because none of
  them gets a turn of its own. Any other outcome ends the list, even for a late
  message, because that turn already ran.
- The store worker's `late` loop runs every 30 seconds. It runs outside
  Inngest, like the task reminders, because it only reads dispatch rows and
  sends one owner notice.
  - It waits until no `too_old` row has appeared for two minutes, or until the
    oldest unreported row has waited ten minutes.
  - It then claims every unreported row so far under one batch ID
    (`dispatches.late_notice`, `late_notice_state` `sending` → `sent` or
    `uncertain`).
  - It sends `telegram.notice` with that ID. The notice has one line per chat
    that Nocheh still serves, with its count: the owner's private chat first,
    then the most skipped. A batch with no such chat left, for example after
    the owner changed, is marked `skipped` and nothing is sent.
  - The wording is the owner-editable `telegram.late_messages`, with `{chats}`
    required and `{minutes}` (the bare number, so the wording carries the unit
    in any language) and `{count}` optional.
  - A send that did not start is retried with the same ID; an unclear one is
    never repeated.
- The Messages page labels the outcome "Arrived late, not answered".
</decision>

<consequences>
- After an outage, people get no answers to stale questions, the owner learns
  once what was skipped, and the archive and learning keep every message.
- A late message gets no reply even when nobody would mind one; the owner can
  raise the limit or choose "Always answer". A turn started in time and then
  interrupted for longer than the limit is still resumed.
- If Telegram keeps delivering late messages more than two minutes apart, for
  example while slow voice notes are prepared, or for more than ten minutes,
  the owner may get a second summary for the rest.
- Lateness compares Telegram's send time with this computer's clock. If the
  clock runs more than the limit ahead, every message counts as late and gets
  no reply. The owner still gets a summary within about ten minutes, which
  lists the chats it skipped. "Always answer" turns the check off.
- A late group message that is saved more than two minutes after a later
  message has been answered, which needs a backlog of over a hundred updates,
  is not shown to later replies.
- The summary counts only messages that would have been answered: the owner's
  private messages and group messages that addressed Nocheh, or every allowed
  group message when "Group replies" answers all.
</consequences>
