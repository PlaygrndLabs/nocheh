<telegram_simulation>

# Personal-use simulation

<scope>

The rehearsal evaluates the requirements in [SPECS.md](../SPECS.md) using synthetic
conversations. The deterministic fixture never uses an installation's bot, source
data, credentials, model providers, volumes, or background workers. Current outcomes and unresolved
gates belong in [TASK.md](../TASK.md); dated reports stay in ignored
`data/acceptance/results/telegram-simulation/`.

The native layer is Nocheh's own Telegram service (`nocheh-telegram`) on
python-telegram-bot with synthetic Bot API transports. The coupled HTTP fixture runs
its actual polling and sends, the three PostgreSQL stores, Nocheh workflows, Hermes
and Honcho. Component tests
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
| Access and topics | Owner/private, members who talk or are paused or switched off, members' private chats and the owner's ask about one, strangers, General and named topics remain distinct; stale capabilities fail closed | `test_scopes.py`, `assistant.test.ts`, `store-retrieval.test.ts`, `members.test.ts`, `store-members.test.ts` |
| Files and voice | Original bytes and hashes survive download failures; voice notes are transcribed before their reply, or archived with a status without a key | `store-preparation.test.ts`, `store-reprocessing.test.ts`, `store-voice-transcription.test.ts`, `worker.test.ts` |
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
| Operations and recovery | Inactive restores, quiescence, single authority, data/credential ownership | `test_store_recovery.py`, `test_reset_*.py`, `test/test_live_dev.py` |

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
the owner freedom setting, which still shows a card for each post to a group,
a fixed reply to someone who may not talk in a group, replies only when addressed in a group,
unselected groups and members, retirement, a voice note
transcribed before its reply that does not hold the next message, a photo read by the vision tool, an ordinary file with a caption, an owner-private schedule that fires on its
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
`[[recall:q]]`, `[[owner:view]]` and `[[action:destination|text]]` request that real tool and
answer from its actual result; `[[context:marker]]` reports whether a marker
appears anywhere in the request except the current turn (`[[context_split:left|right]]`
looks for `leftright`, so a probe of a member's mark from the owner's chat never
names the mark whole, neither in the owner's message nor in the answer), `[[notes:marker]]`
whether it is in the Hermes native notes the model sees; `[[long:n]]`,
`[[silent]]` and `[[empty-once:key]]` produce long, `[NO_REPLY]` and one blank
answer. `[[turn:marker]]` reports whether a marker appears in the current turn
(unaddressed group messages travel there), `[[tool:mcp__nocheh__x {json}]]` calls any
Nocheh tool (Hermes's name for Nocheh's MCP tool `x`) with those arguments (also `memory`, `todo_list` and a job box's
Hermes tools) and `[[after:silent]]` makes the answer after a
tool call `[NO_REPLY]`. The brain reads a Nocheh tool's own result inside the
`{"result": ...}` envelope Hermes's MCP client puts around it. `[[usage:n]]` makes each scripted answer in that turn
report `n` prompt tokens; the fixture's reply rates (`NOCHEH_FIXTURE_REPLY_RATES`,
read only with `NOCHEH_INSTALLATION_FIXTURE=1`) price them, so a background
job's cost limit can be reached. `[[delay:s]]` makes each scripted answer in that
turn wait `s` seconds (1 to 90), so a scenario can act while a job runs; the
answer's event is recorded before the wait. When the current turn is a job's
resume line (`The job was interrupted and restarted.`), the directives come from
the newest earlier user message that has one, the job's first message, and its
tool results so far count, so the resumed run goes on where it was. The brain
also records, once each, `{"directive":"notice","kind":"cost"|"time"}` when a
tool result of the directive turn carries a cost or time notice,
`{"directive":"resume","results":n}` for a resumed run (`n` tool results before
the resume line) and `{"directive":"restart","todo":bool,"earlier":n}` for a
fresh restart (whether it names the last to-do list, and the messages before it).
Other model traffic keeps the deterministic behaviour above. The mock's
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
kept fixture and `--skip-existing` runs only the product scenarios. A failed
run first saves every container's state and log under `logs/`, and removal
covers every container of the fixture's Compose project. When the start
itself fails, its logs are kept in `full-<time>-first-start/` and one fresh
start is tried; the report names the containers that stopped. The owner
allowed it to run beside the live installation (2026-10-26): it never reads the
live state, credentials or volumes and never stops the live stack.

