# ADR-0104: Start turns in Telegram update order and retry untransmitted sends

<status>
Accepted implementation decision. Extends
[0089](0089-physical-telegram-delivery-boundary.md) and
[0047](0047-receipted-event-handoff.md). Approved-action uncertainty and
existing receipt identities are unchanged.
</status>

<context>
The personal-use Telegram simulation found two reply failures. Three messages
sent together in one conversation were answered out of order: updates from one
poll enter the spool together, the spool commits them in file-name order, and
each message's preparation can finish at a different time, so a later message
could start first. Separately, a reply that became ready while the native
adapter was reconnecting polling failed without any Bot API request, yet the
dispatch recorded `delivery_unconfirmed`, an uncertain terminal state. The
owner never received that reply.
</context>

<decision>
Before a Telegram turn starts, the dispatcher holds it while an earlier update
of the same conversation, by Telegram `update_id` and audience space, is
captured live but has not started. Capture sequence is not used for this order.
Started turns are already serialized by the native gateway. The hold applies
for at most 120 seconds after the dispatch was created, so a slow prerequisite
such as transcription cannot hold later messages indefinitely.

The outbound validator from 0089 also records every message request it admits
for transmission. When native delivery fails and the validator admitted no
message request for that attempt, nothing reached Telegram: the attempt fails
as `assistant_runtime_unavailable` with stage `telegram_send_not_transmitted`
and the dispatcher retries under a fresh attempt identity. Once any request is
admitted, a failure remains uncertain and is never resent automatically.

Speech whose transcription returned no usable text closes its dispatch as
`suppressed` with `invalid_transcription_response` instead of waiting on the
prerequisite indefinitely. Its original stays archived and no reply is sent as
if it were transcribed.
</decision>

<consequences>
Replies to messages sent together follow their sending order, including after
an outage replays the spool. A held turn waits in two-second admission steps.
An earlier message waiting on transcription delays a later one by at most the
bound, after which they may be answered out of order. A definite Bot API
rejection after transmission, such as a deleted topic or a blocked bot, stays
labeled uncertain. Approved actions keep their existing rule: absence of a
native intent record is not permission to resend.
</consequences>
