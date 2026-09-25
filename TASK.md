# Nocheh implementation status

This is the current status ledger, last reconciled on 2026-09-25. [SPECS.md](SPECS.md)
defines the intended product; [AGENTS.md](AGENTS.md) defines working rules.
[Status history](docs/task-history.md) summarizes completed and superseded work.
The complete previous ledger remains in Git at `ab643dc:TASK.md` (`git show
ab643dc:TASK.md`); its dated claims are historical, not current acceptance.

## Release decision

**MVP release acceptance is not established.** The tested code is integrated into
local `main`. The controlled reset erased the reviewed old scope, initialized
`original-only-v1`, and passed the empty baseline after the owner approved removal
of 19 historical admin files. The owner then directed removal of old archive and
memory data while retaining auth/settings and rebuilding the app. Six runtime
images rebuilt, the one-time Telegram backlog discard was confirmed, and all 17
services started healthy in fresh acceptance mode with restart ownership off.
The post-reset owner voice and intentional group-silence checks passed. The rest
of fresh live acceptance and post-reset Honcho production acceptance have not passed.

| Area | Last established state | Remaining gate |
| --- | --- | --- |
| Candidate code | The 2026-09-24 isolated gate passed 137 Node/dashboard checks (46 fixture skips), database-loss recovery, and 358 native Hermes tests (three skips). The tested increments `cf33979`, `d3f5ef0`, and `2abc54b` were merged into local `main`. | Repeat affected checks if the candidate changes; these results do not validate live activation. [Evidence](compatibility/results/2026-09-24-mvp-live-findings-followup.json) |
| Message retirement and reactions | The original-only candidate has owner-only, revision-checked retirement and current reaction state. A live post-reset voice source was retired through the backend and undone at revision 2; its original audio, transcript, and confirmed reply remained. The active Archive UI cannot load retirement because its management route allowlist omits the endpoint; an isolated fix and tests passed, but the running image has not changed. The selected-group bot is currently a regular member, so Telegram will not deliver the required individual reaction updates. | Verify retirement and undo through the repaired Archive UI after a controlled image transition. Promote the bot to group administrator with the minimum needed rights, then capture a non-owner human old-message reaction change and removal with event IDs and timestamps. [Live route evidence](compatibility/results/2026-09-25-live-dashboard-routes.json), [procedure](docs/release-acceptance.md) |
| Running installation | The reset journal completed through `telegram_boundary`; acceptance mode is `acceptance_running`. All 17 fresh services are running healthy in `original-only-v1`; all retain restart policy `no`, and the four inactive fences were removed. The first startup attempt stopped short of acceptance when a required service was not running; a retry using the same container identities passed without a second backlog discard. | Complete new post-boundary live checks, then verify `fresh_acceptance` before restoring saved restart ownership. [Current reset evidence](compatibility/results/2026-09-25-reset-rebuilt-acceptance-mode.json) |
| Storage transition | The exact 13 reviewed external erase items are absent; all three unrelated items retain their device/inode identities. The 1,974-entry file manifest was processed, and the exact 17 old containers and three old volumes were removed. Saved setup, credentials, provider accounting, native preferences, and Honcho spending verified as retained. The owner approved retirement of 19 historical admin artifacts by saved identity. Fresh archive and derived rows, Inngest and Honcho database relations and cache keys, and native original files all verified empty before the Telegram boundary. After startup, archive events remain zero; eight new derivative receipts record `deleteWebhook` intents/results, with no event-bound derivative. | Fresh content and memory release checks remain pending; ordinary post-boundary runtime activity can create new operational rows. [Plan](docs/original-only-archive-plan.md), [evidence](compatibility/results/2026-09-25-reset-rebuilt-acceptance-mode.json) |
| Live Telegram | Post-reset voice, intentional silence, private/group isolation, and exact owner approval passed; the owner saw exactly one approved delivery. A post-delivery restart of the same Hermes container preserved one reply and its durable receipt, with no visible duplicate. A non-owner human group message was captured but suppressed with `conversation_not_selected`: the saved policy grants no non-owner participant. Monitoring shows a false receive-path warning because the rebuilt storage API lacks `/v1/runtime`; an isolated route fix passed tests but is not active. | Run a permitted non-owner human reply and reaction, fresh UI retirement, correction, and in-flight recovery checks. Resolve group access without invalidating the reset journal's container-identity gate. Investigate the voice delay. [Live checks](compatibility/results/2026-09-25-live-telegram-checks.json), [route evidence](compatibility/results/2026-09-25-live-dashboard-routes.json) |
| Subscription transcription | The pre-reset quiet-note failure preserved its original and stopped automatic retry; a separate exact-phrase note passed before reset. The first post-reset owner voice note saved 12,524 original bytes with a matching SHA-256 manifest. Subscription transcription produced the exact release sentence in one attempt, the selected guarded copy preserved it unchanged, and one linked Telegram reply was delivered. | The post-reset exact-phrase voice gate passed. Continue the other fresh live acceptance checks. [Post-reset evidence](compatibility/results/2026-09-25-post-reset-owner-voice.json), [quiet-note outcome](compatibility/results/2026-09-24-quiet-voice-live-outcome.json) |
| Honcho | Earlier attached production ingestion, scoped recall, outage, and restart acceptance passed on the former installation. Fresh Honcho PostgreSQL and Redis passed empty-baseline checks; API, deriver, and provider gateway are healthy. After the post-reset voice turn, the control connection is still unattached and unverified, with zero ready generations, ingestion receipts, or context snapshots. | Fresh post-reset subscription reasoning, guarded embedding, ingestion, retrieval, restart, provider-failure recovery, ready workspace, and completed projection receipt before owner attachment can count as accepted memory. Opted-in history and monthly-cap activation remain separate. [Current observation](compatibility/results/2026-09-25-post-reset-owner-voice.json), [fresh procedure](docs/release-acceptance.md) |
| Remote Git | The latest code increments were merged into local `main` under the shared integration lock. Fetch succeeded before those merges; HTTPS push could not read a GitHub username. | Push and verify `origin/main` once authentication is available. Report local and remote outcomes separately. |