The fake Telegram plays every person. It stores inline keyboards, edits cards
with `editMessageText`, and answers `answerCallbackQuery` only for button
presses the tester injected, so approval cards are pressed like a phone would;
it keeps the link an answer opens, as for **Answer privately**. Its `leaveChat`
records the call and then reports the bot's own status change in a
`my_chat_member` update, as Telegram does; a positive chat ID gets 400 and a chat
the bot already left gets 403, which the bot counts as left and records as
`already_left`. Updates the fake sends on its own get IDs that are
not multiples of ten, which the tester's own IDs are. `getUpdates` delivers only
the update kinds the bot asks for. When Telegram connects, the owner adds Nocheh
to the fixture's three groups and answers each card **No project**
([ADR-0253](adr/0253-only-the-owner-adds-nocheh.md)), so two can share a project
while the third stays in none.
Scenarios name a chat by its Nocheh id, which the tester finds by the chat's
Telegram id in the owner's chat list (`Fixture.chat`), never by building one
([ADR-0252](adr/0252-chats-get-nochehs-own-ids.md)): the three groups keep their Telegram ids as
ids, while a topic first seen during the run, and NG1 (`NEW_GROUP`), a group
first seen after the install, have digest ids. The owner adds Nocheh to NG1
(`owner_adds`), and it then answers, reads its group from a topic and holds a
task (`new_id_group_works_end_to_end`); it sits in P1 for the
privacy probes and for `project_groups_stay_apart`, where its own answer reads
only NG1 and the private answer reads it too.
`supergroup_upgrade_keeps_history` injects Telegram's `migrate_to_chat_id` and
`migrate_from_chat_id` messages for a basic group: the supergroup stays the same
chat, with both Telegram ids, its project, its task and its switch, and a search
there finds what was said before the upgrade. A second basic group, which the
owner adds at the same time and no other scenario posts in, is found upgraded by the
owner's refresh instead (the fixture answers its old id with
`migrate_to_chat_id`): the refresh moves it onto the new id at once, keeps the
old one, asks again under the new id and sends nothing.
Product scenarios cover members, addressing by name, unaddressed
messages shown once to the next reply, the fixed reply for people who may not talk there,
approval cards with Approve and Reject in private chat, same-group posts,
member cards in their own group, owner review when the member is switched off
in the destination, owner group-to-own-private-chat, group-to-group cards,
hide and unhide carrying the conversation, reactions keeping the group name,
learning reaching Honcho, Inbox person cards (one per new name, none for the
owner), a Telegram Desktop export with a topic, a file and learning, tasks
from chat with a reminder, status and board, tasks staying out of unrelated
groups, two groups of one project staying apart while **Answer privately**
sits only under the owner's own answer, refuses a member's tap and answers the
owner's `/start` from both groups but not the third (its probe mark rides an
unaddressed message just before the question, so no search hit or private
answer holds it), defaults (history kept forever, Notion off), and a Settings save whose
apply a reload sees running and that ends with a result. Who adds Nocheh: a
member's, a stranger's and an anonymous admin's add each leave with one
`leaveChat`, with one line to the owner only for the member and the anonymous
admin; a member's second add the same day leaves with no second line; a leave
Telegram refuses stays silent as Couldn’t leave; a removal from a group that is
on tells the owner once; the owner's add is on at once, with one card whose
buttons each work; and a group that is off is turned on and off through
`/v1/chats/state`. Members ([ADR-0260](adr/0260-members-in-groups.md)): the tester
sets them up through the owner's Members routes behind the dashboard proxy,
adding each by Telegram user ID and sending only the switches that differ, and
the member scenarios check that no container restarted. They cover the owner
adding a member on the dashboard, who then talks at once; a member switched off
in one group and a paused member, who get the same fixed reply as a stranger,
once a day per group (these, and the stranger's fixed reply and a member added
by ID and then switched off, each ask as a person new to the fixture, so a second
run on the same UTC day still sees the reply); a member's web page read without a
card; read-only tasks; posting to other groups turned off
(`member_post_not_allowed`); a member who
left a group and is no longer reached there; four member jobs in one day, with
no daily count; a member over a low daily message cap, who gets the limit reply
once; and posts made in a chat's own name, which get nothing. Member private chat ([ADR-0262](adr/0262-member-private-chat.md)): the fake
Telegram answers `getChatMember` from what it has shown of each person in each
group. The scenarios cover a member in groups of two projects and a group of
none, who reads all three privately and nothing else, lists tasks one project at
a time (asked without one, the tool names the two lists), cannot open a task of a
group they never joined or the owner's, and cannot add one or post to a group
(`member_private_chat_reads_joined_groups`); group talk off, which leaves private
chat on (`member_private_chat_with_group_talk_off`); a paused member and one with
private chat off, who get the fixed private reply once a UTC day and are answered
again at once when switched back on
(`member_private_chat_off_or_paused_gets_fixed_reply`); the daily cap shared with
group turns, with the private limit reply
(`member_private_over_the_daily_cap`); the owner and a member never running as each
other's profile (`owner_and_member_never_swap_profiles`); MEMBERMARKs in a
member's message, Nocheh's reply, a note planted in the member's profile and in
an unpruned ask profile, which never show in a group's read, another member's
chat, the owner's turns, Honcho, long-term memory, Inbox suggestions, grants,
sharing previews or learned facts, while the member's own search finds them
(`member_private_chat_stays_with_the_member`); the owner asking about that member,
answered in a separate message, after the asking turn's own reply, that quotes
only that member's chat and is then gone from the owner's next turn and recall
(`owner_asks_about_a_member`); a member's
chat refused as a sharing rule's source (`member_chat_is_never_a_sharing_source`);
and the re-check: a member removed while Nocheh missed the service message is no
longer read there, one still in is read and the check recorded, no answer changes
nothing within 30 days, and past 30 days the group is not read
(`member_private_chat_rechecks_old_presence`). The sweep
`private_canaries_never_left_the_owner` also checks that a member's marks never
left that member's chat, except in the answer to the owner's ask. Before an add that expects a line, the tester moves earlier
sent leave notes about other groups out of the last 24 hours, so earlier runs on
a kept fixture never fill the cap on all lines; the group's own notes stay, so
its own cap still holds. Dashboard calls sign
in through the preview relay like the browser
([client](../tools/acceptance/owner_dashboard.py)). The
[page check](../tools/acceptance/dashboard_pages.mjs) runs in the
[tester browser image](../deploy/acceptance/browser.Dockerfile), Playwright's
own image and Chromium build for both architectures, on the fixture network and fails a page on a missing heading, an uncaught error, a console
error, an owner API answer of 500 or more, or an error alert.

Build the browser image once with `docker build -t nocheh-tester-browser:local
-f deploy/acceptance/browser.Dockerfile deploy/acceptance`. On a development
machine pass `--build`: the development stack runs its own source-watched
images, so the installation's `:local` images can be older than the checkout.
`--build` builds the checkout's services, management, store, Hermes and box images
under `:tester` tags, refreshes the browser image, and tests those; the live
tags are never rebuilt. Honcho keeps the installation's pinned image. Scripted answers
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
