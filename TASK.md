# Nocheh implementation status

<current>

Last reconciled 2026-10-06. [SPECS.md](SPECS.md) defines the product;
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

Nocheh is pre-release. The operating local installation was previously verified
as one source-watched `make dev` Compose stack from the release session worktree,
with all 17 services healthy after the release checkout restart. Docker was
unavailable during part of the 2026-10-05 simulation; when the owner started
it, the existing CPA and several Honcho support services came up healthy while
the operating app, Hermes and Inngest remained stopped. Current full-stack
health is unverified. The earlier unexplained Inngest exit
remains recorded. The pinned native candidate includes empty-completion rejection; the
last verified TypeScript services include event-bound provider timings, dependency
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
  TypeScript compilation and the candidate image's runtime/test hashes pass.
  A seed-reusing real-model run passes reaction removal, the edited meeting
  time and private-to-group isolation on their first attempts in 118.2, 131.6
  and 89.4 seconds. Each answer has one correctly routed physical reply and a
  matching archived delivery. A fresh-topic case fails before delivery; these
  partial passes do not establish cold ingestion or complete model quality.
  [Capture checks](test/stores.test.ts).

  A read-only inspection of the isolated model fixture found that from
  2026-10-03 21:36 UTC, 78 new Honcho memory-context artifacts contained only
  eight distinct content hashes. All 78 guard sources remain pending, with no
  staged guard revision, fragment, or guard publication. Detector admissions
  rose from 2-8 to 31-60 per minute at that boundary, before the operating
  provider container stopped at 22:09 UTC. The fixture scheduler recorded
  worker-capacity errors during the same period. These observations locate the
  stall before guard publication but do not prove the first detector failure's
  cause. Positive provider and first-attempt ready-memory verification remain
  pending. On 2026-10-05 the local Docker socket was absent; no fixture or
  operating container was changed. Aggregate evidence is in ignored fixture
  state; [history](docs/task-history.md) retains the observation.
  A relay candidate now records a separate, content-free result for each
  admitted request: admission number, upstream header/error category, HTTP
  status, and time to headers/error. Eleven networkless checks pass, including
  provider HTTP and transport failures without credential/body leakage. This
  diagnostic cannot recover outcomes for the 2,665 earlier admissions; the
  coupled fixture results are recorded below. [Relay](tools/acceptance/model_relay.py),
  [checks](test/test_model_relay.py).

  With Docker restored by the owner, the 16-service fixture passed health
  startup, but 45 new model admissions included 33 upstream HTTP 503 and one
  HTTP 502 during a detector burst. The fixture was stopped with zero services
  left running. Two isolated benign route probes then received HTTP 200, so a
  healthy CPA socket and isolated success do not establish capacity under
  coupled load. The previously timed-out retirement event delivered one
  archived non-disclosing answer on one dispatch attempt after restart; its
  original timeout remains failed and this is not a fresh first-attempt pass.
  The owner Honcho generation is ready, but 81 generated memory contexts remain
  unguarded. A fixture-only detector pacing option has eleven networkless
  checks. With a five-second detector interval, the owner Honcho snapshot
  caught up and a fresh retired-fact question passed semantic non-disclosure
  on its first dispatch attempt in 64.2 seconds: one physical reply, matching
  archived delivery, all three independent named sources retired, originals
  preserved, guard on, and `limited_memory=false`. The watched paced run's 114
  model outcomes all reached upstream HTTP 200 headers. All sixteen fixture
  services are stopped with state preserved. This does not prove unthrottled
  provider reliability; the cause of the earlier 503 burst and cold full-quality
  rehearsal remain pending.
  A subsequent unused-topic question failed on its first Hermes attempt with
  `model_unavailable`. During its retry window the provider returned 769 HTTP
  429 results, all on detector calls. The workflow ultimately delivered one
  non-disclosing reply in the correct topic on attempt 16, about 69 minutes
  after the question, with one archived original and one outbound receipt.
  This fails the first-attempt and latency gates. The fixture is stopped and
  preserves the original failure. The relay now blocks further upstream
  admissions during a restart-safe bounded cooldown after HTTP 429; eleven
  networkless relay checks pass; a twelfth check confirms that a late success
  from an already-running request cannot clear the cooldown. Coupled cooldown
  behavior remains unverified;
  a fresh-topic first-attempt recheck was then run after provider recovery.
  After provider recovery, a different unused topic passed the focused
  first-attempt and timing gates in 176.4 seconds. One physical reply reached
  topic 18, its delivery was archived, and its text contained neither the
  forbidden other-topic time nor the private synthetic name. The watched run
  and shutdown interval recorded 41 new upstream HTTP 200 outcomes and no 429.
  All sixteen fixture services are stopped, while the operating provider remains
  healthy. This result does not erase the failed topic-17 attempt, exercise the
  cooldown under an actual 429, or establish unthrottled reliability.
  [Procedure](docs/telegram-simulation.md).

  A fresh current-source, isolated 16-service fixture then completed all six
  cold real-model quality cases on their first Hermes dispatch attempts. Each
  produced one physical and archived reply within the five-minute gate;
  bounded semantic review passed reaction removal, correction, private and
  topic isolation, restart recall, and non-disclosing retirement. The two
  captured retired originals were preserved. Honcho was attached and verified,
  but the answer at retirement had `limited_memory=true`, so this is not a
  ready-memory deletion pass. After all 57 ingestion receipts finished, owner
  and topic generations remained building. The shared monthly embedding ledger
  had $4.998666 reserved under its unchanged $5 cap, leaving $0.001334; thirteen
  Honcho queue errors matched budget rejection. The owner correctly noted that
  reported spending was about $0.12: 4,829 successful October embeddings had
  $0.118666 in settled holds, while 488 HTTP 502 embedding outcomes retained
  $4.88 in conservative holds. Of those failures, 457 occurred within about
  eight minutes with 28-309 ms durations, indicating a fast upstream failure
  and repeated attempts rather than a $4.88 provider invoice. A fresh
  ready-memory question was therefore not issued, and neither the cap nor
  historical holds were changed.

  This fresh run also exercised the relay cooldown against actual provider 429s:
  218 upstream HTTP 200 outcomes and three HTTP 429 outcomes were recorded.
  Subsequent admissions waited at least 60 and 120 seconds, respectively; a
  previously admitted request finishing successfully after the first 429 did
  not clear the cooldown. The safety monitor stopped the fixture at its third
  429; a later Honcho-only inspection left all fixture services stopped with
  state preserved. This verifies the bounded fixture relay under those observed
  429s, not unthrottled provider reliability or operating activation. The
  content-free summary and full synthetic receipts remain in ignored local
  acceptance state. [Procedure](docs/telegram-simulation.md),
  [runner](tools/acceptance/model_rehearsal.py),
  [relay](tools/acceptance/model_relay.py).

  The Honcho egress candidate now persists a shared, exponential 60-second to
  one-hour cooldown after paid embedding 5xx outcomes. Blocked calls return
  HTTP 503 with numeric `Retry-After` before making a new spending reservation;
  a later admitted success clears the cooldown, while an older in-flight success
  cannot. Reasoning is unaffected. Failed admissions remain recorded; the
  accounting candidate below separates which holds count against the cap. Thirteen focused
  meter checks pass, including transport failure, restart, HTTP response and
  late-success ordering. This source candidate has not been activated in the
  operating installation or the previous cold fixture image. The existing
  October holds blocked ready-memory work under the prior accounting.
  [Decision](docs/adr/0100-durable-embedding-egress-cooldown.md),
  [checks](services/honcho/test_meter.py).

  The owner rejected increasing the $5 embedding cap and requested accurate
  accounting. The candidate keeps every admission record, releases confirmed
  HTTP-error holds, retains transport/unfinished/unreported holds, and labels
  historical errors whose response type was never recorded. On a read-only
  SQLite backup of the operating ledger, repeated migration produced the same
  result: $0.118666 counted toward the unchanged $5 cap, $4.881334 headroom,
  and $4.88 of original monthly error holds released from cap accounting but preserved
  as unverified exposure. Old pilot holds remain counted. This is not a provider invoice. The operating ledger
  and running services were not changed. A fresh fixture run, provider billing
  comparison, and operating activation remain pending.
  [Decision](docs/adr/0102-separate-embedding-error-holds-from-spending.md),
  [meter checks](services/honcho/test_meter.py).

  The pinned Honcho queue counts processed-with-error items as completed. A
  Nocheh generation previously checked only zero pending/in-progress work, so
  terminal derivation errors could falsely advance readiness. The candidate
  now checks a read-only, workspace-scoped failure boolean before marking ready;
  failed work keeps `honcho_derivation_failed` visible and invalid health cannot
  advance the generation. The isolated Honcho API returned true for an existing
  failed synthetic workspace and false for an empty one, with deriver and Hermes
  stopped; no embedding or model admission was added. Nineteen focused Python
  checks pass; the pinned Linux Node 24 build passes and affected compiled Node
  tests have five passes and four database-fixture skips. Coupled Nocheh readiness
  and a fresh successful derivation remain pending. Terminal upstream failures
  require a new evidence-preserving generation; restarting the worker alone does
  not retry its processed-with-error items.
  [Decision](docs/adr/0101-honcho-terminal-queue-errors-block-readiness.md),
  [API check](services/honcho/test_provenance.py),
  [Nocheh check](test/store-native-memory.test.ts).
  A no-network runtime overlay for this locally integrated source is cached as
  `sha256:3aa964edbc2f6cca8f81de023a641bc563e4b5cd9128ec39990092d7a6b691ac`;
  its compiled readiness file matched the worktree byte-for-byte. The full
  offline Dockerfile build stopped at apt DNS before producing an image. The
  overlay has not run as a fixture or operating service; its preparation receipt
  remains in ignored local state.

  A focused quality-runner window can stop after the selected scenario without
  injecting later restart or retirement questions. Invalid ordering is rejected
  before opening a fixture. Six networkless runner checks pass. This prepares an
  unused-topic recheck; the first attempt failed, and the later focused topic-18
  recheck passed as recorded above.
  [Runner](tools/acceptance/model_rehearsal.py),
  [checks](test/test_model_rehearsal.py).

  Foreground Honcho recall now requires completed evidence beyond the current
  question. Background context still learns the first source; older receipts
  and independent history remain usable. Four checks pass without skips,
  including three PostgreSQL checks for access, guarded recovery and the new
  question-only boundary. TypeScript compilation passes. Coupled real-model
  verification of this candidate is pending.
  [Decision](docs/adr/0099-independent-evidence-for-historical-recall.md),
  [checks](test/store-native-memory.test.ts).

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
  The deterministic fixtures use internal networks and synthetic state; the
  authorized model fixture adds only its scoped relay to the existing provider
  network, without a public port or another OAuth owner. The operating
  seventeen services retained their identities, start times and healthy state
  at that observation. No operating activation, real Telegram traffic or new
  live acceptance pass is claimed. Actual model quality and the existing same-topic
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
- A native diagnostic candidate retains only bounded Python error type and
  function-stage identifiers in a failed dispatch receipt. Exception messages
  and provider bodies are excluded, and the asynchronous public receipt still
  exposes only its generic error code. Nine networkless gateway/receipt checks
  pass in a source-verified local Hermes image. This cannot reconstruct the
  missing type from earlier failed receipts; the candidate is not yet exercised
  in the coupled model fixture.
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

