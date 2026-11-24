# ADR-0288: One agent session per chat per day

<status>
Accepted on 2026-11-24. The owner chose a new session each day for every chat, the
carried message count as a setting, and asked for no manual step. Extends
[ADR-0163](0163-chat-conversation-carries-into-new-guard-epochs.md) and
[ADR-0227](0227-hermes-lists-chats-by-their-names.md).
</status>

## Context

Each chat's conversation (the owner's private chat, a group, each forum topic, a member's
private chat) was one Hermes session for good: `nocheh-` plus a digest of the chat and
thread. Only Hermes's own compaction, at 100,000 prompt tokens, ever changed it. Every turn
loaded the whole session, so the owner's private chat grew past 86 messages and each reply
paid for all of them. Hermes 0.23.3 no longer resets sessions on a timer in its core; it
moved that to an optional plugin of its own gateway, which Nocheh does not run.

What a chat knows beyond one day already lives elsewhere: long-term memory is read on every
turn, the archive and session search reach earlier talk, and Hermes's notes are reviewed
message by message, not at a session's end.

## Decision

1. **A chat gets a new session on its first message of a new day.** The day turns at 04:00
   in the chat's time zone: the member's own in a member's private chat when set, else the
   owner's (Nocheh sends it with each turn as `day_zone`; UTC when unset). A conversation
   still going at 04:00 keeps its session until it has been quiet for 30 minutes.
2. **The cursor keeps the day.** `active-<logical>.json` holds `session_id`, `day` and
   `last_active`. A cursor from before this change counts as today's. A new day's session is
   `nocheh-<logical>-<YYYYMMDD>`, so a retried turn lands in the same one; a chat's first
   session keeps the fixed `nocheh-<logical>`.
3. **A new session starts from the last messages of the one before.** It is created with
   `parent_session_id` and Hermes's reset lineage, seeded with the last user messages and
   delivered answers (no tool work, reasoning or summaries), then the earlier session is
   closed with Hermes's end reason `daily`. That reason is one of Hermes's boundaries, so
   session search still finds the earlier day.
4. **The count is a setting.** `nocheh.carry_messages` (0–200, default 50) is a per-chat
   agent setting with the others ("Messages carried into a new day"), inherited from the
   defaults like them.
5. **A follow-up never moves.** A turn that continues an approved action runs in the session
   the chat holds, whatever the day.
6. **Titles carry the day.** A session is named after its chat and day, such as
   `Private chat · 25 Nov`.
7. **A new guard epoch keeps the day.** Carry copies the cursor's `day` and `last_active`
   with the session.

Private answers, asks about a member, schedules, memory reviews and background jobs are
unchanged: the first four already start fresh each run, and a job keeps one session for all
its attempts.

## Consequences

- Each reply carries at most one day of conversation plus the carried messages.
- Earlier days stay in the profile as closed sessions, readable through session search
  until the profile's next guard epoch, and in the archive for good.
- Telegram shows no change: the chat stays one chat.
- Residual: Hermes's notes are still not carried across guard epochs (ADR-0163); that is a
  separate question.
