# MVP live acceptance register

<scope>

Last evidence review: 2026-10-02. Most observations remain dated September 28–29;
the General greeting, same-topic recall attempt, and populated backup/inactive
restore have new October 2 evidence. Carried observations are not newly repeated tests. [TASK.md](../TASK.md)
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
| Populated backup and inactive restore | Passed on final snapshot | October 2 snapshot: 1,461 files, 88 owned-store table fingerprints, workflow and Honcho verified; restored authorities stayed inactive. Prior backup failures remain recorded. | Snapshot coverage, storage schema, restore, resume, or authority controls change. |
| Honcho live acceptance | Passed | Subscription reasoning, guarded embedding, ingestion, retrieval, restart persistence, provider failure/recovery; closed synthetic workspace; attachment and owner recall observed. | Honcho/provider routing, guarding, ingestion, budget enforcement, or memory state changes. |
| Non-owner reactions and named-topic isolation | Passed | Add/change/remove on an older note, correct actor/target/current state, no old-message reply; second named-topic answer/context excluded reaction evidence. | Reaction normalization/state, audience resolution, retrieval, or topic routing changes. |
| General-topic recovery | Passed focused October 2 greeting | One execution and one linked reply; owner confirmed one sensible answer. About 175 seconds total; measured provider transport wait about 3.2 seconds. Earlier scope preservation and recovered timeout remain dated evidence. | Investigate local waiting and retain the earlier timeout; do not repeat this greeting solely for a new commit. |
| Same-topic reaction recall | Failed October 2 answer | Correct topic and captured removal verified. The first answer arrived after two attempts and about 384 seconds. The focused repaired-path rerun arrived after four attempts and about twenty minutes. Neither identified the removal; completion caution remained present. Earlier outcomes and all attempts remain retained. | Diagnose existing event, memory availability and tool retrieval before requesting further traffic. Owner delegated answer inspection to the CLI. |

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

The reply-admission and Honcho-worker change has focused automated evidence and
owner-authorized activation in the operating stack. The app watcher compiled the
verified source; only the Honcho deriver was recreated with two workers. All 17
services are healthy, and all four current generations reached ready with a
snapshot each. This does not establish a faster live reply or corrected same-topic
answer. Prior reaction capture and named-topic isolation passes remain dated
passes because their normalization and audience rules did not change. Owner text,
voice, and General delivery remain dated observations; their timing and timeout
reliability are specifically open. No new owner traffic is justified while the
existing captured turns and saved Honcho readiness evidence can be inspected.

Empty model completion validation passed 16 focused synthetic checks in the
pinned Hermes runtime, including real native Telegram adapter/receipt handling
with a mocked Bot API transport. Blank answers produce a pre-delivery failure,
the same attempt reuses its receipt, a new successful attempt sends once, and
explicit `[NO_REPLY]` remains intentional silence. This changes classification
of invalid completed model results; it does not relabel any earlier live
outcome. The candidate was activated on October 2 after the broader native suite passed. Existing successful-delivery and
silence observations retain their original dates; the October 2 ordinary General greeting completed on its first attempt and the owner confirmed its quality.

The October 2 timing candidate adds nullable, content-free numeric measurements to
security effect receipts and an event-filtered owner inspection command. Seven
focused broker/security/storage checks and eleven CLI checks passed; the build
passed. It does not change provider payloads, audience checks, approval authority,
or delivery decisions. Prior dated passes remain preserved. October 2 activation, General timing
measurements, populated backup, and inactive restore are now recorded.

The October 2 workflow repair preserves protected effect receipts when an older
source generation is superseded after an operation. Thirty focused workflow
checks pass; the separate bootstrap and pinned-engine UI fixture checks were not
enabled. Existing delivery identities and Telegram replay code are unchanged.
Observe affected Honcho/memory workflow reconciliation after activation; no new
owner approval, reaction capture, or voice input is justified by this repair.

The October 2 learning repair changes only completed-job deduplication: automatic
rule guidance contributes original prepared dependencies, while owner guidance
contributes its exact revision and text. Full rules and conflicts still reach the
model. Four focused learning/entity checks and seven related memory checks passed.
Prior capture, voice, approval, and isolation evidence is carried because those
boundaries are unchanged. Observe current memory reconciliation and require the
still-open same-topic answer; the prior limited answer cannot establish recall.

Fresh provider chat, detector, and refresh-delegation checks passed. Persisted
refresh metadata and later successful chat support current provider operation;
expiry was not deliberately forced. Twenty-one provider failure/quota checks
passed in the pinned native fixture. Historical voice evidence remains applicable
because speech source, dependencies, and refresh ownership are unchanged.

The October 2 dashboard shutdown repair was reproduced with a partial HTTP
request and verified with four focused shutdown/maintenance checks. Disconnected
clients no longer hold reloads open indefinitely; admitted owner operations still
finish before process exit. Backup fencing and progress access remain covered.
This does not change Telegram delivery, source storage, or memory authority and
does not justify repeating their live acceptance.

Owner edits to the guarded copy of an automatic rule now invalidate completed
learning reuse, as owner-authored rule revisions already do. The regression
failed on the previous candidate; five focused learning/learned-memory checks
and the build pass on the repair. This retains the automatic paraphrase
deduplication and existing owner-authority requirement. It does not establish
live memory quality or justify repeating unaffected live checks.

