<telegram_simulation>

# Personal-use simulation

<scope>

The rehearsal evaluates the requirements in [SPECS.md](../SPECS.md) using synthetic
conversations. The deterministic fixture never uses an installation's bot, source
data, credentials, model providers, volumes, or background workers. Current outcomes and unresolved
gates belong in [TASK.md](../TASK.md); dated reports stay in ignored
`data/acceptance/results/telegram-simulation/`.

The native layer uses the pinned Hermes adapter and python-telegram-bot with
synthetic Bot API transports. The coupled HTTP fixture runs actual native polling,
the three PostgreSQL stores, Nocheh workflows, Hermes and Honcho. Component tests
also substitute selected runtime/Honcho responses. Scripted inference tests
integration contracts and failure handling, not language-model intelligence or
real provider quality. Real providers, embeddings, and production recall retain their [separate gates](release-acceptance.md).

</scope>

<telegram_contract>

The transport follows the official [Bot API](https://core.telegram.org/bots/api):
JSON success/error envelopes, acknowledged polling offsets, explicit reaction
subscriptions, topic routing, message responses, and retry parameters. See
[getUpdates](https://core.telegram.org/bots/api#getupdates),
[sendMessage](https://core.telegram.org/bots/api#sendmessage), and
[reaction updates](https://core.telegram.org/bots/api#messagereactionupdated).
Unknown methods fail the test instead of silently succeeding. The HTTP fixture
parses [MarkdownV2](https://core.telegram.org/bots/api#markdownv2-style) like
Telegram: it returns the plain text with bold, italic, underline, strikethrough,
spoiler, code, pre, link and block-quote entities, and rejects an unescaped
reserved character or an unclosed entity with Telegram's `can't parse entities`
wording, so the native plain-text fallback is exercised. Other parse modes are
an explicit failed gate. Rich native formatting and chunk behavior also have
their separate component scenarios. The fixture cannot model
Telegram delivery outages, permissions or undocumented behavior exhaustively.

</telegram_contract>

<scenario_matrix>

| Scenario family | Observable requirement | Primary automated coverage |
| --- | --- | --- |
| Capture and outages | Fsync before acknowledgment; duplicate updates, revisions and control-store failure lose no originals | `test_capture.py`, `test_telegram_http_fixture.py`, `archive.test.ts`, `stores.test.ts` |
| Native Telegram delivery | Persian/emoji and long replies retain routing; replay adds no send; rate-limit waits and bounded retries preserve receipts; Markdown rejection and lost replies retain the audience; a send never transmitted, for example during a polling reconnect, retries under a fresh attempt while a transmitted request with a lost response stays uncertain | `test_telegram_simulation.py`, `test_capture.py`, `test_gateway.py`, `store-telegram-dispatch.test.ts` |
| Access and topics | Owner/private, granted/denied participants, General and named topics remain distinct; stale capabilities fail closed | `test_scopes.py`, `assistant.test.ts`, `store-retrieval.test.ts` |
| Files and voice | Original bytes and hashes survive download failures; voice notes are archived with an extraction status and never hold a reply | `store-preparation.test.ts`, `store-reprocessing.test.ts`, `worker.test.ts` |
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
| Provider and budgets | Scoped routes, guarded attempts, conservative durable reservations and separate reasoning limits | `services/honcho/test_meter.py`, `test_honcho_budget.py` |
| Operations and recovery | Inactive restores, quiescence, single authority, data/credential ownership | `test_store_recovery.py`, `test_reset_*.py`, `test_live_dev.py` |

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
Stop a kept fixture with `docker compose -p <project> -f <directory>/compose.json
down`, without `--volumes`, so its networks are released while its volumes and
state remain. `make dev` also releases networks of stopped fixtures, which
otherwise exhaust Docker's address pools and stop the operating stack from
starting.
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
after that installation is running. It recreates only its `model-fixture` and
Hermes services, preserving state; `--verify-only` skips those setup changes. Timestamped
reports retain each attempt, including startup and protocol failures. The ordinary
private/topic/General reply checks, exact archived originals and causal delivery
receipts, unselected-chat silence and restart receipts
are separate from the ingestion/browser rehearsal. Parallel execution beside an
operating stack requires the owner's explicit single-stack exception.

Select `--scenario faults-and-files` to exercise a documented `429` response and
one transient `getFile` failure. The run checks the physical retry delay and exact
topic, both durable send receipts, one confirmed reply, a second attachment
retrieval attempt, and the original binary bytes/hash. Its synthetic file includes
the model fixture's literal canary; inference outside detection must never see
that raw value. Fault/file controls are bounded and reject invalid changes before
mutating the saved fixture state.

The [personal-use scenario runner](../tools/acceptance/telegram_scenarios.py)
extends the same owned HTTP installation after `telegram_rehearsal` has run:
`python -m tools.acceptance.telegram_scenarios --directory <prepared-directory>`
(`--only <scenario>...` selects a subset). Each scenario is recorded separately
and later scenarios still run after a failure; most use their own topic or chat
so one failure cannot hold another conversation's queue. Its first scenario
recreates the fixture endpoint, which loads current fixture code and makes the
native adapter reconnect polling while a reply is ready. Families covered:
polling reconnect, edits and reactions over polling, General and named topics,
ordered bursts, chunked long replies, intentional silence, blank answers,
owner-private archive search, model context and Honcho recall against group
and other-group isolation, literal guarding, exact Telegram approvals and
denials with stale fingerprints and repeated decisions, `current` destinations,
denied, unselected and granted/revoked participants, retirement, a voice note
archived without transcription that does not hold the next reply, an ordinary file with a caption, an owner-private schedule that fires on its
own cadence and waits for exact review before one delivery, deleted topics,
polling 5xx (measured after the adapter restarts polling), lost send responses,
a blocked bot, and restart. Two operations scenarios close the run: the
`./bin/nocheh storage` report and the Monitoring Storage operation must measure
every store, and `stage_timings` reads one breakdown per verified reply (no
content fields, stages summing to the reply time, rendered by `admin timings`)
and saves them with the p50/p95 summary in the report's `timings.json`. Before
the final lingering-turn check the runner waits for native memory reviews to
drain and records how long that took.

The model fixture's scripted brain acts only on an explicit directive in
the current user turn of a request that offers Nocheh tools: `[[search:q]]`,
`[[recall:q]]` and `[[action:destination|text]]` request that real tool and
answer from its actual result; `[[context:marker]]` reports whether a marker
appears anywhere in the request except the current turn; `[[long:n]]`,
`[[silent]]` and `[[empty-once:key]]` produce long, `[NO_REPLY]` and one blank
answer. `[[turn:marker]]` reports whether a marker appears in the current turn
(unaddressed group messages travel there), `[[tool:nocheh_x {json}]]` calls any
Nocheh tool with those arguments and `[[after:silent]]` makes the answer after a
tool call `[NO_REPLY]`. Other model traffic keeps the deterministic behaviour above. The mock's
`sendMessage` fault may set `parameters: {"deliver": true}` with a 5xx code:
the message is accepted but the bot observes only a gateway failure.
Directive-driven tool use tests pipeline, isolation and effects, not model
judgement.

Compile the current worktree with Node 26 before running its tests. Storage
tests share installation singletons such as guard state and audience policy,
so run them with `python3 -m tools.development.store_tests --project
nocheh-stores-<name> --image <development-target image>`: it resets the
synthetic cluster before every compiled test file and fails on any failed
file. Running every file against one shared database can fail intermittently. Record test
names, passes, failures, skips, image IDs, source revision, commands and elapsed
times. Preserve failed runs before repairs. A skipped fixture-dependent test is
pending until its separate fixture succeeds; a green process exit is insufficient.

After a repair, rerun affected behavior and adjacent contracts. Integrate verified
increments under the shared Git lock without activating the operating services.
Carry unrelated evidence forward with its original revision and limitations.

</execution>

<full_tester>

The [full tester](../tools/acceptance/full_test.py) runs every step above as one
command that needs nothing from the owner:
`python3 -m tools.acceptance.full_test [--keep] [--only <scenario>...]`. It
starts a new synthetic installation with a localhost dashboard relay, connects
the fake Telegram, runs the scenario list above and then the
[product scenarios](../tools/acceptance/product_scenarios.py), opens every
dashboard page in a browser and writes `report.md` and `result.json` with
plain-English check names under `data/acceptance/results/full-<time>/`. It
removes the fixture afterwards unless `--keep` is given; `--directory` reuses a
kept fixture and `--skip-existing` runs only the product scenarios. The owner
allowed it to run beside the live installation (2026-10-26): it never reads the
live state, credentials or volumes and never stops the live stack.

The fake Telegram plays every person. It stores inline keyboards, edits cards
with `editMessageText`, and answers `answerCallbackQuery` only for button
presses the tester injected, so approval cards are pressed like a phone would.
Product scenarios cover allowed members, addressing by name, unaddressed
messages shown once to the next reply, the fixed reply for people not allowed,
approval cards with Approve and Reject in private chat, same-group posts,
member cards in their own group, owner review when the member is not allowed
in the destination, owner group-to-own-private-chat, group-to-group cards,
hide and unhide carrying the conversation, reactions keeping the group name,
learning reaching Honcho, Inbox person cards (one per new name, none for the
owner), a Telegram Desktop export with a topic, a file and learning, tasks
from chat with a reminder, status and board, tasks staying out of unrelated
groups, and defaults (history kept forever, Notion off). Dashboard calls sign
in through the preview relay like the browser
([client](../tools/acceptance/owner_dashboard.py)). The
[page check](../tools/acceptance/dashboard_pages.mjs) runs in the
[tester browser image](../deploy/acceptance/browser.Dockerfile) on the fixture
network and fails a page on a missing heading, an uncaught error, a console
error, an owner API answer of 500 or more, or an error alert.

Build the browser image once with `docker build -t nocheh-tester-browser:local
-f deploy/acceptance/browser.Dockerfile deploy/acceptance`. Scripted answers
test Nocheh's wiring and rules, not model judgement; Telegram's official test
environment is a later step.

</full_tester>

<real_model_evaluation>

The `model-fixture` service is configured as an ordinary custom provider and
answers deterministically. For real-model memory cases, after the Telegram
rehearsal and the scripted scenarios run `python3 -m tools.acceptance.model_rehearsal
--directory <fixture> --upstream <private file>`. Relay mode stays on for that
fixture, so the scripted scenarios refuse to run until its saved
`compose.before-model.json` is restored. The file is owner-authorized, mode 0600, outside
tracked source, and names `chat` and optional `embeddings` providers as
`{"url": "https://…", "key": "…"}`. The fixture model service then relays chat,
model-list and embedding requests there with only the authorization replaced;
it alone joins an egress network, every other fixture network stays internal,
and an unguarded secret canary is refused outside the secret check. Cases cover
reaction removal, a corrected fact, private isolation, memory shared across a
group's topics, isolation between groups, recall after restart and a retired
fact. Saved answers remain pending semantic review against ground truth;
successful delivery alone cannot pass recall, and the run is not live
acceptance; see [release acceptance](release-acceptance.md).

Before claiming a ready-memory pass, verify the current Honcho workspace has no
terminal processed-with-error derivation items as well as no pending work. A
zero-pending queue status alone counts errored items as completed in the pinned
Honcho version. A failed workspace requires a new evidence-preserving generation;
restarting its worker does not retry terminal items.

</real_model_evaluation>

</telegram_simulation>
