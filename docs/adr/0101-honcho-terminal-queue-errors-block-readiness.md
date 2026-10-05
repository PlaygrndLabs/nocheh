# ADR-0101: Terminal Honcho queue errors block memory readiness

<status>
Accepted implementation decision. Extends the Honcho memory generation and
readiness boundary in [0044](0044-automatic-honcho-context.md) and the
provider-failure containment in [0100](0100-durable-embedding-egress-cooldown.md).
</status>

<context>
The pinned Honcho queue marks a task processed when it ends with a terminal
error. Its public queue status includes such tasks in completed counts. Zero
pending and in-progress work therefore does not prove successful derivation.
Nocheh must not publish a newly ready memory generation from failed work.
</context>

<decision>
Expose one authenticated, read-only, workspace-scoped boolean from Nocheh's
Honcho API extension: whether a terminal error exists for a processed
representation, summary or dream task. Return neither queue payloads nor error
text. Nocheh checks it alongside queue progress and its own ingestion receipts
before setting a generation ready. A failed queue keeps the generation building
with `honcho_derivation_failed`; an unavailable or malformed check cannot advance
readiness. Existing authorized context from an earlier ready revision remains
subject to its normal freshness and guard rules.
</decision>

<consequences>
Completed-with-error tasks cannot masquerade as ready memory. A failed
generation requires an explicit, evidence-preserving recovery or new generation;
the signal itself does not retry terminal Honcho work or relax the spending cap.
The API extension reads aggregate state only within its authenticated workspace.
</consequences>
