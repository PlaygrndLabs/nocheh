# ADR-0082: Deduplicate contextual learning by evidence

<status>
Accepted implementation decision for the authorized MVP release work. Extends
[0053](0053-original-only-archive.md) and [0056](0056-connected-entity-memory.md)
on the separation between original evidence and generated interpretations.
</status>

<decision>
A completed contextual interpretation is reusable after its source inputs,
audience, consent, guarded revisions, selections, entities, and applicable
conventions have been revalidated. Automatic convention guidance contributes a
sorted, deduplicated set of its prepared source dependencies to the reuse key.
Model-generated wording, subjects, and rule identifiers do not become independent
new evidence that repeatedly triggers the same interpretation.

Owner-authored guidance contributes its identity, revision, and guarded text.
A new convention source, changed source representation, owner correction, or
retirement can therefore require a new interpretation. The model still receives
the full current rules, conflicts, observations, and provenance. This changes
job deduplication, not prompt contents or audience authority.
</decision>

<consequences>
Automatic interpretations can no longer sustain a feedback loop solely by
rephrasing or repartitioning rules derived from the same evidence. New evidence
can still revise an interpretation and invalidate affected memory. Existing
jobs and receipts remain durable; the new input identity can cause one initial
interpretation before subsequent requests reuse it. Provider limits and memory
readiness requirements remain in force throughout that reconciliation.
</consequences>
