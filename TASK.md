# Nocheh implementation status

<current>

Last reconciled 2026-10-09. [SPECS.md](SPECS.md) defines the product;
[AGENTS.md](AGENTS.md) defines working instructions. [Task history](docs/task-history.md)
retains completed increments and earlier observations. The
[MVP acceptance register](docs/mvp-acceptance-status.md) records live gates and
reasons for carrying historical evidence forward.

Owner architecture review (2026-10-09), plan only, no code changed: memory is
swappable with Honcho as the current long-term memory; Inngest orchestrates the
full Nocheh workflow with Hermes and Honcho as parts of it, without changing
Hermes' internal workflow; slowness is diagnosed per stage with workflow,
third-party and LLM time separated; uncontrolled storage growth is re-examined
in every component; one reasoning provider and model is enough for the MVP.
These are recorded in [SPECS.md](SPECS.md). The failing recall gate is in Honcho
memory: Nocheh's per-generation workspaces were revoked by unrelated guard-epoch
advances, a non-standard usage the owner rejected. The owner accepted
[ADR-0109](docs/adr/0109-standard-honcho-entity-model.md) on 2026-10-09 and
authorized steps H1 to H4 of its [plan](docs/honcho-standard-memory-plan.md).
They are implemented in source on a branch
([decision](docs/adr/0115-honcho-session-revisions.md),
[Honcho memory checks](test/store-native-memory.test.ts),
[workflow checks](test/store-workflows.test.ts)): one Honcho workspace per
installation, versioned sessions per conversation, entity evidence and learned
interpretation, targeted session rebuilds instead of per-epoch re-ingestion,
live session context read on arrival and prefetched when Honcho finishes work,
and session allowlists for group and topic recall. On 2026-10-10 the owner's
development machine development installation ran the fresh start (H5) and live acceptance
(H6) on the Claude provider; see item 7. [Stage timing, storage growth and Inngest findings](docs/operations-review-plan.md)
list the gaps with code references.

Retired sources now leave Hermes' own stored history. The real-Claude simulator
run found an owner-private answer repeating a fact 30 seconds after every source
of it was retired: Honcho memory and archive search had dropped it, but Hermes
replayed its native session history. Before each turn the Hermes service now
rewrites that profile's stored rows for retired messages, their turn's tool work,
answers that were themselves retired, tool results citing a retired source and
later compaction summaries; owner native recall skips the same rows read-only.
Each withheld row keeps its place as a placeholder saying it was retired and
naming the retired message or reply by its Archive source ID; restoring does not
rebuild the row
([decision](docs/adr/0123-retired-sources-leave-native-history.md),
[placeholders](docs/adr/0132-retired-history-placeholders.md),
[native history checks](services/hermes/test_retired_history.py),
[storage checks](test/store-source-retirement.test.ts)). The pinned-Hermes replay
and search check runs only in the Hermes image. Pending: the owner-machine rerun of
the simulator's retired-fact case. Hermes native notes (`MEMORY.md`,
`USER.md` and their backups) now lose entries that cite a retired source or that
a withheld turn's memory call wrote, checked before every turn
([decision](docs/adr/0129-retired-sources-leave-native-notes.md),
[checks](services/hermes/test_retired_history.py)); an uncited paraphrase stays.

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
delegation, or live-memory-readiness claim is made; existing recall failures
remain open.
[Dashboard checks](test/dashboard-supervision.test.mjs),
[synthetic preview](test/dashboard-supervision-preview.mjs).

Nocheh is pre-release. The operating local installation has 17/17 healthy
services after the limited database and Inngest recovery and Hermes image-tag
restoration documented below. This service-health checkpoint does not establish
personal-use readiness or release acceptance. The earlier unexplained Inngest
exit remains recorded. The pinned native candidate includes empty-completion rejection; the
last verified TypeScript services include event-bound provider timings, dependency
patches, and protected workflow receipt reconciliation. The prior source checkout
and its three local edits remain preserved.

The active `nocheh_postgres_data` volume measured 36.9 GB on 2026-10-08; the
Inngest database is 35 GB (`spans` 27 GB, `history` 4.8 GB, `traces` 3.3 GB).
Honcho and native memory review produced 99.5% of 13.4 million spans, mostly
background runs repeatedly polling one busy admission slot. Background families
now wait in one shared Inngest concurrency key; a synthetic probe against the
pinned Inngest cut spans for the same contended workload from 888 to 153 with
zero wait polls and unchanged reply latency. This source is not yet active in
the operating installation. Because these rows were test telemetry, the owner
directed their full deletion: `spans`, `history` and `traces` were truncated
with the database isolated, leaving Inngest at 70 MB and the volume at 1.6 GB.
Nocheh stores, receipts and the workflow registry were untouched.
Telemetry retention is now a configurable setting,
`NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS`, checked daily; by owner decision it
keeps everything by default (`0`) until the owner sets a number of days
([default decision](docs/adr/0144-keep-history-by-default.md)); an
installation whose `.env` already sets a number keeps it.
[Decision](docs/adr/0106-configurable-workflow-history-retention.md),
[daily interval](docs/adr/0107-daily-workflow-history-retention.md),
[retention checks](test/workflow-retention.test.ts),
[shutdown check](test/test_store_postgres_entrypoint.py).
[Decision](docs/adr/0105-shared-background-engine-queue.md),
[registration check](test/workflow-foundation.test.ts),
[probe](test/workflow-background-probe.ts).

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
installation generation across an isolated fresh start and restart. The
operating database was recreated from the tested image with its named volume
preserved and recovered after 81 seconds of WAL replay. Development has
automatic service restarts disabled and is not the unattended release
configuration.

The existing embedding spending cap and subscription request safety limit remain
in force. Nocheh runs no provider proxy or provider login of its own
([ADR-0142](docs/adr/0142-external-providers-only.md)).

Group chats now answer only when a message addresses Nocheh: a reply to one of
its messages, its @username or a tap on its name, or its display name or a
name from Settings opening the message. Other group messages are archived
without a turn. Settings › Telegram access has the “Group replies” choice
(only when addressed by default, or every message) and an editable name list
that starts as “Nocheh” and “نوچه”
([decision](docs/adr/0133-group-replies-when-addressed.md),
[editable names](docs/adr/0134-editable-bot-names.md),
[dispatch checks](test/store-telegram-dispatch.test.ts),
[trigger checks](services/hermes/test_group_trigger.py)). The pinned-Hermes
gateway check ([test](services/hermes/test_gateway.py)) and the
`group_answers_only_when_addressed` simulator scenario run only on the owner's
machine and have not been run. Addressing by a name at the start passed live on
October 12 (four group messages, one reply each). Pending: a live unaddressed
group message that gets no reply, and a reply or @mention that gets one.

All topics of a group now share one memory by default. A live question in a
group's second topic did not know what the owner had said in another topic,
because every recall path matched the turn's topic exactly. Archive reads and
search, Honcho recall, owner corrections, persistent grants and sharing now
reach the group's General chat and every topic; the private chat and other
groups stay out. Settings › Telegram access › “Topic memory” can keep topics
separate (“Each topic”)
([decision](docs/adr/0135-group-topics-share-memory.md),
[retrieval checks](test/store-retrieval.test.ts),
[grant checks](test/store-memory-access.test.ts),
[sharing checks](test/store-sharing.test.ts),
[helper checks](test/spaces.test.ts)). Hermes native notes stay per
conversation. Live check passed on the owner's development installation on
October 12: questions in other topics and in General recalled what was said in
one topic, with no private-chat fact, after restarts on three successive builds
([live summary](docs/mvp-acceptance-status.md)).