Current isolated evaluation status: the synthetic 16-service fixture is stopped;
the operating gateway is healthy. The operating database recovered with the
tested wrapper after 81 seconds of WAL replay, and the existing Inngest server
became healthy eight seconds after startup. App and security recovered without
recreation. The owner authorized restoring the missing local tag for the
revision-checked running Hermes image; the sandbox launcher recovered in five
seconds without a container restart. All 17 operating services are healthy at
this checkpoint. The owner authorized the existing model route,
additional fixture reasoning requests, a parallel fixture, and a gateway-only
restart, then explicitly authorized gateway-only source activation. No Telegram
production traffic or release activation is authorized by those checks. The
shared embedding ledger has the outcome-aware schema and retains every prior
call under the unchanged $5 cap. The active gateway now mounts the corrected
main source through an ignored one-service Compose override. Its local authenticated
report counts $0.149799 toward the $5 cap, shows $4.88 of unverified historical
error holds separately, and leaves a $4.850201 admission balance; no paid
request was used for this check. All other operating container IDs stayed fixed.
A future `make dev` from the other session's older source may replace this
override and revert the gateway, so coordinate source reconciliation before
restarting the operating stack. Exact synthetic receipts and identifiers remain
in ignored local state.

The owner first authorized starting only the two existing stopped containers.
The database repeated its prior exit after about 48 seconds of WAL replay;
Inngest was not started on that attempt. The old wrapper's 300 fast readiness
polls sent a smart shutdown before recovery could complete. After two focused
tests and an offline byte-verified image overlay, the owner explicitly authorized
pruning only unused Docker build cache and recreating only the database with
the same named volume. All build cache was removed without changing images or
volumes. Only the database container ID changed; it became healthy after 81
seconds, and the existing Inngest container was started afterward. No volume
reset occurred. The host had about 1.0 GiB free after recovery, so free space
is a current operating risk and additional paid/mock traffic should wait.
The isolated-turn launcher had failed before opening its health port because
`nocheh-hermes:local` was absent. After an explicit owner authorization, that
tag was restored from the running Hermes image whose upstream revision matches
the lock. No isolated-turn container was orphaned and no service was recreated.
The owner then authorized clearing only four regenerable host caches (uv,
Puppeteer and two updater caches). Those exact caches were removed; free space
rose from about 1.0 to 4.2 GiB, and all 17 operating services stayed healthy.
Monitor disk headroom during any focused fixture run; full-stack health and
this cleanup alone do not establish personal-use release.

