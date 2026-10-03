# Nocheh implementation status

<current>

Last reconciled 2026-10-03. [SPECS.md](SPECS.md) defines the product;
[AGENTS.md](AGENTS.md) defines working instructions. [Task history](docs/task-history.md)
retains completed increments and earlier observations. The
[MVP acceptance register](docs/mvp-acceptance-status.md) records live gates and
reasons for carrying historical evidence forward.

Agent-led knowledge management is implemented and verified locally. Organization
delegation starts disabled, has exact conversation scopes, respects owner
corrections, and applies saved proposals atomically after foreground work finishes.
Receipts, explicit resumption, revision-checked undo, and inactive portable history
are preserved. Typed runtime tools and the existing consented learning result feed
the organization workflow, including learning publication recovery.
[Decision](docs/adr/0091-bounded-agent-knowledge-organization.md),
[authority/application checks](test/store-knowledge-management.test.ts),
[owner read checks](test/store-owner-supervision.test.ts),
[inactive restore checks](test/knowledge-portability.test.ts),
[runtime checks](services/hermes/test_knowledge_tools.py),
[learning checks](test/store-learning-engine.test.ts).

Activity Decisions provides complete server totals and exact-item links across
approval families. Projects exposes delegation and preserved organization history;
Projects and Sharing use the stored named-conversation selector. Context separates
addressing, knowledge access, and external actions from organization. Overview
distinguishes connection, synchronization, and usable memory. TypeScript and
dashboard builds, affected Node 24/PostgreSQL suites, 85 native checks, and all
33 dashboard checks pass. Synthetic desktop, phone, keyboard, deep-link, stale
proposal dismissal, and retained-draft interactions are verified. The explicit
Docker security boundary passes in the simulation session's separate host fixture.
No deployment, operating
delegation, or live-memory-readiness claim is made; existing recall failures and
the sanitized-history remote-publication gate remain open.
[Dashboard checks](test/dashboard-supervision.test.mjs),
[synthetic preview](test/dashboard-supervision-preview.mjs).

Nocheh is pre-release. The operating local installation runs one source-watched
`make dev` Compose stack from the release session worktree. All 17 services are
healthy after the release checkout restart. The earlier unexplained Inngest exit
remains recorded. The pinned native candidate includes empty-completion rejection; the
running TypeScript services include event-bound provider timings, dependency
patches, and protected workflow receipt reconciliation. The prior source checkout
and its three local edits remain preserved.

Honcho is attached and verified as primary memory; historical ingestion is off.
Earlier four-generation readiness was a dated observation. Current generations
are rebuilding after automatic learned-rule replacements advanced the guard epoch.
Saved repeated interpretation inputs had unchanged source observations and
changed learned rules. The verified repair deduplicates automatic rule guidance
by its original prepared dependencies while retaining owner revision changes and
full model context. [Decision](docs/adr/0082-evidence-based-learning-deduplication.md).
Owner edits to guarded automatic guidance also enter that identity; five focused
learning/learned-memory checks pass. Operating reconciliation remains under
observation. The new same-topic recall answer failed despite correct topic routing.
The affected replacement generation has since reached readiness and produced a
usable matching snapshot, but another background interpretation later replaced
existing learned versions and revoked that generation. The focused conversational
recheck delivered one reply on attempt four after about twenty minutes; it did
not identify the removal. A later discovery-path check also failed after about
six minutes: it found a reaction handle but did not read its observation. Reply
assessment was performed through the CLI. Current inspection finds all four
generations building; the later sample has thirty-one current ingestion receipts
without a first attempt. Older pending receipts are separate historical state.

Guarded reaction observations and bounded target excerpts are active in discovery.
The compiled app bytes match the verified source, and an actual isolated native
turn used the verified packaged helper. Conversational recall remains failed.
The bounded background handoff is active. Long native-note reviews still occupied
its only background slot ahead of primary ingestion. A verified candidate now
gives due, unattempted current ingestion priority before starting new native
reviews. Operating compiled bytes now match that candidate, and three more
ingestion receipts completed. Current memory readiness remains pending.

Restarting the cached development database image reinstated an older, slow
workflow view. The tested view was reapplied under its owner role and catalog
verified; workflow health then completed in 0.8 seconds with nine connected
worker families. A rebuilt database image preserves the corrected schema and
installation generation across an isolated fresh start and restart. Recreating
the operating database from that image is still pending. Development has automatic
service restarts disabled and is not the unattended release configuration.

The existing embedding spending cap and subscription request safety limit remain
in force. The local provider route has one CPA login and one refresh owner. Native
auth is absent; no duplicate login or refresh worker was introduced.

