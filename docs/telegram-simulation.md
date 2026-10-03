<telegram_simulation>

# Personal-use simulation

<scope>

The rehearsal evaluates the requirements in [SPECS.md](../SPECS.md) using synthetic
conversations. The deterministic fixture never uses an installation's bot, source
data, credentials, provider login, volumes, or background workers. The separately
authorized real-model variant below shares only the selected provider route and
its authoritative accounting. Current outcomes and unresolved
gates belong in [TASK.md](../TASK.md); dated reports stay in ignored
`data/acceptance/results/telegram-simulation/`.

The native layer uses the pinned Hermes adapter and python-telegram-bot with
synthetic Bot API transports. The coupled HTTP fixture runs actual native polling,
the three PostgreSQL stores, Nocheh workflows, Hermes and Honcho. Component tests
also substitute selected runtime/Honcho responses. Scripted inference tests
integration contracts and failure handling, not language-model intelligence or
real provider quality. Real subscriptions, transcription quality, embeddings,
and production recall retain their [separate gates](release-acceptance.md).

</scope>

<telegram_contract>

The transport follows the official [Bot API](https://core.telegram.org/bots/api):
JSON success/error envelopes, acknowledged polling offsets, explicit reaction
subscriptions, topic routing, message responses, and retry parameters. See
[getUpdates](https://core.telegram.org/bots/api#getupdates),
[sendMessage](https://core.telegram.org/bots/api#sendmessage), and
[reaction updates](https://core.telegram.org/bots/api#messagereactionupdated).
Unknown methods fail the test instead of silently succeeding. The HTTP fixture
returns parsed text for escaped plain MarkdownV2; unmodeled rich markup is an
explicit failed gate. Rich native formatting and chunk behavior also have their
separate component scenarios. The fixture cannot model
Telegram delivery outages, permissions or undocumented behavior exhaustively.

</telegram_contract>

<scenario_matrix>

| Scenario family | Observable requirement | Primary automated coverage |
| --- | --- | --- |
| Capture and outages | Fsync before acknowledgment; duplicate updates, revisions and control-store failure lose no originals | `test_capture.py`, `test_telegram_http_fixture.py`, `archive.test.ts`, `stores.test.ts` |
| Native Telegram delivery | Persian/emoji and long replies retain routing; replay adds no send; rate-limit waits and bounded retries preserve receipts; Markdown rejection and lost replies retain the audience | `test_telegram_simulation.py`, `test_capture.py`, `test_gateway.py`, `store-telegram-dispatch.test.ts` |
| Access and topics | Owner/private, granted/denied participants, General and named topics remain distinct; stale capabilities fail closed | `test_scopes.py`, `assistant.test.ts`, `store-retrieval.test.ts` |
| Files and voice | Original bytes and hashes survive download/transcription failures; generated transcripts are separate; blank speech is terminal | `store-preparation.test.ts`, `worker.test.ts`, `test_speech_gateway.py` |
| Guarding | Literal masking preserves other content; owner edits survive; stale representation has no original fallback; bounded concurrent publication drains failed work and checkpoints more than 500 small fragments in separate batches | `store-guards.test.ts`, `store-prepared-context.test.ts`, `test_boundary.py` |
| Retirement and edits | Retired sources/reactions leave future retrieval; pending delivery stops; originals and confirmed sends remain | `store-source-retirement.test.ts`, `test_exact_predecessor.py` |
| Reactions and conventions | Changes/removals invalidate stale meaning; anonymous counts and missing context stay uncertain; learning stays silent | `store-reaction-retrieval.test.ts`, `store-learning-engine.test.ts` |
| Honcho ingestion | One writer; uncertain writes reconcile by receipt; rebuilds and owner corrections preserve evidence | `store-native-memory.test.ts`, `store-workflows.test.ts` |
| Recall and entities | Current scoped memory, bounded paths, attribution, owner names, merged identities/Undo and corrected or retired facts survive automatic refresh; no private names or provenance leak | `store-entities.test.ts`, `store-entity-owner-corrections.test.ts`, `store-relationships.test.ts`, `store-native-memory.test.ts` |
| Sharing | Complete approved wording and whitespace, compatible historical hashes, concurrent exact receipts and expiration conflicts, atomic follow-up staging, current grant/fact checks at delivery, interrupted-handoff recovery, confirmed one-time consumption, expiry and revocation; project membership grants no access | `store-memory-followup.test.ts`, `store-memory-access.test.ts`, `store-sharing.test.ts`, `store-projects.test.ts` |
| Knowledge organization | Exact delegated scope and capture watermark; deferred atomic application, owner review, revocation and checked undo; imported authority stays inactive | `store-knowledge-management.test.ts`, `store-owner-supervision.test.ts`, `knowledge-portability.test.ts`, `test_knowledge_tools.py` |
| Actions and tools | Live owner authority; exact chat/topic proposal; current means the source topic; deny/revoke and deleted-topic fallback block delivery; uncertain effects never repeat | `store-telegram-actions.test.ts`, `test_telegram_simulation.py`, `store-controlled-execution.test.ts`, `test_controlled_tools.py` |
| Scheduling and browser | Stable identities, locks, cancellation and reconnection; missed schedules do not silently replay | `store-scheduled-runs.test.ts`, `store-browser-runs.test.ts`, `test_scheduler.py` |
| Workflow recovery | Independent capture, bounded admission, durable native review handoff, isolated native lease recovery under the profile lock, outbox and protected completion receipts | `store-workflows.test.ts`, `workflow-store.test.ts`, `test_review_handoff.py`, `test_native_leases.py`, `test_workflow_recovery.py` |
| Imports and portability | No historical replies; explicit learning consent; safe extraction and source identity; corrections preserved | `store-imports.test.ts`, `store-source-portability.test.ts`, `store-portable-bundle.test.ts` |
| Provider and budgets | Scoped routes, guarded attempts, conservative durable reservations and separate reasoning limits | `services/honcho/test_meter.py`, `test_honcho_budget.py`, `provider-oauth.test.ts` |
| Operations and recovery | Inactive restores, quiescence, single authority, data/credential ownership, reset accounting | `test_store_recovery.py`, `test_reset_*.py`, `test_live_dev.py` |

Python filenames without a directory refer to `services/hermes/`; TypeScript
filenames refer to `test/`. Host-only checks are identified separately in reports.
Passing one family is not proof that every combination of failures is covered.

</scenario_matrix>

<execution>

Use a dedicated session worktree, immutable cached image IDs verified against
the upstream pins, and a uniquely named fixture Compose project. The
[storage fixture](../deploy/acceptance/stores-compose.yml) has its own volume and
an internal network without published ports. Do not combine it with the operating
Compose file. Native tests use no network and a temporary Hermes home.

The separate [workflow fixture](../deploy/acceptance/inngest-compose.yml) uses a
one-shot workflow database bootstrap, then the pinned Inngest and Redis services.
It never starts an application process with administrator credentials. Its
product pipeline, host-import, privacy and checkpoint probes use synthetic
runtime responses and preserve permanent effect identities across failures and
engine restart. The [native Honcho fixture](../deploy/acceptance/native-portability-compose.yml)
checks actual pinned migrations, ORM records, vector data and inactive transfer
without calling a provider or starting a deriver.

The [complete installation rehearsal](../tools/acceptance/rehearsals/installation-rehearsal.py)
connects the pinned native services using new synthetic state and deterministic
inference transports. It requires its own verified images and the repository's
single-stack ownership preflight; component passes do not substitute for this
coupled run. Actual provider reasoning and conversational recall require separate
evidence even when the scripted installation rehearsal passes.
Use `--prepare-only` to render and retain the dedicated manifest, synthetic state
and owned empty volumes before starting any service. Preparation and Compose
validation are distinct from execution and cannot pass the installation gate.

The [HTTP Telegram extension](../tools/acceptance/telegram_rehearsal.py) reuses an
owned prepared installation. Its [Bot API fixture](../tools/acceptance/telegram_mock.py)
persists queued updates and delivery receipts. The
[transport bootstrap](../tools/acceptance/telegram_runtime.py) changes the network
destination only after the unchanged mandatory request boundary; native capture,
SDK parsing, policy checks and delivery remain active. Only the exact synthetic
token can use that redirect. Native fallback-IP discovery is disabled, and the
gateway lock uses the fixture's own writable state when cached-image and host
user IDs differ. No public port or external network is added.

Run `python -m tools.acceptance.telegram_rehearsal --directory <prepared-directory>`
after that installation is running. It recreates only its provider and Hermes
services, preserving state; `--verify-only` skips those setup changes. Timestamped
reports retain each attempt, including startup and protocol failures. The ordinary
private/topic/General reply checks, exact archived originals and causal delivery
receipts, unselected-chat silence and restart receipts
are separate from the ingestion/browser rehearsal. Parallel execution beside an
operating stack requires the owner's explicit single-stack exception.

Select `--scenario faults-and-files` to exercise a documented `429` response and
one transient `getFile` failure. The run checks the physical retry delay and exact
topic, both durable send receipts, one confirmed reply, a second attachment
retrieval attempt, and the original binary bytes/hash. Its synthetic file includes
the provider fixture's literal canary; inference outside detection must never see
that raw value. Fault/file controls are bounded and reject invalid changes before
mutating the saved fixture state.

Compile the current worktree with Node 24 before running its tests. Run storage
tests sequentially because several use the same synthetic schema. Record test
names, passes, failures, skips, image IDs, source revision, commands and elapsed
times. Preserve failed runs before repairs. A skipped fixture-dependent test is
pending until its separate fixture succeeds; a green process exit is insufficient.

After a repair, rerun affected behavior and adjacent contracts. Integrate verified
increments under the shared Git lock without activating the operating services.
Carry unrelated evidence forward with its original revision and limitations.

</execution>

<real_model_evaluation>

Use the [model relay](../tools/acceptance/model_relay.py) only after explicit
authorization to use an existing model route. Its fixture client keys are
distinct from the read-only scoped keys used upstream. It owns no OAuth files,
login or refresh process. Only the selected chat-completions endpoint is
forwarded; Telegram requests stay in the local mock. A durable, content-free
journal defaults to 300 model attempts across restarts. An explicitly authorized
increase uses `NOCHEH_FIXTURE_MODEL_REQUEST_LIMIT` together with
`NOCHEH_ADDITIONAL_MODEL_REQUESTS_AUTHORIZED=1`; the fixture boundary accepts at
most 10,000 admissions and retains every earlier journal entry. Honcho still
requires its production preparation callback and the existing shared spending
ledger; a fresh fixture ledger must never reset real spending or request limits.
An explicit owner exception may increase the allowance in the synthetic
fixture's meter process while retaining the same shared counter and embedding
dollar cap. Record that temporary authorization and ceiling in ignored fixture
evidence; do not change operating policy or reset the ledger.

The [quality runner](../tools/acceptance/model_rehearsal.py) collects synthetic
reaction-removal, correction, private/topic isolation, restart recall and
retirement cases. It correlates incoming updates by their captured source key:
a reaction's message ID identifies its target, not its update. Delivery checks
require one first-attempt reply with a matching chat, replied-to message and
archived receipt. The runner saves the pending source before waiting and stops
on a failed case, so later replies cannot be confused with new questions. The
handoff-ready observation does not establish completion of guarded preparation.
After inspecting earlier pending executions, `--reuse-seeds` can use an existing
seven-source observation from the same fixture without capturing duplicate
facts. Such a run records the original seed evidence and is not a new cold
capture or ingestion measurement. Saved answers
remain pending semantic review against ground truth; successful delivery alone
cannot pass recall. Budget exhaustion or degraded memory must be recorded as a
limitation rather than substituted with scripted reasoning. These observations
do not authorize operating activation or pass real Telegram release gates.

</real_model_evaluation>

</telegram_simulation>
