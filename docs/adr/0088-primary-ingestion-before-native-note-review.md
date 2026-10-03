# ADR-0088: Give primary ingestion a first attempt before native note review

<status>
Accepted implementation decision for the authorized MVP release work. Extends
[0080](0080-reply-admission-and-honcho-derivation.md) and
[0087](0087-live-background-admission-handoff.md).
</status>

<decision>
Before starting a pending native note review, the storage workflow checks for
current, non-retired primary-memory ingestion receipts whose first attempt is
due and which have no recorded error. While such work exists, the review returns
an Inngest prerequisite wait without starting a native effect. The check applies
only when Honcho is attached and verified and the review's guard binding is
current.

Completed, running, and uncertain reviews keep their existing completion and
receipt-reconciliation paths. Failed ingestion, future retries, retired
generations, and a detached memory engine do not reserve this priority. The
operation cap, provider limits, permission checks, and durable identities remain
the same.
</decision>

<consequences>
A new native review cannot occupy the only background slot for several minutes
ahead of primary writes that have never started. Native review resumes when
those writes have completed or recorded their first failure. This is a bounded
prerequisite observation, not another scheduler or a guarantee of global FIFO
ordering. Continuous new ingestion can delay new native notes; current authorized
archive access and existing notes remain available under their ordinary rules.
</consequences>