The relationships and memory access UI now separates Explore, Review requests,
and Shared memory, with a list-first explorer, optional map, direct fact sharing,
and state-aware access explanations. The dashboard build and all 33 dashboard
checks pass; isolated synthetic browser checks cover desktop, phone, keyboard,
failed approval drafts, successful approval, sharing, and revocation. See the
[implementation](dashboard/pages/memory-map.tsx),
[access-state checks](test/dashboard-memory-access.test.mjs), and
[completed increment](docs/task-history.md). Operating activation remains pending;
this UI verification does not establish live recall or release readiness.

</current>

<verification>

- Personal-use Telegram simulation has passing native, storage, workflow,
  portability, host-isolation and provider-contract evidence across the
  [scenario matrix](docs/telegram-simulation.md). These are synthetic checks;
  [task history](docs/task-history.md) retains the original failures, repairs,
  revisions and carried evidence. Scripted inference does not establish model
  intelligence or actual provider quality.

  The latest byte-verified native/service candidate passes thirteen HTTP Bot API
  fault/file gates: cold-context first-attempt replies, physical `429` delay,
  exact topic and rejected/delivered receipts, one confirmed send, transient file
  recovery with original bytes/hash, denied-private silence and restart without
  duplicate sends. The separate ordinary run passes fourteen gates, including
  private, named-topic and General replies on their first attempts. It starts
  with two abandoned one-hour native leases: actual isolated startup reclaims
  both in the same profile, preserves every earlier message hash, and delivers
  the owner reply in 22.1 seconds. The exclusive profile lock, native fencing,
  current authority and original acceptance deadlines remain active.
  [HTTP runner](tools/acceptance/telegram_rehearsal.py),
  [SDK checks](services/hermes/test_telegram_http_fixture.py),
  [lease decision](docs/adr/0098-isolated-native-lease-recovery.md).

  Guard preparation publishes at most four independent copies concurrently,
  drains started work before releasing a failed audience queue, and checkpoints
  at most 500 fragments per detector batch. Three actual PostgreSQL checks pass
  without skips, including failed-sibling recovery and all 501 fresh fragments.
  The initial wrong-root container test record is disqualified; replacement
  checks verify runtime and test bytes before execution. Packaged source hashes,
  TypeScript compilation and the AST-only graph update pass. Five packaged
  native lease checks and eighteen adjacent native checks also pass.
  [Context checks](test/store-prepared-context.test.ts),
  [recovery checks](services/hermes/test_native_leases.py).

  Real-model observation found transport envelopes entering the same detector
  queue as their individual messages. Capture now preserves exact wire bytes,
  original records and recovery receipts without automatically preparing each
  envelope. Actual updates retain their preparation and dispatch workflows;
  unprepared retrieval still fails closed. Three storage/recovery checks and
  three adjacent preparation/generated-capture checks pass without skips.
  TypeScript compilation and the candidate image's runtime/test hashes pass;
  the coupled real-model timing and semantic recheck remains pending.
  [Capture checks](test/stores.test.ts).

  A fresh empty-state installation of the latest guard/lease candidate passes
  all nineteen coupled checks, including actual Honcho ingestion, silent
  convention/reaction learning, native browser work and outage memory recovery
  in 100.2 seconds under the unchanged five-minute gate. Its current generation
  is ready, all seven current ingestion receipts and five native reviews are
  done, and no guarded publication remains pending. Earlier nineteen-check
  evidence retains its original 54.7-second recovery observation. Durable native
  review handoff has 25 native and six PostgreSQL/workflow passes, with 47
  packaged native checks. All original failed runs remain recorded, including
  an unclassified early native exit; later passes do not explain it.
  [Installation runner](tools/acceptance/rehearsals/installation-rehearsal.py),
  [handoff decision](docs/adr/0097-durable-native-review-handoff.md).

  Consequential delivery, approval, memory-sharing and entity repairs retain
  their separate passing evidence: exact topics and live delivery authority;
  complete approved wording, atomic follow-ups and concurrent receipts;
  unstarted handoff recovery; owner names, merged identities, corrections and
  retired facts. The matrix and history link their focused and adjacent checks.
  The owner-authorized fixture uses only internal networks and synthetic state;
  the operating seventeen services retain their identities, start times and
  healthy state. No operating activation, real Telegram traffic or new live
  acceptance pass is claimed. Actual model quality and the existing same-topic
  recall failure remain open. Detailed reports stay in ignored
  `data/acceptance/results/telegram-simulation/` in the simulation worktree.

- Guarded reaction evidence now accompanies discovery with bounded target
  excerpts. Five storage/route/retirement checks and six networkless native
  archive checks pass; TypeScript compilation and the AST-only graph update
  pass. [Decision](docs/adr/0086-reaction-discovery-evidence.md). Operating source
  and actual isolated-child image verification also pass. Correct conversational
  recall remains unverified after this activation.

