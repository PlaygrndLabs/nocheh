<telegram_simulation>

# Personal-use simulation

<scope>

The rehearsal evaluates the requirements in [SPECS.md](../SPECS.md) using synthetic
conversations. It never uses an installation's bot, source data, credentials,
provider login, volumes, or background workers. Current outcomes and unresolved
gates belong in [TASK.md](../TASK.md); dated reports stay in ignored
`data/acceptance/results/telegram-simulation/`.

The native layer uses the pinned Hermes adapter and python-telegram-bot with an
in-memory Bot API transport. The storage layer uses the real three PostgreSQL
stores and Nocheh workflow operations. Scripted model/Honcho responses test
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
Unknown methods fail the test instead of silently succeeding. It cannot model
Telegram delivery outages, permissions or undocumented behavior exhaustively.

</telegram_contract>

<scenario_matrix>

| Scenario family | Observable requirement | Primary automated coverage |
| --- | --- | --- |
| Capture and outages | Fsync before acknowledgment; duplicate updates, revisions and control-store failure lose no originals | `test_capture.py`, `archive.test.ts`, `stores.test.ts` |
| Native Telegram delivery | Persian/emoji and long replies retain routing; replay adds no send; rate-limit waits and bounded retries preserve receipts; Markdown rejection and lost replies retain the audience | `test_telegram_simulation.py`, `test_capture.py`, `test_gateway.py`, `store-telegram-dispatch.test.ts` |
| Access and topics | Owner/private, granted/denied participants, General and named topics remain distinct; stale capabilities fail closed | `test_scopes.py`, `assistant.test.ts`, `store-retrieval.test.ts` |
| Files and voice | Original bytes and hashes survive download/transcription failures; generated transcripts are separate; blank speech is terminal | `store-preparation.test.ts`, `worker.test.ts`, `test_speech_gateway.py` |
| Guarding | Literal masking preserves other content; owner edits survive; stale representation has no original fallback | `store-guards.test.ts`, `store-prepared-context.test.ts`, `test_boundary.py` |
| Retirement and edits | Retired sources/reactions leave future retrieval; pending delivery stops; originals and confirmed sends remain | `store-source-retirement.test.ts`, `test_exact_predecessor.py` |
| Reactions and conventions | Changes/removals invalidate stale meaning; anonymous counts and missing context stay uncertain; learning stays silent | `store-reaction-retrieval.test.ts`, `store-learning-engine.test.ts` |
| Honcho ingestion | One writer; uncertain writes reconcile by receipt; rebuilds and owner corrections preserve evidence | `store-native-memory.test.ts`, `store-workflows.test.ts` |
| Recall and entities | Current scoped memory, bounded paths, attribution and explicit identity decisions; no private names or provenance leak | `store-entities.test.ts`, `store-relationships.test.ts`, `store-native-memory.test.ts` |
| Sharing | Exact approved revisions, atomic follow-up staging, interrupted-handoff recovery, confirmed one-time consumption, expiry and revocation; project membership grants no access | `store-memory-followup.test.ts`, `store-memory-access.test.ts`, `store-sharing.test.ts`, `store-projects.test.ts` |
| Knowledge organization | Exact delegated scope and capture watermark; deferred atomic application, owner review, revocation and checked undo; imported authority stays inactive | `store-knowledge-management.test.ts`, `store-owner-supervision.test.ts`, `knowledge-portability.test.ts`, `test_knowledge_tools.py` |
| Actions and tools | Live owner authority; exact chat/topic proposal; current means the source topic; deny/revoke and deleted-topic fallback block delivery; uncertain effects never repeat | `store-telegram-actions.test.ts`, `test_telegram_simulation.py`, `store-controlled-execution.test.ts`, `test_controlled_tools.py` |
| Scheduling and browser | Stable identities, locks, cancellation and reconnection; missed schedules do not silently replay | `store-scheduled-runs.test.ts`, `store-browser-runs.test.ts`, `test_scheduler.py` |
| Workflow recovery | Independent capture, bounded admission, leases, outbox and protected completion receipts | `store-workflows.test.ts`, `workflow-store.test.ts`, `test_workflow_recovery.py` |
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

Compile the current worktree with Node 24 before running its tests. Run storage
tests sequentially because several use the same synthetic schema. Record test
names, passes, failures, skips, image IDs, source revision, commands and elapsed
times. Preserve failed runs before repairs. A skipped fixture-dependent test is
pending until its separate fixture succeeds; a green process exit is insufficient.

After a repair, rerun affected behavior and adjacent contracts. Integrate verified
increments under the shared Git lock without activating the operating services.
Carry unrelated evidence forward with its original revision and limitations.

</execution>

</telegram_simulation>
