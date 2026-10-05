# ADR-0100: Bound paid embedding admissions after provider failure

<status>
Accepted implementation decision. Extends the separate, durable budget and
settlement boundary in [0079](0079-separated-honcho-budgets-and-settlement.md).
</status>

<context>
The budget ledger conservatively keeps the full reservation for failed paid
embedding requests. During a fast provider outage, Honcho may retry many tasks
before the monthly cap rejects new work. The reserved amount then differs sharply
from reported successful usage. Releasing failed holds would weaken the existing
uncertain-spend rule and rewrite historical accounting.
</context>

<decision>
Keep failed reservations and add a shared, durable cooldown inside the paid
egress ledger. An upstream 5xx or transport failure starts a 60-second block on
new embedding reservations; consecutive failures double it to at most one hour.
The HTTP boundary returns a transient error and numeric retry delay while
blocked. A successful request admitted after the latest failure clears the
cooldown. An older in-flight success cannot erase a newer failure. Subscription
reasoning does not use this cooldown or the embedding dollar cap.
</decision>

<consequences>
One failure can still retain its upper-bound hold, and requests admitted before
that failure may finish later. Subsequent retries cannot rapidly consume new
holds while the route is known unhealthy. A cooldown does not restore provider
availability, retroactively release historical reservations, or verify Honcho
memory readiness. Owner-visible reserved and estimated usage remain distinct.
</consequences>