- Primary ingestion now receives its first attempt before a new native note
  review can take the background slot. Five workflow checks and one native-review
  recovery check pass with no skips. Pending review causes no native effect;
  receipt completion releases the prerequisite. Existing uncertain reviews retain
  their identity and reconciliation. Two initial fixture failures were corrected:
  the global sweep may include older synthetic jobs, and Honcho list responses
  must filter by the requested receipt. [Decision](docs/adr/0088-primary-ingestion-before-native-note-review.md).
  TypeScript compilation, the AST-only graph update and operating compiled-byte
  verification pass; current memory readiness remains pending.

- The October 2 General check has one captured message, one linked reply, and one
  execution attempt. The owner confirmed one sensible reply. Elapsed time was
  about 175 seconds, including about 133 seconds before the native execution
  receipt started and 41 seconds until completion. The model effect recorded
  2.2 seconds of broker preparation and 3.2 seconds of provider transport waits.
  Preparation completed about 51 seconds after capture, leaving about 82 seconds
  before the native receipt. These are elapsed workflow boundaries, including
  orchestration waits. Historical receipts lack finer preparation measurements,
  and workflow run timestamps are overwritten by later steps. Native phases
  overlap; they do not establish pure model compute time. The earlier timeout
  and recovered reply remain historical evidence.
- The trusted native parent now retains allowlisted timings and an explicit
  guard-change failure when authorization changes after child completion. It
  withholds the answer and session identity; fourteen focused process/timing/
  delivery checks pass. The guard-change reason also survives durable native
  and workflow receipts; nine async/delivery and two storage-dispatch checks pass.
  Missing measurements in older receipts remain missing.
- Archive reads now link a note to at most twenty currently captured reaction
  sources after access checks. The native tool retains guarded reaction changes,
  removals, and anonymous counts, and explains the all-word search behavior. Four
  storage/access/retirement checks and eight native archive/delivery checks pass.
  The operating CLI now links the saved older note to its removal; all seventeen
  services are healthy. This does not pass the live conversational recall gate.
- Archive search can discover bounded current reaction sources without message
  words or a target ID. Returned reaction and target handles retain topic,
  generation, supersession, and retirement checks; evidence is read through the
  guarded path and remains explicitly incomplete. Five storage/route checks and
  nine native archive/delivery checks pass, including a packaged-image check.
  [Decision](docs/adr/0084-scoped-reaction-discovery.md). The last live answer read
  one unrelated source and stopped; the conversational recall gate stays failed.
  The compiled operating lookup finds the saved removal and its older target
  under the original topic boundary; the pinned native source is verified.
- Automatic learned publications now wait while a current Telegram reply or
  leased managed reply is active. Saved reasoning and staged versions are reused
  after the wait; owner corrections and privacy revocations remain immediate.
  Five focused learning/workflow checks pass, including recovery and owner edits.
  [Decision](docs/adr/0083-defer-automatic-memory-publication-during-replies.md). This does not pass recall.
- Background admission now hands a free slot directly to one live callback
  waiting for at most one second. Sleeping retries cannot reserve idle capacity.
  Five workflow checks pass, including foreground capacity, bounded overflow,
  timeout without effects, exception release, supersession and durable receipts.
  [Decision](docs/adr/0087-live-background-admission-handoff.md) supersedes the
  earlier retry-order hint. Operating compiled-byte verification passes; current
  memory readiness remains pending. The scheduler's earlier unexplained exit is
  still retained.
- Owner workflow inspection now joins memory receipts by indexed identity. The
  old event-filtered query exceeded a five-second database deadline on a
  synthetic backlog; the repair and four adjacent workflow checks pass. The
  change preserves receipt/reconciliation links and source-event filtering.
  A later catalog check found that the operating database still used the old
  view despite compiled source. The exact tested view is now activated and
  catalog-verified; full CLI timing inspection succeeds in about 2.2 seconds.
  The earlier source-only verification did not establish database activation.
- The prior native candidate passed 380 networkless image checks and three host checks,
  including real container isolation. Twenty-one subscription compatibility
  checks passed. Thirty workflow regression checks passed; separate bootstrap
  and pinned-engine UI fixture cases remain explicit skips.
- Timing changes passed seven broker/security/storage checks, eleven admin CLI
  checks, and the TypeScript/dashboard build. The dependency patch build passed;
  npm reported zero known vulnerabilities at the recorded audit.
- Dashboard reload shutdown now closes stalled HTTP connections after a bounded
  grace period and still waits for admitted owner writes and lifecycle jobs. The
  regression reproduces the old hang; all four focused shutdown/maintenance checks
  pass on the repair. A one-time recovery of the already-stuck dashboard child
  restored the page after confirming no active workers.
