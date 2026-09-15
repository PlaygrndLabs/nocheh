# ADR-0044: Automatic Honcho context with background refresh

<decision>

Honcho remains the primary long-term memory defined in
[ADR-0033](0033-guarded-projections-and-honcho-memory.md). Hermes keeps small
native notes and its native session history. This decision changes retrieval
timing, not ownership or the permitted memory sources.

Every assistant turn reads a bounded Honcho representation from Nocheh's
protected archive. Inngest's generation observer refreshes it using the pinned
Honcho stored-representation endpoint, without a query, embedding request, or
reasoning call. Preparation still runs through Nocheh's guard before storage.
The cache is keyed by generation, which binds audience, guard epoch and policy
revision. Reads revalidate these bindings before returning any content.

A generation creates a durable context workflow that refreshes every two minutes,
including while conversations are idle. A context read after one minute ensures
that permanent request exists; concurrent readers converge and owner cancellation
is not reopened. Context older than five minutes,
retired generations and unready initial builds report limited memory. A transient
refresh failure can retain usable context within that limit. Completed ingestion
receipts are never reopened by a context refresh.

The automatic representation is bounded to 50 conclusions and 20,000 characters.
It is not a query answer or a replacement for complete memory. Hermes receives
instructions to use the scoped Honcho recall tool when relevant personal facts,
preferences, decisions or relationships are absent from the supplied context.
No keyword classifier decides whether Honcho is the main memory. Query-specific
reasoning remains available through the existing recall route and is never stored
as the general context for a subsequent unrelated turn.

</decision>

<boundaries>

Only IDs and status observations enter Inngest. Cached text stays in the archive
and its quiesced backup. Owner edits and representation changes retire old
generations; a cached response cannot bypass audience checks or those revisions.
The runtime receives neither direct Honcho access nor its provider credentials.

Native history, notes, approval enforcement and final-delivery receipts retain
their existing boundaries. Production activation requires cache isolation,
revocation, refresh failure, recovery and real runtime acceptance; implementation
alone is not activation. Evidence and pending work belong in [TASK.md](../../TASK.md).

</boundaries>
