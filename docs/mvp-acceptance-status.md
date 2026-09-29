# MVP live acceptance register

<scope>

Last evidence review: 2026-09-29. These are saved observations from the fresh local
installation on September 28–29, not newly repeated tests. [TASK.md](../TASK.md)
tracks release blockers; [the procedure](release-acceptance.md) defines the gates.
The private index at `data/acceptance/results/mvp-live-test-register.json` maps
these rows to the original ignored reports. Exact timestamps, receipt IDs, source data, and
installation details belong in those private reports; this file is a
non-identifying summary. A pass records the stated behavior, not general
reliability or release approval.

</scope>

<checks>

| Check | Recorded result | Evidence established | Revisit when affected |
| --- | --- | --- | --- |
| Owner text | Passed | One linked reply; owner confirmed one sensible answer; later tool-policy candidate delivered on first attempt. | Reply dispatch, native tool registration, or delivery changes/failures. |
| Group silence | Passed | Captured note, completed intentional-silence decision, zero linked replies. | Group response policy or dispatch changes. |
| Private/group isolation | Passed | Group answer and 336 runtime contexts omitted the private phrase and source. | Scope, retrieval, sharing, or guard changes. |
| Voice | Passed with retry caveat | Original audio bytes/hash, separate subscription transcript, one source-linked reply. Delivery took five attempts before the tool-policy fix. | Speech route, audio capture/storage, transcript provenance, or voice dispatch changes. |
| Exact owner approval | Passed | Exact destination and text approved; one delivery; replay did not send again. | Approval authority, action identity, or delivery/replay changes. |
| Archive retirement and Undo | Passed | Original retained; later answer/context excluded retired content; Undo restored eligibility. Separate source retired before delivery stayed cancelled with zero replies. | Retirement/access rules, archive revisions, or cancellation changes. |
| Private recall and owner correction | Passed | Correct private recall; owner-authored learned revisions; completed Honcho projection; one correct owner-confirmed answer after correction. | Learning, correction, projection, or recall changes. |
| Restart recovery | Passed for captured pending turn | Runtime restarted after capture and before first execution; one reply and one receipt. Separate completed-turn durability also passed. Does not claim a restart during model execution. | Receipt identity, runtime recovery, dispatch, or supervision changes. |
| Populated backup and inactive restore | Passed on final snapshot | Checksums, 427 files, 88 table fingerprints; same operating containers resumed; restored authorities stayed inactive. Earlier failed resume attempts are retained. | Snapshot coverage, storage schema, restore, resume, or authority controls change. |
| Honcho live acceptance | Passed | Subscription reasoning, guarded embedding, ingestion, retrieval, restart persistence, provider failure/recovery; closed synthetic workspace; attachment and owner recall observed. | Honcho/provider routing, guarding, ingestion, budget enforcement, or memory state changes. |
| Non-owner reactions and named-topic isolation | Passed | Add/change/remove on an older note, correct actor/target/current state, no old-message reply; second named-topic answer/context excluded reaction evidence. | Reaction normalization/state, audience resolution, retrieval, or topic routing changes. |
| General-topic recovery | Delivery observed; answer quality pending | Existing markerless message resolved to base scope; original hash/projection unchanged; 109 assistant-context records excluded other-topic sources. First native attempt failed before delivery; the second completed with one linked reply. | Confirm the existing reply's content and investigate the first native timeout; no new owner message needed for delivery. |
| Same-topic reaction recall | Pending | One first-attempt reply arrived after 424.4 seconds and could not identify the old reaction. The topic generation had no ready snapshot then; it became ready later. Current rebuild has completed local ingestion while Honcho derivation remains queued. | Verify current topic readiness and snapshot, then assess only the affected recall behavior with existing evidence where possible. |

</checks>

<impact_review>

For the General-topic correction, new coverage is needed for markerless
supergroup messages and older full message projections previously classified as
unknown. That coverage passed 14 focused automated checks and live scope/archive
inspection. Private chat and explicit named-topic normalization retain their
branches; the focused access, retrieval, reaction, and dispatch checks passed.
Their prior live passes are carried forward. Voice transcription, exact approval,
backup/restore, and restart behavior have no relevant implementation change from
this correction. This review does not close the separate runtime reliability gate.

The reply-admission and Honcho-worker change has focused automated evidence only;
it is not active in the operating stack. It targets latency and initial memory
readiness. Prior reaction capture and named-topic isolation passes remain dated
passes because their normalization and audience rules did not change. Owner text,
voice, and General delivery remain dated observations; their timing and timeout
reliability are specifically open. No new owner traffic is justified while the
existing captured turns and current Honcho queue can be inspected.

The acceptance-record/policy update is documentation only and invalidates no live
pass. No new live traffic or runtime changes were performed for this review.
Future changes require their own impact entry; these reasons are not blanket
permission to carry all evidence forward indefinitely.

</impact_review>

<remaining>

1. Verify the current topic generation reaches ready and gains a snapshot; assess
   the affected same-topic recall and the existing General reply content.
2. Activate and measure the focused admission and deriver changes, then continue
   investigating model/guard time and the first General native timeout. Retain
   prior success evidence and verify only affected paths.
3. Finish release-candidate evidence/pin reconciliation, including the required
   provider refresh, quota/failure, and literal-detection evidence. The fresh
   Honcho checks cover part of this; they do not by themselves prove every
   provider-cutover criterion. Inspect retained evidence first and rerun only a
   missing or invalidated criterion. No provider cutover is authorized here.
4. Remove private material from reachable Git history and verify it before
   pushing. Remote synchronization remains blocked.

Historical ingestion is unapproved and is not required to repeat this test set.
The deliberate-reset journal validator is not applicable to the clean development
setup without that coordinator journal. Final release/activation remains separate
from local Git integration.

</remaining>
