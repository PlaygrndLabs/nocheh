# ADR-0085: Fair background workflow admission

<status>
Accepted implementation decision for the authorized MVP release work. Extends
[0080](0080-reply-admission-and-honcho-derivation.md) on bounded workflow admission.
</status>

<decision>
Background operations retain their first observed waiting order across retries
within the single workflow process. An operation can enter the background slot
only when it is first in that order and the existing admission cap permits it.
A bounded in-memory map holds at most 1,024 waiting identities. Each retry refreshes
liveness without moving its position. A waiter absent for two minutes expires.
The admitted entry is removed before executing, and completion or failure releases
the existing slot.

Inngest continues to schedule retries and own durable execution. Waiting does not
hold a database connection, promise, or additional execution slot. Foreground
operations bypass the background ordering; the total concurrency cap and reserved
reply capacity are unchanged. No provider, policy, consent, or receipt authority
changes.
</decision>

<consequences>
A newly retried background job cannot repeatedly take the free slot ahead of a
continuously waiting older job. A disappeared waiter can delay background work
until its liveness window expires, while foreground work can still run. Process
restart discards only the ordering hint; durable identities, receipts, and
Inngest retries survive. The ordering does not bound model duration or guarantee
memory readiness under continuous foreground load.
</consequences>
