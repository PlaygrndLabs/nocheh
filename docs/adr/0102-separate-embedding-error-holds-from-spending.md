# ADR-0102: Separate failed embedding holds from cap spending

<status>
Accepted implementation decision. Supersedes the failed-call hold rule in
[0079](0079-separated-honcho-budgets-and-settlement.md) and the corresponding
historical-hold consequence of [0100](0100-durable-embedding-egress-cooldown.md).
The pre-egress reservation and provider-failure cooldown remain in force.
</status>

<context>
The owner observed about $0.12 of reported successful embedding usage while
488 failed requests held $4.88 against a $5 cap. A reservation is an admission
bound, not a provider charge. The old ledger stored HTTP and transport errors
under the same status, so the historical failure type cannot be reconstructed.
</context>

<decision>
Keep each call and its original admission reservation. A successful response
with reported tokens settles to its priced usage. A definite HTTP error releases
its hold from cap accounting; a transport failure without a response, unfinished
call, or successful response without usage retains the hold. Label old failed
calls whose response type was not stored as unverified, expose their historical
hold separately, and exclude it from cap spending. Never present this estimate
as a provider invoice. Retain the cooldown after either HTTP 5xx or transport
failure.
</decision>

<consequences>
Historical errors no longer exhaust the $5 cap, but their original rows and
uncertainty remain visible. An unknown historical error may still have incurred
a provider charge; the provider's reconciled Costs data remains the authority
for actual billing. A new transport failure remains conservatively counted and
cannot silently become a free retry. Restart and cap changes never erase calls.
</consequences>