Dashboard rebuild (October 13, owner: "the work flow and ui update after save is
bad, save btn is not in good place and lots of other ui/ux issue ... need to check
app fully and do a refactor to make dashboard simple and usable"): the owner
dashboard is rebuilt from scratch around eight pages (Home, Inbox, Chats,
Messages, Memory, Usage, System, Settings), shared components in `dashboard/ui`
and one Save in the page header, at the top of the screen, that saves and applies
every settings edit in one step and shows the outcome
([decision](docs/adr/0145-rebuilt-owner-dashboard.md),
[Save placement](docs/adr/0146-save-in-page-header.md),
[save bar](dashboard/ui/save-bar.tsx), [settings store](dashboard/lib/settings.ts),
[routes](dashboard/lib/routes.ts), [browser checks](test/dashboard-pages.browser.mjs)).
Model providers are added in a dialog that lists the provider's models before
adding it. The 3D evidence graph and the editable memory map are gone from the
dashboard; people, facts and projects are lists with side panels. The server
gaps found while building it are closed, and System lists internal keys by
service and use ([history](docs/task-history.md)). A manual share from Memory ›
People stays persistent or dated: one-time access belongs to approving a
pending request, where it already exists. Pending: a look at the new fields on
the running installation.

Role and skills per chat (October 16 and 17, owner: "want to ability to set role
or skill for projects or GPs ... for a group or user use role and skills and for
other one use other role and skill"; "if can have role and skill for own Hermes
profile use it instead of imple in nocheh"): each selected group and the owner's
private chat now has its own role (Hermes `SOUL.md`) and skills (Hermes
`skills/`) in its Hermes profile, with defaults for every chat. The owner edits
them on the chat's page in Chats and the defaults in Settings › Assistant; turns
read them and cannot write them, and topics use their group's
([decision](docs/adr/0151-chat-role-and-skills-in-hermes-profiles.md),
[profile checks](services/hermes/test_persona.py),
[tool checks](services/hermes/test_scopes.py),
[runtime checks](test/runtime.test.ts),
[browser checks](test/dashboard-pages.browser.mjs)). The storage service had no
`/v1/manage/hermes` route, so per-chat assistant limits, Memory › Assistant notes
and the CLI's profile commands could not reach Hermes; the route now serves them
too. Projects have no role and skills of their own for now (owner, October 17:
"follow your recommend"). The first live group check (October 19) failed: the
reply ignored the role and never used the skill, because Hermes looked for
`SOUL.md` and `skills/` beside the session database in `native-state/` and
reused each continuing session's first system prompt. Turns now bind the
profile as the Hermes home and rebuild a session's prompt once after its role
or skills change ([checks](services/hermes/test_persona.py)); the repeated live
group check passed the same day
([register](docs/mvp-acceptance-status.md)). Pending: carrying roles and skills
across an original-only reset.

Built-in instructions (October 17, owner: "every hard coded text should
editable form dashboard"): the reply rules, remembered-facts and limited-memory
notes, Hermes notes review, secret check, group sharing filter and learning
instruction are editable in Settings › Assistant with a reset to the built-in
text; the owner's replacements travel with each runtime call
([decision](docs/adr/0152-owner-editable-built-in-instructions.md),
[Hermes checks](services/hermes/test_prompts.py),
[Node checks](test/prompts.test.ts), [storage checks](test/store-server.test.ts),
[browser checks](test/dashboard-pages.browser.mjs)). Pending: a live check that
an edited group rule changes a group reply; carrying the replacements across an
original-only reset.

Reply outage after the built-in instructions update (October 17–18): the owner's
development installation answered no new message from the October 17 pull of
that update until a rebuild. Live reload ran the new code, but store
provisioning runs only when PostgreSQL starts, from its image's own build, so
the instructions table was missing and every secret check, reply and memory
call failed at once. The detector live check calls Hermes directly and passed.
In development, PostgreSQL now reruns store provisioning from each finished
app build ([entrypoint](deploy/store-postgres-entrypoint.sh),
[check](test/test_store_postgres_entrypoint.py), [procedure](docs/deploy.md)).
On October 18 the owner's installation was rebuilt; the held secret checks
finished and the held messages were retried. The re-asked reaction recall
question then passed on its first attempt
([register](docs/mvp-acceptance-status.md)).

Honcho memory provider rejection (October 18): every Honcho model call through
the memory provider returned 403 since at least October 18, while replies and
the secret check used the same provider. The provider's browser check rejects
Python's default client name, which the Honcho meter sent; it now names itself
([meter](services/honcho/meter.py), [check](services/honcho/test_meter.py)).
After the fix the held Honcho memory jobs completed on the owner's installation.
Workflow failures kept only a generic reason, so the engine now logs each
failure's error kind, code and top frames ([engine](src/workflows/engine.ts)).
That showed the test's reaction-removal update failing its Honcho source step
with `memory_session_conflict`. Its audience followed the topic of the message
it reacted to, but its Honcho session key fell back to the chat-wide General
session, because Telegram sends reaction updates without a topic. A reaction
now uses its target's topic session ([entities](src/stores/entities.ts),
[check](test/store-relationships.test.ts)). The superseded reaction add is not
learned by design, because it is no longer the current reaction. On October 18
the held removal update reached Honcho memory on the owner's installation, in
the same topic session as its note.

Honcho memory message dates (October 18): a private-chat question about the
day's conversations dated that reaction removal to the hour its held Honcho job
was retried, not to the removal itself. Nocheh wrote Honcho messages without a
date, so Honcho dated each one by its write. Source evidence now carries its
event's time (Telegram's date, else its capture time); a learned interpretation
keeps the time it was learned ([native memory](src/stores/native-memory.ts),
[check](test/store-native-memory.test.ts)). Messages written earlier keep their
write time until their session is rebuilt.

Honcho learning query limit (October 19): one group-topic interpretation job
failed on every retry with `honcho_upstream_rejected`. Its learning query was
11,107 characters, and the pinned Honcho rejects a reasoning query over 10,000
characters before any model call. Applicable rules (3.6–4.5k) and the learning
instruction (3.5k) leave about 2k for observations, and successful jobs reached
9,757. The query now fits the limit: other evidence keeps only its text, then
rules are left out from the end, then the trigger keeps only its text, each
named in the query's limitations; an input that still cannot fit closes as
`input_limit` instead of retrying ([learning engine](src/stores/learning-engine.ts),
[check](test/learning-workflow.test.ts)). Honcho rejections now log their status,
route and failing field without content ([client](src/honcho.ts)).

Deep check for hidden data and failure gaps (October 18), verified locally with
synthetic PostgreSQL, not yet run on the owner's installation:
- A reply chain in an ordinary group carries a thread number but is not a topic;
  only forum topics are now treated as topics, in capture, Honcho sessions and
  Hermes ([spaces](src/spaces.ts), [Hermes scopes](services/hermes/scopes.py)).
- A reaction no longer cancels or drops a reply in progress: its epoch advance
  waits for the reply, and a reply whose context changed is retried
  ([reaction state](src/stores/reaction-state.ts),
  [check](test/store-telegram-dispatch.test.ts)).
- A Honcho write that never arrived is resent after ten minutes, a rejected one
  is retried, and an old Honcho derivation failure no longer holds memory
  "building" ([native memory](src/stores/native-memory.ts),
  [queue health](services/honcho/provenance.py)).
- A reaction no longer renames a person; failure causes reach logs and the
  Hermes result; a rate-limited fallback reply is retried; replies no longer
  inherit the replied-to message's files; Health shows unsaved incoming
  messages and reply states; message times no longer show "Invalid Date"; the
  history retention setting reaches the app.
- The four gaps found but left for the owner's decision are fixed below.

Known gaps fixed before the release tests (October 19, owner: "yes" to fixing
them before the Telegram tests), verified locally with synthetic PostgreSQL,
not yet run on the owner's installation:
- A Telegram file over 20 MB, which the Bot API never lets a bot download, now
  settles as a reference without a download (or after Telegram refuses it) and
  no longer holds the reply; the turn says a file was over the limit
  ([attachments](src/stores/attachments.ts),
  [check](test/store-preparation.test.ts)).
- A group turn opens with the speaker's guarded name and @username and the send
  time in UTC, never a Telegram ID, outside the Honcho memory query
  ([dispatch](src/stores/telegram-dispatch.ts),
  [checks](test/store-telegram-dispatch.test.ts),
  [Hermes checks](services/hermes/test_turn_process.py)).
- Only the latest revision of an edited message stays in Honcho memory
  ([decision](docs/adr/0154-message-edits-replace-honcho-writes.md),
  [check](test/store-native-memory.test.ts)).
- An album gets one turn and one reply on its first part, with every part's
  text and files ([decision](docs/adr/0155-albums-answered-once.md),
  [check](test/store-telegram-dispatch.test.ts)).
- Imported group history no longer repeats what the bot saw live: Desktop
  senders are the same people as live senders, and a supergroup or channel
  export mapped to its live chat shares the live messages, which win in search
  and Honcho memory; a newer export replaces an older one
  ([decision](docs/adr/0156-desktop-exports-share-proven-telegram-identities.md),
  [check](test/store-desktop-import-identity.test.ts)).
- Release test 1 (October 19) passed its addressing part on the owner's
  installation: an unaddressed group message stayed quiet and a Reply was
  answered in about 24 seconds. Its recall part failed: the answer could not
  see the unaddressed message. A group turn now carries the messages since the
  last turn ([decision](docs/adr/0157-group-turns-see-recent-unaddressed-messages.md),
  [check](test/store-telegram-dispatch.test.ts),
  [Hermes check](services/hermes/test_turn_process.py)).
  The rerun on the change carrying it passed: the Reply named the unaddressed
  question once, in about 23 seconds.
- Release test 2 (October 19): Nocheh drafted the requested group message and
  waited for approval, but told the owner to approve it in an old dashboard
  name. Approved in the Inbox, it was delivered once about 2 seconds later. The owner asked for a button under the message, in private chats and
  groups. A pending action now gets Approve and Reject buttons in its own group
  or topic, or in the owner's private chat; only the owner's press decides and
  the card then shows the outcome. Stale "Nocheh Activity" and "Activity
  Decisions" wording now says the dashboard Inbox
  ([decision](docs/adr/0158-telegram-approval-buttons.md),
  [check](test/store-approval-buttons.test.ts),
  [Hermes check](services/hermes/test_approval_cards.py)).
  Card layout, button labels, outcomes and notices are now owner-editable
  templates in Settings › Instructions; the Telegram command replies are
  still fixed in code. On the owner's
  installation a button press in the group approved and delivered the post
  once. The card now also says when the message was sent.
- After that test the owner asked that allowed people post freely in their own
  group, that approval talk happen in the private chat, and that people who are
  not allowed get a fixed reply, and that a message from one group to another
  is shown and approved because it is made from the first group's memory. A
  same-group post by the owner or a permitted participant now needs no
  approval, a group turn can list the groups where the person asking is
  allowed, cards go to the owner's private chat, and an unallowed member who addresses Nocheh gets one editable reply
  without a turn ([decision](docs/adr/0159-group-members-post-freely-and-approvals-go-private.md),
  [check](test/store-approval-buttons.test.ts),
  [Hermes check](services/hermes/test_approval_cards.py)). Not yet run on the
  owner's installation. Live check on the owner's installation (October 19,
  with this change and the quote fix): a same-group post went out once with no
  card and no other reply; a request in the group for the owner's private chat
  put one card in the private chat and one short note in the group, and the
  owner's button press delivered the message once about 4 seconds later, with
  the card showing the outcome. The owner then decided that an allowed member reviews
  their own message to another group where they are also allowed, or to
  another topic when topics keep separate memory: the card
  appears under the request in the group, and only that member or the owner
  can press it. The owner's own request from a group for their private chat
  needs no approval ([decision](docs/adr/0161-requesters-review-their-own-cross-group-messages.md),
  [check](test/store-approval-buttons.test.ts)). Open question to the owner: whether memory should
  stay per group, shared between groups only through owner sharing rules (the
  recommendation), or be shared across all groups or projects of one person.
- Release test 3 (October 19) passed on the owner's installation: Hermes
  restarted about 2 seconds into a private turn, after the input check and
  Honcho recall and before the model call. The first attempt failed as
  unavailable, the automatic second attempt delivered exactly one reply about
  44 seconds after capture, and every service was healthy afterwards. A restart
  during the model call itself was not separately repeated.
- Owner task list (October 19): the owner asked for a Telegram mini app to
  manage Nocheh, Nocheh's own task manager in it, and Notion through MCP as an
  optional extra. Step 1 is in source: a Tasks page in the dashboard and a
  `nocheh_tasks` assistant tool for the owner's private chat over one list in
  the control store ([decision](docs/adr/0160-owner-task-list.md),
  [check](test/store-tasks.test.ts), [broker check](test/knowledge-broker.test.ts),
  [tool check](services/hermes/test_knowledge_tools.py),
  [browser check](test/dashboard-pages.browser.mjs)). Live check pending: ask
  Nocheh in the private chat to add, list and finish a task.
- Telegram mini app (October 19): Home, Inbox and Tasks in Telegram through a
  credential-free mini app service and a Cloudflare tunnel, turned on in
  Settings › Telegram ([decision](docs/adr/0162-telegram-mini-app.md),
  [setup](docs/telegram.md#mini-app), [check](test/mini-app.test.ts),
  [settings check](services/hermes/test_settings.py)). Pending: a live open
  from the owner's phone; the owner tests it on the MVP installation, not the
  local one. Next: the optional Notion connector.
- Release test 4 (October 20) passed on the owner's installation. A private
  message stating a synthetic locker code got one reply. Hiding it and
  Nocheh's reply made a later question answer once without the code; the code
  appeared in no replayed history, tool result or Honcho output. After Undo on
  the message alone, the code returned from the restored message through
  archive search and Honcho, while the still-hidden reply was used nowhere.
  The memory lookups after the hide and the Undo took 52 and 32 seconds:
  sequential Honcho reasoning rounds, each passing the input check, and a
  re-prepared guard cache after the epoch change.
- The same check found that each guard epoch gives a chat a new Hermes profile
  with an empty conversation, so Nocheh forgot the ongoing chat seven times in
  two days, four after automatic learning. In source on a branch: a new
  epoch's profile is seeded once with the chat's recent messages and delivered
  answers, and retirements apply before its first turn
  ([decision](docs/adr/0163-chat-conversation-carries-into-new-guard-epochs.md),
  [check](services/hermes/test_profile_history.py)); the owner chose to fix it
  before the MVP. Earlier-epoch profiles are not yet pruned.
- Release test 5 (October 20) passed on the owner's installation: a group
  member who had never posted added, changed and removed a reaction on an
  older message. Each update was captured once and in order, the current state
  ended empty, Nocheh sent nothing and no errors were logged. Each update
  advanced the guard epoch, so busy reactions start new per-epoch Hermes
  profiles, which are not pruned.
Pending: a live album, an edit and a small group-export import on the owner's
installation.

Re-running and replacing Honcho memory (October 19): Memory › Long-term memory
and `./bin/nocheh memory honcho` can retry failed Honcho learning in place,
re-learn every chat or chosen chats from their saved messages, or replace the
workspace with a new one that learns the archive again or starts empty, each
after an estimate ([decision](docs/adr/0153-owner-reruns-and-replaces-honcho-memory.md),
[checks](test/store-memory-rebuild.test.ts),
[plugin checks](services/honcho/test_provenance.py),
[browser check](test/dashboard-pages.browser.mjs)). On the owner's installation
the live retry re-ran the 2 failed learning tasks and Honcho memory returned to
ready with none failed or waiting. Read-only counts found no gap left: there was
no incoming traffic from October 13 12:18Z to October 18 11:06Z, and the
messages on either side link to Honcho conclusions at the usual rate, so no
re-learn is needed. Re-learning or replacing the owner's live memory waits for
the owner's word.

Upgrades (October 19): every dependency is on its latest release. The npm
packages include TypeScript 7, React 19.3, esbuild 0.28 and Inngest SDK 4.25;
the services run Node 26.12, PostgreSQL 18.6 with pgvector 0.8.7, Redis 8.8.3,
Docker CLI 29.9 and the Inngest server 1.46, on Debian trixie images. Every
PostgreSQL service sets PGDATA to its mounted data directory, because the 18+
images default elsewhere; a PostgreSQL 17 volume does not start on 18, so the
installation starts with fresh databases, as the owner accepted. Honcho is
pinned to the v3.3.0 release with `honcho-ai` 2.6.0 and `honcho-cli` 0.2.0.
Honcho keeps conclusion parent links in its `document_sources` table, so the
provenance and session-descendant reads, and the portable memory export, use
that table, and the provider gateway allows Honcho's 6,000-token long summaries
([plugin checks](services/honcho/test_provenance.py),
[gateway checks](services/honcho/test_meter.py)). The Inngest inspection
rewrite finds the 1.46 viewers and GraphQL client by pattern
([inspection checks](test/workflow-inspection.test.ts)). Hermes is pinned to
v0.22.2 on Python 3.14.8 and uv 0.13.2. Its Telegram update admission records
the polled update when Nocheh's committed-only gate accepts it, so committed
turns now enter PTB's own dispatch beneath that admission, and Nocheh's dispatch
receipts stay the exactly-once authority
([gateway check](services/hermes/test_gateway.py)). The native skill curator is
off for managed profiles, because roles and skills are set only by the owner
([profile check](services/hermes/test_profile_config.py)). The TUI and dashboard
patches are re-anchored, moved Hermes symbols are followed, and Hermes' direct
`state.db` opens map to the profile's native state. A new pin moves an untouched
Hermes or Honcho source checkout. Checked here: the Node suite on Node 26 with
PostgreSQL 18 (190 pass, 77 skipped), Honcho v3.3.0 migrations, provenance and
export on PostgreSQL with pgvector, and the Inngest 1.46 inspection pages in
Chromium. Pending: the Hermes image build and Hermes Python tests on the owner's
machine, a fresh-database rebuild there, and a live reply check.

</current>

<verification>

- Personal-use mocked-Telegram evaluation (2026-10-08, current source): every
  Node test file passes on its own fresh synthetic database (269 passes, four
  fixture-dependent skips); all 439 Hermes/Honcho and 100 tooling Python
  checks pass. A fresh 16-service installation passes its 19 coupled checks,
  the ordinary and faults-and-files HTTP Telegram runs, and the
  [personal-use scenario suite](tools/acceptance/telegram_scenarios.py):
  all 31 scenarios and 288 gates pass with no unmodeled Bot API method, and
  the raw synthetic secret never reached a model call. The suite drives real
  Hermes polling, three stores, Inngest, Honcho and Nocheh tools through a
  scripted fixture brain and a substituted speech service; it does not
  measure model judgement, real transcription or real Telegram. It found and
  verified repairs for a reply never transmitted during a polling reconnect,
  which had been recorded as uncertain and lost; for replies to messages sent
  together arriving out of order; and for a blank voice transcription that
  left its dispatch waiting indefinitely. [Decision](docs/adr/0104-telegram-update-order-and-untransmitted-sends.md),
  [procedure](docs/telegram-simulation.md), [history](docs/task-history.md).
  A later fresh installation with the follow-up repairs passed the 19
  coupled checks, both HTTP runs and every scenario, including terminal
  Telegram rejections, retirement offers and no lingering turn containers; a
  launcher stopped mid-turn left no container and the reply arrived once.
  The per-file storage helper passes 270 Node checks; 440 native and 100
  tooling Python checks pass.

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
  coupled fixture results are recorded below. Relay (removed `tools/acceptance/model_relay.py`),
  checks (removed `test/test_model_relay.py`).

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
  runner (removed `tools/acceptance/model_rehearsal.py`),
  relay (removed `tools/acceptance/model_relay.py`).

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
  Runner (removed `tools/acceptance/model_rehearsal.py`),
  checks (removed `test/test_model_rehearsal.py`).

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
- October 14: a backup of the owner's development installation failed with
  `honcho_backup_state_missing` after pausing Telegram for about 75 seconds,
  because installations run only through `make dev` never generate
  `honcho.Dockerfile`. That build file is now optional: a backup records it as
  rebuildable when absent and still requires the five owned Honcho state files
  ([check](services/hermes/test_operations.py)). The rerun with the fix
  passed: Telegram paused 78 seconds; 947 state files and 99 table fingerprints,
  Honcho and workflow state were covered; the inactive restore matched every
  fingerprint and kept Telegram, provider login, Honcho attachment and
  executors inactive; the restored copy was removed and the operating stack
  returned healthy with one poller.
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

Silent learning (October 10): on the owner's development installation with
Claude through Honcho, seven `interpret` jobs failed after 9 to 10 attempts
with hourly retries still scheduled, because each retry re-validated the same
saved reasoning result. The saved results were fenced JSON (three), direct
claims labelled with a relationship kind but no object (two), and
interpretations citing source IDs that Honcho recalled from earlier messages
(three). Results are now read from fenced or wrapped JSON, a relationship
label without an object is ignored, the request lists the citable IDs, an
invalid item is dropped and recorded while valid items publish, and a result
still unusable as a whole closes its workflow
([decision](docs/adr/0128-learning-results-keep-valid-items.md),
[learning checks](test/store-learning-engine.test.ts),
[workflow checks](test/learning-workflow.test.ts)). Pending: the owner's
confirmation of keeping valid items rather than failing the whole result, and
a check on the development installation that the seven jobs complete or close
on their next retry.

Silent learning (October 12): 3 of 20 `interpret` jobs closed as failed
because Honcho's reasoning answer hit its 2,500-token output limit and was cut
off inside the entity sections. A cut-off answer now keeps its whole leading
items ([decision](docs/adr/0140-truncated-learning-results-keep-whole-items.md),
[check](test/store-learned.test.ts)). Pending: a live check that the next such
answer publishes its complete interpretations.

Scheduled runs (October 10): the simulator found every scheduled run rejected
before the agent started with `space_policy_changed`, because
`/v1/memory/check` accepted only an archived turn source and schedule fires are
never archived. The check now accepts a scheduled turn credential whose admitted
run still matches its scope, space, profile, guard binding, live lease and
current schedule definition ([check](src/stores/scheduled-runs.ts),
[store test](test/store-server.test.ts)). Pending: rerun the simulator's
schedule scenario on Docker.

Personal-use simulation follow-ups are resolved and verified in the coupled
fixture: definite Telegram rejections close as rejected by Telegram; an
approved action Hermes refuses before any send intent returns to the approved
queue; retirement offers the direct reply and replies that quote the message;
storage tests run with per-file cluster resets
(`python3 -m tools.development.store_tests`); turn containers are removed when
their launcher stops. An approved action whose runtime is unreachable, or
whose response is lost, remains uncertain by design.

Live owner session (October 8, operating stack, source-watched): replies were
delivered once each but retried because a first voice transcript revoked
every in-flight turn; ADR-0108 removes that revocation. Owner-private turns
read the owner's directory, people and projects; the owner freedom setting
(approval required by default) is in Nocheh settings; topics are named from
their root message and selected groups can be named by an explicit Telegram
refresh. Because the Bot API cannot list topics, topics also appear from their
lifecycle messages and the owner can add older empty topics by link in Settings. Development turns now use the watched source. Archive details open
in a drawer. On a fresh simulator installation (October 9) all scenarios pass,
including the owner directory and its group denial, the refresh, owner
freedom, a launcher stopped mid-turn, texts with a voice note in Telegram
order, and an unparseable update that previously wedged polling; browser
checks of the drawer, retirement offers and settings panels pass. Pending
owner rechecks: a live exact approval to a topic and quick live messages with
a voice note. Real-model quality, live Telegram release gates and release
remain pending. [Live summary](docs/mvp-acceptance-status.md).

Providers per part (October 13, owner: use the hosted provider gateway instead
of Nocheh's own provider; its wake-up time does not matter): Settings › Models
now lists providers (OpenAI and Anthropic by API key, and custom
OpenAI-compatible providers by HTTPS address and key) and the provider
and model of replies, memory, the secret check and memory search, with one
default for every part ([decision](docs/adr/0141-per-part-model-providers.md),
[resolver](tools/operations/provider/routes.py),
[checks](services/hermes/test_provider_routes.py),
[browser check](test/dashboard-pages.browser.mjs)). After the owner's review,
model lists load from added providers while they are being edited, and each
custom provider is a card with Remove in its header. Owner, October 13: "remove
CPA and it admin panel from our services." CLIProxyAPI, CPA Manager Plus, the
provider logins and the ChatGPT speech route are gone; a fresh installation has
no provider and its model calls wait with `provider_not_configured`; voice
notes are archived without transcription and never hold a reply
([decision](docs/adr/0142-external-providers-only.md)). Pending: the owner
applies my-gateway on Cloudflare (or adds an API key), adds it in Settings and
applies; then a live reply, memory answer and secret check through it; whether
and how voice transcription returns is the owner's decision. An existing
installation keeps its old `data/local/provider/` folder (the CPA logins);
reset refuses it as an unknown path until the owner deletes it. Honcho's structured output through
Anthropic's OpenAI-compatible endpoint is unproven. Moving Nocheh itself to an
always-on server is a separate, unstarted step.
Usage tracker (October 13, owner: "we need to have our own tracker ... everything
needs to be displayed in one place (Nocheh)"): Hermes's own per-turn token
counts and cost go to a daily table per part, provider and model
([tracker](services/hermes/usage.py)); Honcho memory and memory search are
counted at Honcho's meter ([meter](services/honcho/meter.py)); System › Usage
shows calls, tokens and estimated cost for every part in one list
([view](tools/operations/provider/usage.py), [page](dashboard/pages/usage.tsx),
[checks](services/hermes/test_usage.py), [view checks](services/hermes/test_usage_view.py)).
Costs Hermes cannot price, such as a custom provider's, show as unknown.
Pending: live counts after the owner adds a provider and applies (Hermes and
the meter must be rebuilt for the tracker to start counting).
With real Claude answers the schedule scenario fires, waits for review and
delivers once (the scheduled-run fix on main holds), but removing the finished
one-time schedule failed: removal paused it, which Hermes refuses for a
terminal job. Removal now leaves a finished job terminal
([adapter](services/hermes/native_cron.py), [test](services/hermes/test_scheduler.py)).
Real-Claude simulator run (October 10, fresh installation, Claude Sonnet 5.5
through the operating provider, real Honcho embeddings): 14 of 16 scenarios
passed before the fixture's 300-call cap; the schedule cleanup failure is fixed
above and polling outage stopped at the cap. Of 300 model calls, 214 were
literal-detection calls, 49 Honcho and 37 Hermes chat. Over 20 replies the
reply time was p50 86 s and p95 176 s while provider wait was p50 2.2 s:
preparation steps (p50 8.9 s), Hermes history (p50 5.7 s), model guard and
step waits dominate, and detection calls are counted as internal steps rather
than LLM time. Answers were natural Persian; while transcription was down the
reply to a text after a voice note said no voice note was found, and a PDF
caption reply said no text could be extracted. After the owner raised the cap
to 1,000, every remaining real-Claude scenario passed. Memory cases with real
Claude and Honcho: reaction removal, corrected fact, private isolation, topic
isolation and recall after restart answered correctly; the retired-fact case
failed. Thirty seconds after every source of the synthetic name was retired,
the owner-private answer still gave the name. No memory result or archive
search after the retirement contained it; Hermes' native session history,
which `/v1/context/prepare` guards but does not filter for retirement, still
held the earlier turns. Recheck on main 4db58ef (October 12, real Claude, owner-approved pause of the
operating stack): after the retirement the owner-private answer no longer gives
the name and says it will not guess, so the native-history fix holds. Claude
calls stopped after the run: 11 in the following two minutes, then none for
three and a half minutes; the recheck used 42 calls. The checker then failed
on a repeated Telegram message number in the restored fixture, now matched by
reply text.
Incident (October 10, about 12:47Z): a host run of the settings tests called
Apply's new Honcho refresh with a temporary state that named no Compose
project, so Compose used the file's `nocheh` project and recreated the
operating stack's five Honcho containers with that state's secrets; the
operating honcho-api then failed on the database password until the recall
thread removed those containers. Honcho start/stop, the Apply refresh and the
provider model list now refuse a state that is neither the installation's own
nor names its own project ([guard](tools/operations/installation/configuration.py),
[test](services/hermes/test_honcho_runtime.py)).

Real-model simulator cases (October 14): after the built-in Claude connection
was removed, the fixture model service can relay to an owner-authorized
provider from a private upstream file, so Hermes, Honcho and the secret check
reason with a real model while Telegram stays simulated
([rehearsal](tools/acceptance/model_rehearsal.py),
[checks](test/test_model_rehearsal.py),
[procedure](docs/telegram-simulation.md)). New cases cover memory shared across
a group's topics and isolation between groups. A fresh fixture from the
simulator change passed the installation rehearsal (15 of 15 gates), both
Telegram rehearsals (14 and 12 gates) and all 38 personal-use scenarios. The
closing lingering-turn check stopped on a transient Docker CLI failure, now
retried. The real-model cases stopped before any answer: their updates were
numbered below the offset the scenario run had already acknowledged, so the
adapter dropped them; numbering now starts above it. Afterwards the operating
stack could not start: three stopped fixtures kept 24 networks and exhausted
Docker's address pools, and with the machine asleep it stayed down for about 11
hours. `make dev` now releases networks of stopped fixtures
([check](test/test_live_dev.py)). On rerun the lingering-turn check passed,
and six of seven real-model cases delivered acceptable answers (reaction
removal, corrected fact, private isolation, a fact shared across a group's
topics, isolation between groups, recall after restart); no raw secret canary
reached the provider outside the secret check. The retired-fact case failed:
seven seconds after both name sources were retired, the private turn still
answered the name "from memory". Retirement advances the guard epoch, so that
turn ran in a fresh native profile without the old notes or history, made no
tool calls, and took the name from the turn-start Honcho context, read before
the epoch's correction sweep had rebuilt the session. Honcho context and recall
now wait for that correction
([ADR-0148](docs/adr/0148-honcho-reads-wait-for-epoch-correction.md)). A rerun
confirmed the retired name no longer leaks, but routine epoch changes kept
Honcho memory closed for the whole run, so only uncorrected owner changes now
hold it ([ADR-0149](docs/adr/0149-only-owner-changes-hold-honcho.md),
[checks](test/store-native-memory.test.ts)). That rerun's scenario failures
came mostly from running the scripted scenarios after real-model relay mode
was enabled; the scenarios now refuse relay mode. A fresh full run on the
narrowed gate (October 15) passed: installation rehearsal, the ordinary Telegram
rehearsal, 39 of 39 scripted scenarios, and all seven real-model cases on the
first delivery. The retired-fact turn said long-term memory was being
corrected and gave no name; it was the only turn Honcho memory was held for.
Real Honcho lookups ran in the corrected-fact, shared-topic and group-isolation
cases, the Honcho queue drained, there were no upstream errors, and no raw
secret canary reached the provider outside the secret check. Observation: each
real Honcho dialectic lookup took 25 to 36 seconds, most of those replies' time.

Honcho recall latency (October 16, from that run's gateway ledger and derived
records): each recall asked one person and made two Honcho reasoning rounds
(about 7 to 10 seconds of model time) and about five sequential secret checks
of 2 to 4 seconds each (11 to 21 seconds); the question's check waited up to
8 seconds behind background checks. Honcho's recall requests were checked at
background priority; they now take reply priority while the deriver stays
background ([ADR-0150](docs/adr/0150-honcho-recall-checks-take-reply-priority.md)).
The `honcho_recall` stage does not separate secret-check time. A real-model
rerun on the change passed all seven cases; in the one comparable recall
(shared topic) the lookup fell from 27.0 to 20.2 seconds, the question's check
from 8.3 to 2.5 seconds and critical-path checks from about 18 to 11 seconds.
About four sequential checks of 2 to 4 seconds remain per recall. Options not
taken without the owner: fewer recall checks or a lighter Honcho reasoning level.

Secret-check model comparison (October 17, synthetic cases only,
[tool](tools/acceptance/detector_eval.py)): 14 cases with known secrets and
near-misses, three rounds each, through the owner's gateway. With the production
low reasoning effort, `gpt-6-luna` passed 42 of 42 with a 2.6-second median and
`claude-sonnet-5-5` passed 39 of 42 with 3.5 seconds; without a reasoning effort
they took 2.2 and 3.1 seconds. Sonnet's only failures were the private-key case,
whose expected value then included the key's armor lines; the case now requires
only the key material. `claude-haiku-4-5-20251001` wrapped every answer in a
code fence, which the detector rejected; the detector now removes one exact
JSON code fence and still rejects any other wrapping. The owner uses Anthropic
models only (October 17). With the fence accepted, Anthropic candidates over
three rounds at low effort: `claude-sonnet-5` passed 42 of 42 with a 2.65-second
median (also 42 of 42 without an effort), `claude-sonnet-5-5` 42 of 42 with 3.34
seconds (2.95 without an effort), `claude-haiku-4-5-20251001` 40 of 42 with 3.36
seconds (two rejected replies, one hiding a missed password), and
`claude-sonnet-4-6` 36 of 42 with 1.84 seconds (it missed the Persian password in
every round). The OpenAI embedding key still works (one synthetic call, status
200). The owner chose `claude-sonnet-5`, and the live secret check uses it
since October 17 (synthetic detector check 3 of 3, 2.8 to 3.4 seconds); every
other part stays on `claude-sonnet-5-5`. `claude-haiku-5-5`, compared later
the same day, passed 37 of 42 with a 2.73-second median against 42 of 42 and
2.52 seconds for `claude-sonnet-5`; it answered in prose instead of JSON in five
calls, so the secret check stays on `claude-sonnet-5`. A larger rerun (five
rounds, 70 calls per model) confirmed it: `claude-sonnet-5` 70 of 70 with a
2.55-second median and 3.13-second p90; `claude-sonnet-5-5` 69 of 70, 3.07 and
4.73 seconds; `claude-haiku-5-5` 55 of 70 and `claude-haiku-4-5-20251001` 61 of
70, every failure an unreadable reply.

Simulator run on main after the Honcho session, storage and timing merges
(October 10, fresh synthetic installation, deterministic inference): the
installation rehearsal and both HTTP Telegram rehearsals pass; the first
scenario pass had 38 of 42. Its polling-outage, storage and lingering-turn
failures and a second pass's rejected search reply came from the simulator;
after those repairs the affected scenarios pass on rerun. The repeatable
speech-outage restore and the review-drain wait before the lingering check
are not yet exercised in a full pass. The schedule scenario found the
scheduled-run rejection recorded above. Observations for the
storage and timing plans: one run of 180 archived events left 228,823 guard
fragments (97 MB) and 8,713 `guard-context` runtime contexts with only 1,370
distinct contents, none covered by retention; native memory reviews keep
launching isolated turns for several minutes after a burst, and four reviews
in flight when the launcher stopped or the provider was recreated stayed
`waiting`/`receipt_pending` in `reconcile`, rechecked every minute for over
40 minutes; every reply waits
about one second in the preparation outbox; a text after a voice note waits
about two minutes while transcription is unavailable.
[Procedure](docs/telegram-simulation.md).

Hermes native memory reviews after the real-Claude run (October 10): they kept
calling the model after the scenarios ended with no new messages and spent
most of the 1,000-call cap. Each authorization epoch swept the archive and
queued a new native review for every source, because the review identity
includes the guard binding; uncertain reviews were observed every minute with
no end. A source is now reviewed once, later epochs queue only sources whose
review never started, and an uncertain review gets at most eight observations
with doubling gaps before its workflow closes as uncertain
([decision](docs/adr/0124-native-review-once-per-source.md),
[checks](test/store-native-review.test.ts)). Pending: the owner-machine simulator
rerun that confirms no model calls after the scenarios end.

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

The focused synthetic same-topic reaction recheck has now issued one question
after the topic-7 generation reached ready. The single-worker native queue
advanced slowly through older synthetic work; one transient embedding retry
reported `memory_preparation_unavailable`, but the topic reached ready without
a terminal derivation failure. The question was captured and handed off, then
timed out after 311.5 seconds while dispatch remained running on attempt one.
A later single physical reply correctly described the synthetic star reaction's
addition and removal and said the report was not currently approved. It was
causally archived, and dispatch finished on attempt one about 430 seconds after
the question began. The Hermes receipt measured about 142 seconds for the agent;
its dispatch intent was written about 189 seconds after the question began,
and control reconciliation completed later. The workflow was admitted about
two seconds after the question and preparation closed about 183 seconds after;
saved outbox publication and run-seen timestamps are overwritten by later
republication and claims, so they do not prove where the wait occurred.
Synthetic Inngest emitted duplicate-span telemetry errors, but their causal
impact is unproven. Thus answer content passed review,
but the bounded first-attempt reply gate failed. The new question advanced the
generation to building while retaining a prior ready snapshot. Diagnose the
pre-intent and reconciliation delays and the transient preparation rejection
before treating this as dependable ready-memory recall. A second distinct
synthetic question was sent while that generation rebuilt and retained its
prior ready snapshot. Its preparation completed after about 43 seconds and
Hermes intent was written after about 76 seconds. The edited meeting time was
answered correctly in one attempt and one causally archived physical reply in
174 seconds, but the answer explicitly reported limited memory. This passes
delivery and corrected-fact content in a rebuilding audience, not the ready
Honcho-memory quality gate. The fixture is stopped with its volumes and
receipts preserved; all 17 operating services remain healthy, and host free
space is about 5 GiB at this checkpoint.

Read-only receipt inspection after Docker cleanup found the first recorded
Inngest run for the 430-second reaction turn about 174 seconds after capture;
preparation completed about six seconds later. The first four minutes contained
258 duplicate-span log lines and two queue-operation warnings above one second.
A successful warm comparison also had duplicate-span errors, so their causal
role remains unproven. The next fixture check should measure first outbox
publication to first run separately from native execution and reconciliation;
overwritten outbox timestamps cannot prove first publication.

The limited-memory suffix came from Hermes' explicit context-status handling,
not from the model's prose. The saved protected snapshot was renewed about
103 seconds after the second question began, after Hermes had read context.
A focused source candidate now validates an expired snapshot synchronously
when its already-ready generation is building, using the existing guarded
revision check and no Honcho model or embedding call. It keeps limited memory
on failed validation. The offline pinned Linux build and three focused
native-memory tests pass; two PostgreSQL-dependent tests were skipped because
that test database was not started. AST Graphify completed with zero model
calls. In a coupled check, the stopped fixture's app was recreated with only
the candidate JS file mounted read-only; only its app and database ran. Its
stale, previously ready topic snapshot returned one scoped source with
`limited_memory=false` and `syncing=true`, and the snapshot was renewed.
The same event bound to another topic was denied with `turn_source_denied`.
Neither the model relay nor Honcho provider services ran, so the check made
no paid request. The candidate is verified for this context-renewal behavior;
a full mocked-Telegram Hermes turn with the same one-file candidate also
answered the corrected synthetic fact in 142 seconds on the first attempt,
with one causally archived reply and no limited-memory notice. A background
refresh may have renewed the deliberately stale snapshot before Hermes read
it, so that turn does not isolate the foreground renewal path. The earlier
scoped API check does isolate and verify that path. The 430-second reaction
reply, Honcho queue latency, and operating activation remain open. A later
instrumented warm-fixture reaction recheck published both workflows about two
seconds after capture, completed preparation at six seconds, started Hermes
at 20 seconds, produced its native result at 68 seconds, and closed the
workflow at 124 seconds. One first-attempt reply arrived in 128 seconds,
correctly described addition and removal of the star, and had no limited-memory
notice. Earlier synthetic replies already held that fact, so this recheck
measures warm delivery and context status rather than independent first
discovery. The earlier 430-second failure remains evidence of cold or loaded
latency, with its precise cause unresolved. Git integration alone does not
activate this candidate.

After Docker resumed, a second monitored warm reaction question on the same
synthetic topic delivered one correct, causally archived first-attempt reply in
116 seconds. Its outbox was published about one second after capture and the
telegram workflow first ran about 24 seconds after capture. This confirms the
earlier 174-second pre-run delay is intermittent, not resolved. Prior replies
still contaminate independent recall assessment. Three synthetic sources in
an unused topic now record a different reaction's addition and removal; its
memory generation is building, so the first ready-memory question remains
pending while the Honcho representation queue drains. No cold-topic reply has
been scored.

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

1. The October 2 same-topic reaction case passed again on October 18 on the
   owner's installation, answered from archive read and search without a
   Honcho recall call ([register](docs/mvp-acceptance-status.md)). The original
   diagnosis below is kept: diagnose the October 2 same-topic recall failure
   using the saved event and CLI. One linked reply arrived on attempt two after about 384 seconds. It
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
4. Sanitized history is published on the public `PlaygrndLabs/nocheh`
   repository (recreated, then transferred), so GitHub no longer serves
   pre-sanitization commits (see [history](docs/task-history.md)). The
   sanitized `archive/pre-hermes-nocheh` branch is published and points into
   `main`'s history; the local pre-push guard
   rejects any branch that still contains rewritten commits. The original
   history remains recoverable only from ignored local bundles. Earlier
   third-party clones are not erased.
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
6. Inngest storage: the amplification cause is measured and repaired in source
   ([decision](docs/adr/0105-shared-background-engine-queue.md)). Activate it
   with the next authorized operating restart, then compare span growth per day
   against the 2026-10-08 measurement in ignored
   `data/acceptance/results/inngest-storage/`. The existing telemetry was deleted on owner
   direction. Configurable retention keeps everything by default
   by owner decision ([ADR-0144](docs/adr/0144-keep-history-by-default.md)); the operating `.env` must be checked for an explicit number. The rebuilt `nocheh-db` image is needed
   for the worker to exist in the operating installation. Remaining real prerequisite polls
   (native reconciliation, review prerequisites, retryable failures and the
   perpetual 120-second Honcho context refresh, removed in source) were about six percent of
   sampled background steps.
7. Honcho memory model: H1 to H6 of the
   [plan](docs/honcho-standard-memory-plan.md) ran on 2026-10-10
   ([ADR-0115](docs/adr/0115-honcho-session-revisions.md),
   [ADR-0122](docs/adr/0122-honcho-fresh-start.md)) on the owner's development machine
   development installation, with the Claude provider. Same-topic recall, private
   recall and group isolation passed
   ([status](docs/mvp-acceptance-status.md)). Open items:
   - Reply latency: the median was 88 s and the slowest 172 s. Most of it was the
     Hermes run queue (median 30 s), because Telegram dispatch held one lock
     across all chats. Per-chat dispatch lanes
     ([ADR-0125](docs/adr/0125-per-chat-telegram-dispatch-lanes.md)) run on the
     development installation; their Hermes unit tests pass. The reply limit (3)
     and parallel agent runs (4) are owner settings
     ([ADR-0126](docs/adr/0126-owner-set-parallel-replies-and-runs.md)), and
     secret-guard checks run three at a time instead of one
     ([ADR-0127](docs/adr/0127-parallel-guard-checks.md)). The October 11
     live check with all three running had a private recall question take
     148 s after capture; its Hermes queue wait was 6 ms, and its Honcho
     recall tool took 78 s. That recall asked four connected peers one after
     another, each Honcho reasoning call with its own guarded embeddings, so
     recall now asks them side by side
     ([check](test/store-native-memory.test.ts)), and guard preparation for
     Honcho's provider requests no longer runs one at a time
     ([ADR-0137](docs/adr/0137-side-by-side-runtime-context-guarding.md)). A
     concurrent group reply was not measured because the group message was
     not addressed to Nocheh. The October 12 rerun answered an addressed
     group message in 30 s and a private recall question in 33 s side by
     side; a group recall question took 80 s, 40 s of it Honcho recall with
     the peers now asked side by side. A later cross-topic check recalled
     across topics but took 109–202 s: Honcho recall took 51–75 s, and the
     group's topics waited 53 and 76 s behind each other in one dispatch
     lane, so each topic now has its own lane
     ([ADR-0136](docs/adr/0136-per-topic-dispatch-lanes.md)). The live retest
     ran two topics side by side in 91 and 101 s with Honcho recall at 38–44 s.
     It still made 38 detector calls, 97% of their fragments repeats of text
     another audience had already checked, so detector results are now shared
     by text ([ADR-0138](docs/adr/0138-shared-context-detection.md)). The
     next two-topic test answered in 34 and 37 s with 16 detector calls, but
     made no Honcho recall call and reused per-topic turn-start context cached
     earlier, so the shared-result effect on a never-used topic is still
     unmeasured. Nine of those calls were background memory reviews, so reply
     checks now go first and background checks leave one slot free
     ([ADR-0139](docs/adr/0139-reply-checks-before-background-checks.md),
     [slot check](services/hermes/test_runtime.py)). Pending: a live check of
     that change.
   - Honcho-only recall passed live on October 13: a note in one group topic
     was answered correctly in another topic the next day. The fact reached
     Hermes only through `nocheh_memory_recall` (Honcho's answer); the
     turn-start Honcho context, the archive results and per-topic chat history
     did not contain it. The reply waited 33 minutes because the Claude login
     expired overnight while the machine slept; once it renewed, the turn took
     about 87 seconds, 24 of them Honcho recall
     ([live summary](docs/mvp-acceptance-status.md)).
   - Voice notes are archived without transcription and never wait
     ([ADR-0142](docs/adr/0142-external-providers-only.md)); the simulator's
     speech scenarios became `voice_is_archived_without_blocking`.
   - Peer cards are workspace-wide, so only owner turns read them.
   - PDF attachments: preparation now reads a PDF's text layer (pinned
     `unpdf` 1.8.1, in a worker thread with a heap limit and 30-second
     deadline), whole pages up to 200,000 bytes, and records an explicit
     status for unreadable or scanned PDFs
     ([checks](test/pdf-text.test.ts)). Scanned pages are not read (no OCR).
     Pending: the simulator's document scenario now also checks the extracted
     text.
8. Stage timing: steps T1 to T5 of the [stage timing plan](docs/stage-timing-plan.md)
   are implemented and pass focused synthetic checks: the `stage_timings` table with
   14-day retention, Hermes phases and window kept from the run receipt, Inngest
   step and queue timing, transcription, Honcho recall and Telegram send timers,
   `./bin/nocheh admin timings <event|recent>`, and Monitoring › Reply timing.
   Pending: T6 synthetic Telegram simulation (needs Docker), the Hermes gateway
   component test (needs the pinned Hermes image), a live reply inspected with the
   new breakdown after the next authorized restart, and tagging Honcho embedding
   meter rows by event.
9. Storage growth: re-examine every component for uncontrolled growth using the
   [findings](docs/operations-review-plan.md). Inngest telemetry retention now
   defaults to 14 days and covers every Inngest run history table
   ([decision](docs/adr/0111-complete-workflow-history-retention.md)); a running
   Inngest after pruning the newly covered tables is unverified. The same
   setting expires Nocheh's spent workflow publication records and run links
   ([decision](docs/adr/0112-spent-workflow-record-retention.md),
   [checks](test/workflow-retention.test.ts)), and superseded Honcho context
   summaries an hour after a newer one exists
   ([decision](docs/adr/0113-superseded-memory-summary-retention.md)). Honcho
   workspaces of retired guard epochs still remain until ADR-0109. Every Compose
   service now rotates its Docker log (`NOCHEH_LOG_MAX_SIZE` 10m,
   `NOCHEH_LOG_MAX_FILES` 3, owner-adjustable;
   [check](services/hermes/test_configuration.py)); it takes effect when the
   operating containers are next recreated. `./bin/nocheh storage` reports
   database, largest-table and state folder sizes read-only
   ([check](services/hermes/test_storage_report.py)), and Monitoring › Storage
   shows the same report. Broker model-call security events and guard
   invalidation notes now follow the same setting; action and tool security
   events stay as the owner's audit
   ([decision](docs/adr/0121-operational-telemetry-retention.md)). Still
   unbounded: guarded prepared copies (`runtime_prepared_values` and
   `runtime_prepared_inputs`) of superseded guard epochs, which ADR-0109's
   single-workspace model changes; and spool files that fail permanently.
   Finished Hermes journals (outbound, dispatch, async-run and managed-run
   files) can expire after an owner-set number of days
   ([decision](docs/adr/0143-hermes-delivery-log-retention.md),
   [checks](services/hermes/test_journal_retention.py)). On October 13 the
   owner chose "keep data for ever", so both these journals and workflow
   history are kept by default and grow until the owner sets a number of days
   ([decision](docs/adr/0144-keep-history-by-default.md)). The
   Honcho meter now folds calls older than the previous month into monthly
   totals ([decision](docs/adr/0131-honcho-meter-monthly-rollup.md),
   [checks](services/honcho/test_meter.py)). Guard fragments
   of already prepared sources are now removed by the daily retention pass
   ([decision](docs/adr/0130-spent-guard-fragment-retention.md),
   [check](test/workflow-retention.test.ts)).
10. Inngest orchestration: every Nocheh loop outside Inngest is classified
    ([decision](docs/adr/0120-loops-outside-inngest.md)). Product workflows,
    including the Hermes turn and its reply send, run as Inngest functions;
    the rest are adapter capture, the durable handoff and publisher, store
    recovery, health, retention or the Inngest connection, and none becomes a
    cron. The superseded single-database worker is removed; four older modules
    remain only for their tests.
    Steps that come due while the stack restarts or the machine sleeps can fail
    once with `connect_no_healthy_connection` in the seconds before both
    Connect workers re-register (13 runs from October 10 to 12, all background
    memory review or Honcho work); every retry that ran completed, one review
    was still in its backoff wait, and no reply was affected, so no change was
    made.

</pending>