A focused synthetic same-topic reaction recheck has not issued a question yet.
The resumed 16-service fixture was healthy and left all operating container IDs
unchanged, but the topic-7 generation stayed building through a 360-second
readiness wait. Its 21 ingestion receipts were done; native Honcho still had
four pending derivation units and no terminal error for that workspace. The
fixture was stopped with state preserved. Read-only native queue inspection
showed three pending representation units, one pending summary, one pending
webhook and no active worker session for topic 7; other synthetic workspaces
also have backlog. No new embedding 5xx was observed during that wait. This
is an unrun reaction-quality gate, not an answer pass or failure. Drain the
synthetic queue with disk and provider-error bounds before asking again.

The owner authorized the existing model route for the synthetic Telegram
evaluation. A fresh isolated fixture uses scoped read-only client keys through
the existing provider, without another login or refresh owner. Its Honcho meter
uses the authoritative shared spending ledger. After its 1,500 monthly reasoning
attempts were consumed, the owner authorized 200 additional fixture requests,
then all additional requests needed for this evaluation. The temporary fixture
started with a shared ceiling of 1,700 and currently uses 4,000 for this fixture;
it does not reset accounting, alter the $5 embedding cap, or change the
operating configuration. The relay's restart-safe admission journal has an
explicitly authorized configurable allowance (seven admission/HTTP checks pass);
this fixture currently allows 10,000 admissions and retains all prior entries.
Real Hermes/Honcho evaluation remains in progress. Four first-attempt cases
pass for reaction removal, corrected time, private isolation and private recall
after a Hermes restart. A fresh isolated topic receives a correct, single physical
reply with an archived causal link, but workflow completion exceeds the 300-second
gate; the earlier fresh-topic attempt fails before delivery. The current-question
only Honcho peer exclusion has focused PostgreSQL evidence and the fresh-topic
answer shows no other-topic disclosure, but neither failed timing gate is a pass.
A later unused-topic recheck passed in 176.4 seconds on one attempt after provider
recovery; the intervening topic-17 run failed first attempt and reached delivery
only on attempt 16 after a prolonged HTTP 429 period. The 429 cooldown and
unthrottled provider reliability remain unverified in coupled traffic.
A later retirement question first fails with `assistant_runtime_unavailable`,
then physically receives a non-disclosing answer on retry. Honcho also returned the synthetic name while a separately captured,
still-active assistant reply stated the same fact. This observation alone does
not establish reuse of the retired owner message. The fixture-only oracle now
explicitly retires every captured private source containing that synthetic name
before its next question; five focused runner checks pass. Hermes' parent
turn limit is 230 seconds while its Honcho recall request allowed 615; a bounded
foreground recall candidate passes 30 checks in its verified pinned Hermes
image; coupled timing remains open. The resumed fixture starts all 16 services
within its unchanged health gate while all 17 operating container IDs stay fixed.
A focused retirement recheck explicitly retires three independent synthetic
sources, preserves the originals, and delivers one causally archived,
non-disclosing first-attempt reply in 233 seconds. That answer is limited-memory
evidence: all 26 Honcho ingestion receipts for the new owner generation are done,
and none reference the retired sources or contain the synthetic fact. The
Honcho derivation queue later drained and the owner generation became ready.
A fresh ready-memory question failed on its first Hermes attempt during guarded
context preparation; its second attempt delivered one non-disclosing reply and
the workflow completed. That is not a first-attempt pass. A second fresh question
timed out after 300 seconds before any Hermes attempt because guarded source
preparation failed. After a host-wide Docker stop, the isolated fixture had been
restarted while its selected operating provider route remained stopped; the relay
admitted repeated detector requests despite that unavailable upstream. The
fixture is now stopped with its state preserved, with 2,665 retained admissions
of its 3,000 allowance. A relay health/admission candidate fails closed when its
existing provider socket is absent; seven focused tests pass. The actual fixture
relay returns HTTP 503 with that route stopped, then stops cleanly without a
poller or model request. The ready-memory
semantic and first-attempt gates were open at that checkpoint, and the earlier
context-preparation failure still needs a route-available reproduction. The
operating stack was stopped at that checkpoint.
The runner now binds replies to both chat and message, retains pending source
identities before waiting, and stops after a failed case. Four focused checks
pass for late/unrelated replies, cross-chat message-number reuse, duplicate
physical sends and invalid continuation rejected before fixture access. Existing
seeds can be reused with their original evidence; a selected continuation records
omitted cases and requires a previously unused topic for cold-audience isolation;
this does not repeat the cold capture measurement. Earlier reaction and
correction failures later delivered factually correct replies on attempts four
and three; their original timing and first-attempt gates remain failed. The
first fixture restart exceeded its health deadline before a health-only retry
succeeded. A fixture-only 30-second health-probe cadence subsequently passes the
unchanged startup gate; Docker load was observed at 61.76 before and 22.41 later
on eight CPUs. This does not establish a sole cause for the response failures.
Detailed attempts, source identities and native tool evidence remain in ignored
state. Infrastructure checks do not establish model quality, and operating
activation remains separate.

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
5. Preserve the new cold six-case pass and coupled 429 cooldown observation
   alongside the topic-17 first-attempt failure, attempt-16 late reply, topic-18
   pass, prior retirement outcomes, and all original receipts. The fresh cold
   retirement answer used limited memory. A subsequent fresh-topic generation
   reached ready, answered a synthetic fact on its first attempt with
   `limited_memory=false`, then rebuilt after every independent source of that
   fact was retired. A new first-attempt answer from the ready generation omitted
   the fact and expressed uncertainty with `limited_memory=false`; both replies
   were physically sent once and causally archived. The isolated fixture is
   stopped with all state and receipts preserved. Its accidentally internal
   embedding-egress network caused three new fast transport 502s; a repaired
   gateway reached the paid endpoint and subsequent embedding calls succeeded.
   The fixture preflight now rejects this network error and unintended external
   bridges. The shared ledger migrated in place without resetting calls or
   raising the $5 cap; historical error holds remain visible. The authorized
   gateway-only source override activated the corrected meter, and the active
   gateway's read-only budget report verifies cap headroom. Reconcile the other
   session's development source before any future full-stack restart; that older
   Compose configuration can remove the override. Unthrottled provider
   reliability and operating release acceptance remain separate gates.

</pending>
