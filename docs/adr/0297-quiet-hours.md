# ADR-0297: Quiet hours

<status>
Accepted on 2026-11-24. The owner asked for it after the comparison with another personal
assistant ("add Quiet hours feat"). Default: on, 23:00 to 07:00.
</status>

## Context

Nocheh starts some messages on its own: problem notices, approval cards, job reports,
approved posts and follow-ups after an approval. Each rings the phone, at any hour. A
reply to a person's own message is already silent, and reminders and scheduled results
ring at the time the person chose.

## Decision

1. **One setting.** Settings › Telegram › Activity and notices has "Quiet hours"
   (`NOCHEH_QUIET_HOURS`, `HH:MM-HH:MM`, a window past midnight wraps; empty is off).
   The default is `23:00-07:00`.
2. **Each person's own clock.** Core's `GET /internal/quiet-hours` (service token) names
   the private chats that have a time zone: the owner's, in the owner's task time zone, and
   each active member's, in their own time zone, else the owner's. Groups have none.
   nocheh-telegram reads it at most once a minute.
3. **Silent, never held.** Inside the window, a message to such a chat that would ring is
   sent with `disable_notification`. Nothing waits, so nothing is lost or late. A
   `reminder` or `scheduled_run` still rings: the person set it for that time.
4. **Ring when unsure.** If core cannot be read, the last zones read are kept; with none,
   every message rings as before.

## Consequences

- A problem at night is still in the chat in the morning, just without the buzz.
- Group messages are unchanged; people can mute a group in Telegram.
- Approval cards a person asked for during quiet hours also arrive silently.
