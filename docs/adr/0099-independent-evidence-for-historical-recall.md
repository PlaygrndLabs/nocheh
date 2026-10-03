# ADR-0099: Require independent source evidence for historical recall

<status>
Accepted implementation decision. Extends entity-aware recall in
[0056](0056-connected-entity-memory.md) and automatic context in
[0044](0044-automatic-honcho-context.md).
</status>

<context>
Ingestion can finish before an incoming question invokes foreground recall.
A new audience can therefore have a completed Honcho peer receipt whose only
evidence is that same question. Reasoning over that peer cannot establish an
earlier fact and can consume the foreground turn's deadline.
</context>

<decision>
When a foreground caller supplies its current turn event, a candidate peer must
have a completed receipt supported by at least one source other than that event.
Check all source references, falling back to the primary source for older
receipts. Mixed receipts with independent supporting evidence remain eligible.
Existing entity resolution, audience authorization, guarding, owner corrections,
and bounded peer traversal still apply.

This restriction applies to foreground historical recall. Background ingestion
and representation keep the current source eligible, including the first source
of a generation. A caller without a turn event retains its existing behavior.
</decision>

<consequences>
A question-only peer yields the existing limited-memory result without a Honcho
reasoning request. Once independent evidence has completed ingestion, the peer
can support recall. This is an eligibility rule, not a claim that all earlier
sources are relevant or that a question is removed from an otherwise eligible
Honcho corpus. Source preservation, revocation and original reply deadlines
remain in force.
</consequences>
