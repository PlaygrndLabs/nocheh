# ADR-0128: Silent learning keeps valid items and closes on unusable results

<status>
Accepted on 2026-10-10 after the owner's development installation, running
Claude through Honcho, left seven silent-learning (`interpret`) jobs failed
after 9 to 10 attempts each, with hourly retries still scheduled. Keeping valid
items when one item is invalid is the default chosen for this fix; the owner
can overrule it. Extends 0056 and 0082.
</status>

<context>
Contextual learning saves Honcho's reasoning result under
`learning-result:<job>` before validating it, so a retry never asks the model
again. Validation rejected the whole result for any problem, and the workflow
treated those errors as retryable, so every retry re-validated the same saved
result and failed the same way. The dashboard showed failed workflows with
retries scheduled indefinitely.

The shapes of the seven saved results showed three causes:

- Three results were valid JSON inside a Markdown fence.
- Two results labelled direct claims with `relationship_kind` (or `null`)
  without an `object_entity_id`.
- Three results cited extra source IDs that were not in the prepared evidence,
  also as `quote.source_id`. Honcho messages carry `[nocheh:event:<id>]`
  markers, so its reasoning recalls IDs of earlier messages; one cited ID was a
  learned rule dependency's event without its prefix.

A model `relationship_kind` outside the allowed values reached a database
constraint instead of validation, and the native-review closing reason from
0124 was missing from the workflow data boundary.
</context>

<decision>

- The saved result is read as bare JSON, a Markdown-fenced JSON block, or the
  first complete JSON object carrying a requested section inside surrounding
  text. Unknown top-level sections still reject the whole result.
- Each interpretation, entity suggestion and entity claim is validated on its
  own. An invalid item is dropped; valid items from the same result are
  published. The job records each dropped item's section and validation code
  in `interpretation_jobs.rejected`; the saved result keeps the item itself.
  Items beyond a section's limit are dropped and recorded the same way.
- Optional model fields set to `null` mean the field is absent. A claim with an
  object needs an allowed relationship kind; a relationship kind on a claim
  without an object links nothing and is ignored, keeping the claim.
- The reasoning request lists the citable observation IDs and says that IDs
  recalled from memory or rule dependencies are not citable. An interpretation
  that still cites one is dropped, because its evidence would not cover the
  cited source's consent, guard and retirement dependencies.
- A result that is still unusable as a whole (`invalid_interpretation_result`)
  closes its `memory_review` workflow as `failed` with reason
  `invalid_model_output`. Provider, consent, guard and publication failures
  keep the normal retry path.
- No evidence check, scope check, quote check, attribution rule or conflict
  check is relaxed: an item that fails one is dropped rather than published.

</decision>

<consequences>
Jobs already failed by the old validation re-validate their saved result on
their next scheduled retry and complete if it now passes. A dropped item is
not retried; later messages can produce it again. The organization workflow
reads the saved result with the same parser.
</consequences>