- The learning repair passed four focused learning/entity checks and seven
  learned-memory/native-context/review checks. They cover generated paraphrases,
  changed model identities, new convention evidence, owner corrections,
  retirement, consent, durable results, and uncertain execution identity.
- Populated backup and inactive restore passed: 1,461 files, 88 owned-store table
  fingerprints, workflow fingerprints, and Honcho were verified. Restored bot,
  provider login, memory attachment, and executors stayed inactive. Restored
  containers are stopped; saved state remains preserved. The earlier disk-space
  failure and incomplete dumps remain recorded failures.
- Fresh provider chat, literal detector, and refresh-delegation checks passed.
  Persisted CPA refresh metadata predates successful current chat requests;
  expiration was not forcibly induced. September provider cutover and voice
  evidence is retained with its original dates and limitations. Speech source,
  dependencies, and login ownership did not change, so another voice note is
  not required solely by these increments.
- The acceptance report hashes are reconciled, including the later-updated topic
  report. Eleven earlier completed areas remain carried observations; General
  has new owner-confirmed evidence. Exact reports, revisions, and identifiers
  remain in ignored local state.

</verification>

<pending>

The owner authorized the existing model route for the synthetic Telegram
evaluation. A fresh isolated fixture uses scoped read-only client keys through
the existing provider, without another login or refresh owner. Its Honcho meter
uses the authoritative shared spending ledger. After its 1,500 monthly reasoning
attempts were consumed, the owner authorized 200 additional fixture requests,
then all additional requests needed for this evaluation. The temporary fixture
starts with a shared ceiling of 1,700 and can increase its own allowance as
needed; it does not reset accounting, alter the $5 embedding cap, or change the
operating configuration. Real Hermes/Honcho evaluation remains in progress for
reaction-removal recall, corrections/retirement, audience isolation and recall
after restart. The first reaction question exceeded its unchanged five-minute
gate; its pending execution and the subsequent already-captured correction
question must be reconciled before injecting more questions. No semantic pass
has been established.
The runner now binds replies to both chat and message, retains pending source
identities before waiting, and stops after a failed case. Three focused checks
pass for late/unrelated replies, cross-chat message-number reuse, and duplicate
physical sends. Existing seeds can be reused with their original evidence;
this does not repeat the cold capture measurement. Two previous executions ended
with runtime failures. The first fixture restart exceeded its health deadline
before a later health-only retry succeeded. A measured Docker load average of
61.76 on eight CPUs prompted a fixture-only probe cadence experiment (30 seconds,
with reply and startup deadlines unchanged); its effect remains under evaluation.
The fixture relay has four focused admission/HTTP checks, including restart-safe
limits, concurrency, streaming and error redaction. These are infrastructure
checks, not conversational quality passes. Operating activation remains separate.

1. Diagnose the October 2 same-topic recall failure using the saved event and
   CLI. One linked reply arrived on attempt two after about 384 seconds. It
   correctly avoided a completion claim but could not identify the removed
   reaction. Topic routing and the saved removal match; the native tools returned
   no matching long-term memory and archive search found only the new question.
   A background learned-rule replacement advanced the guard epoch during attempt
   one; the retry used a replacement generation with no ready context. Attempt
   one failed after about 182 seconds without native phase timings.
   Both outcomes are preserved. Focused reaction-retrieval and receipt checks
   passed. The focused rerun is also failed: one linked reply after four attempts
   did not identify the removal. Its failures include a model failure, a proven
   guard-context change during background learned replacement, and a generic
   runtime failure. Preserve the saved event and use its CLI/native receipts;
   do not request another copy or ask the owner to judge the answer. The scoped
   discovery repair has focused automated evidence; reconcile its operating
   source/image and current memory readiness before any further live check.
   The later discovery-path answer found one handle without reading the reaction;
   guarded observations and target excerpts now have focused candidate coverage.
   The discovery candidate is active and verified in an actual isolated child.
   Finish the primary-ingestion priority activation and memory readiness check
   before judging a new conversation.
2. Preserve the measured General timing boundaries and their limitations. The
   earlier 230-second native timeout is not explained by the short greeting or
   the later recall attempt; retain its failure evidence and the existing limit.
   Dependable answers take priority over speed. Use new receipts to diagnose
   future failures without inventing missing historical measurements.
3. Finish release evidence and runtime revision reconciliation against
   [release acceptance](docs/release-acceptance.md). Service health, Git integration,
   and historical readiness do not establish current recall or release approval.
4. Publish sanitized history only after the pending explicit one-time exception
   to the prohibition on force-pushing main. The isolated cleaned history has
   the same current source tree, removes historical private reports and known
   identifiers, and preserves original history locally. Remote fetch succeeded;
   origin/main is unchanged. Any additional source commits must be included in
   the final verified publication plan. Ordinary pushing would retain private
   historical material and remains blocked.

</pending>