## Next actions

The content baseline passed before activation. The one-time Telegram boundary was
confirmed, and the rebuilt local installation entered acceptance mode with 17
healthy services and no automatic restart ownership. Auth and settings remain;
the post-start read-only check found zero archive events and eight new operational
`deleteWebhook` derivative receipts. A fresh owner voice note then passed the
post-reset exact-phrase transcription and delivery gate; the owner confirmed its
single reply was clear. A new configured-group owner note then passed intentional
silence with no observed bot delivery. The voice turn took 224.844 seconds from
capture to delivery. Honcho remains unattached with no new memory receipts.
The journal has not completed fresh live acceptance or resumption. [Current reset evidence](compatibility/results/2026-09-25-reset-rebuilt-acceptance-mode.json), [voice evidence](compatibility/results/2026-09-25-post-reset-owner-voice.json), [silence evidence](compatibility/results/2026-09-25-post-reset-group-silence.json).

1. Continue the [live release procedure](docs/release-acceptance.md) with new post-boundary event and receipt IDs. Voice, intentional silence, private/group isolation, and exact owner-approved delivery passed. A restart after one completed Telegram reply retained its durable receipt and produced no visible duplicate; in-flight send recovery remains pending. A non-owner human reply, reaction, Archive UI retirement, and active memory recall after an owner correction remain. The bot needs Telegram group administrator status for reaction updates, and the saved group policy needs an explicit non-owner grant before that person's conversation can dispatch. Applying that setting may replace recorded reset containers, so reconcile the acceptance journal before doing so. Only after its validator passes can the reset resume saved restart policies. [Live checks](compatibility/results/2026-09-25-live-telegram-checks.json).
2. Repeat Honcho's production acceptance against the post-reset installation within the existing cap. Its control connection is unattached; establish verified reasoning, guarded embedding, ingestion, retrieval, restart and failure recovery, then a ready workspace, new context snapshot, and completed ingestion receipt before claiming memory active.
3. Investigate the 224.844-second post-reset voice capture-to-delivery delay before release, including the large event-bound processing trace. The earlier pre-reset group turn took 86.453 seconds and does not provide a controlled voice comparison. [Current timing](compatibility/results/2026-09-25-post-reset-owner-voice.json), [earlier timing](compatibility/results/2026-09-24-live-smoke-after-rebuild.json).
4. Verify in-flight send and uncertain-delivery recovery on the release candidate. Isolated gateway/store replay and one completed-action replay against the active legacy installation passed; active in-flight recovery is still pending. [Replay evidence](compatibility/results/2026-09-24-mvp-live-findings-followup.json).
5. Perform the new live retirement and reaction checks in [the release procedure](docs/release-acceptance.md). Save the captured owner event, target message, and each human reaction update ID and timestamp; confirm admin rights and that no old conversation reply is sent. Do not count synthetic fixture traffic or missing reaction updates as a live pass.

