# ADR-0125: Telegram turns run per chat, two chats at a time

<status>
Accepted on 2026-10-10 after the live H6 check on the owner's development
installation measured a median reply time of 88 seconds, while the model
itself took about 3 seconds. Hermes' internal workflow is unchanged; only
Nocheh's committed Telegram adapter changes.
</status>

<context>
`AssistantGateway.dispatch` held one lock for the whole of every Telegram turn,
from the intent receipt through native delivery and the result receipt, and
waited for every pending native batch task of every chat. A turn in one chat
therefore waited for turns in all other chats. The `hermes_queue` stage, which
ends when a turn starts, had a median of 30 seconds and a worst case of 114
seconds. An owner turn that waits behind a Hermes native memory review on the
owner profile's turn lock made every group wait too.

The lock protected three things: per-chat order, the check-then-write of each
event attempt's receipts, and native text batches, whose key is per chat,
topic and sender. Turn attribution does not need it, because each dispatch
runs as its own task and the native batch tasks copy that task's context.
Profiles are derived from the chat or topic, so turns in different chats never
share a profile.
</context>

<decision>

- Each chat has its own dispatch lane. Turns in one chat start in arrival
  order and one at a time, so receipts, native batches and replies in a chat
  behave as before. Topics of one group share the group's lane.
- At most two turns run at once across all chats. Each isolated turn takes one
  of the security launcher's four slots, which reviews, browser and scheduled
  runs share. A turn takes its chat's lane before a slot, and checks its
  receipt and cancellation before starting.
- A turn waits only for the native batch tasks it created, recorded when
  Hermes enqueues them, not for other chats' tasks.
- The profile turn lock and native memory lock stay as they are, so an owner
  turn still waits behind a running review on the owner profile.

</decision>

<consequences>
- A slow turn or a running review delays only its own chat, apart from the
  two-slot limit.
- `hermes_queue` now measures the wait for the chat's lane and a free slot.
- Guard detection still runs one call at a time in the Hermes process and may
  become the next shared wait.
</consequences>
