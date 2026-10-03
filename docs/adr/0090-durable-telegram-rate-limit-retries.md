<decision>

# 0090 — Preserve rejected rate-limit attempts while permitting recovery

<context>

The durable send journal from [0018](0018-hermes-owned-archive-subscription-rebuild.md)
prevents uncertain or confirmed effects from being repeated. The physical request
boundary in [0089](0089-physical-telegram-delivery-boundary.md) checks each native
retry. A documented Telegram `429` response explicitly rejects a send and supplies
`retry_after`; permanently replaying that rejection prevents the native adapter
from recovering after its wait.

</context>

<choice>

Retain the original immutable result. Permit a new durable attempt only when its
predecessor is a rejected HTTP `429` with a matching Bot API error and a valid
integer `retry_after`, after the recorded result file's timestamp plus that wait.
Each retry has a stable suffix in the original request's identity. Keep at most
three attempts, matching the pinned adapter's send budget, across replay and
restart. Hermes owns the wait; the journal admits or replays the physical request.

A delivered result remains reusable. An intent without a result, a network loss,
or a server failure remains uncertain and cannot authorize another attempt.
Malformed rate-limit responses and other rejections do not enter this exception.
The audience and current authority checks still precede each attempt.

</choice>

<consequences>

Recovery preserves evidence of every physical send without erasing a rejection
or treating an uncertain effect as safe. The deadline uses the local durable
file timestamp and wall clock, so restored journals retain conservative timing
when copied with later timestamps. Native adapter upgrades must recheck the
three-attempt contract. This extends the receipt boundary; it does not change
workflow retry ownership or permit replaying a terminal conversation delivery.

</consequences>

</decision>