The archive-reaction repair links a permitted note to bounded current captured
reaction sources, preserving removal and anonymous-count distinctions in the
native tool. Four storage/access/retirement checks and eight native archive and
delivery checks pass. The first fixture run had a synthetic identity mismatch; a
subsequent reused fixture retained a project assignment. Both failed setup runs
are retained, followed by the passing clean fixture. Topic isolation, guarded
owner edits, retirement, and superseded-state denial have fresh focused coverage.
Live recall remains failed pending a correct answer after the relevant repair.

The trusted-parent timing repair retains allowlisted durations when a completed
child loses authorization before delivery. The answer and session identity are
withheld, and the receipt keeps an explicit guard-change failure. Fourteen
process/timing/delivery checks pass. Earlier generic failures and absent timing
measurements remain unchanged; the fix cannot retroactively prove their cause.
The operating CLI confirms the archive repair links the saved note to its removal,
and all seventeen services are healthy. Conversational recall remains unpassed.

The acceptance-record/policy update is documentation only and invalidates no live
pass. No new live traffic or runtime changes were performed for this review.
Future changes require their own impact entry; these reasons are not blanket
permission to carry all evidence forward indefinitely.

The follow-up receipt repair preserves the allowlisted guard-change reason through
native async recovery and owned dispatch storage, without retaining answer text.
Nine native async/delivery checks and two storage-dispatch checks pass. This does
not reinterpret the older generic failure or satisfy the conversational recall gate.

The affected replacement topic generation subsequently reached readiness and
produced a usable matching snapshot. The focused repeat delivered one linked
reply on attempt four after about twenty minutes. CLI assessment found no
recognition of the removed reaction; completion caution remained present. The
second attempt was revoked by a background learned replacement from another
source. Both failed conversational outcomes and all attempt receipts are retained.
No further owner traffic is requested.

The General workflow completed preparation about 51 seconds after capture and
started native execution about 82 seconds later. Historical receipts do not
isolate preparation work from orchestration waits. The workflow run timestamp
is updated on later steps and cannot establish first admission.

Owner workflow-list inspection failed during the rerun. A populated synthetic
regression reproduced the expensive receipt join, exceeding its five-second
database deadline. Joining by indexed receipt identity passes that check and
four adjacent workflow checks without changing source-event filtering.

Automatic learned publication now waits for admitted replies under the same
guard binding, retaining saved reasoning for retry. Five focused learning and
workflow checks passed, including immediate owner correction, expired managed
leases, and revoked Telegram bindings. Recall remains failed; no new live pass
is claimed by this scheduling repair.

Current reaction discovery now returns bounded permitted reaction and target
handles without requiring message words. Five storage/route and nine native
archive/delivery checks pass; the immutable native package also passes its six
archive checks. Existing audience and retirement rules are reused, with explicit
return-time checks. Prior live capture and isolation observations retain their
dates, supported by the focused privacy regressions. The last live answer read
one unrelated source and stopped; this retrieval repair does not turn that answer
into a pass or establish conversational recall on the new candidate.

The workflow-list repair initially reached compiled source without replacing
its operating SQL view. A later catalog inspection verified the old disjunctive
receipt join; its timeouts remain failures. The already-tested view was applied
in a bounded transaction under the database owner role and its actual definition
was verified. Full CLI timing inspection then succeeded in about 2.2 seconds.
This is an observed inspection duration, not a controlled latency benchmark.
Native attempt receipts and event-bound provider measurements remain distinct;
background work can share an event reference, and overlapping phases are not summed.

Background admission now preserves a bounded retry order. Three focused checks
cover overtaking, foreground capacity, exception release, and abandoned waiters;
the old code fails the ordering regression. Durable Inngest identity, provider
limits, and source/guard policy are unchanged. This is a scheduling repair for
observed ingestion starvation, not evidence of a ready memory snapshot or a
successful conversational answer. The compiled operating repair is verified;
a later health check found Inngest stopped while the other sixteen services were
healthy. Recovery and current memory readiness remain pending.

</impact_review>

<remaining>

1. Resolve the failed October 2 same-topic recall from its saved CLI trace and
   tool results. Preserve the first failed execution and the delivered limited
   answer; neither establishes correct recall. The General greeting is passed.
2. Measure the focused admission and derivation changes from existing runtime
   evidence when possible. Continue
   investigating model/guard time and the first General native timeout. Retain
   prior success evidence and verify only affected paths.
3. Finish release-candidate evidence/pin reconciliation, retaining provider
   refresh, quota/failure, and literal-detection evidence and its stated limits. The fresh
   Honcho checks cover part of this; they do not by themselves prove every
   provider-cutover criterion. Inspect retained evidence first and rerun only a
   missing or invalidated criterion. No provider cutover is authorized here.
4. The cleaned history is prepared with an identical current tree. Await the
   explicit one-time force-with-lease exception, reconcile later source commits,
   and verify before publication. Remote synchronization remains blocked.

Historical ingestion is unapproved and is not required to repeat this test set.
The deliberate-reset journal validator is not applicable to the clean development
setup without that coordinator journal. Final release/activation remains separate
from local Git integration.

</remaining>