## Implemented areas and evidence

These are implementation checkpoints, not substitutes for the release decision above.

| Area | Recorded checkpoint |
| --- | --- |
| Runtime, dashboard, and controlled actions | P1–P6 and dashboard D1–D4 were implemented; P7 recovery tooling and earlier consolidated local acceptance passed. [Runtime plan](docs/runtime-platform-plan.md), [operations evidence](compatibility/results/2026-09-08-runtime-platform-operations.json) |
| Guarded projections and source ownership | Owner edits, audience checks, source-only archive browsing, derivative provenance, and three-store repositories have candidate evidence. [Guarded acceptance](compatibility/results/2026-09-09-guarded-memory-acceptance.json), [storage plan](docs/original-only-archive-plan.md) |
| Provider and workflows | The shared CPA route and one-login refresh ownership were accepted locally. All nine Inngest workflow families were active at epoch 2 in the earlier consolidated installation. [Provider cutover](compatibility/results/2026-09-14-shared-provider-cutover.json), [workflow consolidation](compatibility/results/2026-09-16-consolidated-services.json) |
| Owner UI and entity memory | Archive, Databases, Sharing, Activity, People/Projects, and the Memory map have isolated build, fixture, and preview evidence. The original-only layout and newest UI changes still require installation verification where noted in the [history](docs/task-history.md). [Entity evidence](compatibility/results/2026-09-20-connected-entity-memory.json) |
| Backup and recovery | Isolated format-6 backup/inactive restore, scoped reset, and fresh-acceptance validation passed synthetic rehearsals. The populated live post-reset run remains pending. [Storage plan](docs/original-only-archive-plan.md) |

## Development follow-ups

- **Deleted Telegram messages:** Ordinary Bot API deletions remain unobservable. The owner chose exact Archive retirement rather than an implicit second-message replacement; the original-only candidate implements that decision, while live activation and checks remain pending. The screenshot showed a first deleted voice note Waiting and a second Processing, but their final outcomes were not established. Verify a real owner retirement with saved event IDs after the layout transition, preserving the first captured source. [Telegram Bot API Update fields](https://core.telegram.org/bots/api#update).
- **Space-memory filters:** native-note/transcript filtering, its provider-payload/destination extension, and live native-review/filter quality and browser policy-save checks remain pending. [Boundaries](docs/space-memory-plan.md).
- **Per-session previews:** explicit isolation for Compose projects, networks, images, ports, state, and credentials remains unimplemented. A worktree alone does not isolate the running installation.
- **`make dev`:** declared phony without a recipe. `./scripts/nocheh dev` targets the local installation's Compose Watch workflow. An isolated fresh-worktree setup and visible persistent preview are follow-up tooling work.
- **VPS:** deferred; local Docker Compose remains the acceptance environment.
