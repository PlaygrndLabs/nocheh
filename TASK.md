# Nocheh implementation status

This is the current status ledger, last reconciled on 2026-09-24. [SPECS.md](SPECS.md)
defines the intended product; [AGENTS.md](AGENTS.md) defines working rules.
[Status history](docs/task-history.md) summarizes completed and superseded work.
The complete previous ledger remains in Git at `ab643dc:TASK.md` (`git show
ab643dc:TASK.md`); its dated claims are historical, not current acceptance.

## Release decision

**MVP release acceptance is not established.** The tested code is integrated into
local `main`. The controlled reset erased the reviewed old scope and initialized
`original-only-v1`, but four inactive fences remain. The empty-baseline gate stopped
on 19 historical admin files whose deletion automatic approval review rejected
outside the exact 13 erase / three preserve decisions. The Telegram boundary,
fresh live checks, and post-reset Honcho production gate have not run.

| Area | Last established state | Remaining gate |
| --- | --- | --- |
| Candidate code | The 2026-09-24 isolated gate passed 137 Node/dashboard checks (46 fixture skips), database-loss recovery, and 358 native Hermes tests (three skips). The tested increments `cf33979`, `d3f5ef0`, and `2abc54b` were merged into local `main`. | Repeat affected checks if the candidate changes; these results do not validate live activation. [Evidence](compatibility/results/2026-09-24-mvp-live-findings-followup.json) |
| Message retirement and reactions | The original-only candidate has an owner-only, revision-checked Archive retirement action keyed to the Telegram message identity, with immutable evidence and undo; it excludes retired sources from agent reads and learning, revokes contexts, and preserves delivered or uncertain replies. Reaction updates have current per-actor/anonymous-count state and stale observations are excluded. A synthetic Compose gate passed 10 focused and adjacent checks; seven pinned Hermes capture tests passed offline. An isolated owner dashboard preview confirmed retire and undo on a synthetic voice message with original audio/transcript still visible. | The new layout is initialized but runtime activation is fenced. After the empty baseline and boundary, run fresh owner retirement and non-owner human old-message reaction change/removal checks with event IDs and timestamps. Verify group admin rights and actual reaction delivery; absent updates remain pending or failed. [Candidate evidence](compatibility/results/2026-09-24-retirement-reactions-candidate.json), [procedure](docs/release-acceptance.md) |
| Running installation | The reset journal completed through `initialized`. Four fresh database/cache services and three fresh volumes are running in `original-only-v1` with restart ownership disabled. Four inactive fences hold runtime agents, ingress, scheduling, and execution. | Prove the empty baseline, confirm the one-time Telegram backlog boundary, and enter fresh acceptance mode before owner traffic. [Current reset evidence](compatibility/results/2026-09-25-reset-initialized-baseline-blocker.json) |
| Storage transition | The exact 13 reviewed external erase items are absent; all three unrelated items retain their device/inode identities. The 1,974-entry file manifest was processed, and the exact 17 old containers and three old volumes were removed. Saved setup, credentials, provider accounting, native preferences, and Honcho spending verified as retained. Fresh stores initialized with no native content copied. The empty-store validator reached its private admin inventory and stopped on 19 old artifacts: 18 preflight/ownership JSON files and one historical configuration snapshot. | The 19-file retirement needs explicit approval because automatic approval review rejected it as an expansion beyond the 13/3 decision. Then rerun empty-baseline verification, the Telegram boundary, and live acceptance. [Plan](docs/original-only-archive-plan.md), [evidence](compatibility/results/2026-09-25-reset-initialized-baseline-blocker.json) |
| Live Telegram | On the rebuilt pre-reset installation, an ordinary owner DM kept its harmless marker in the guarded copy. A group reply was delivered once, with no private phrase or raw internal citation; the owner found it clear and private. Eleven group context items excluded the private phrase and source ID. Capture-to-delivery took 86.453 seconds versus about 125.4 seconds in the prior observation; 85.346 seconds preceded the assistant result. | Repeat fresh checks after reset, obtain a non-owner human group reply/reaction, and verify active in-flight send recovery. The measured group turn remains slow and is not a controlled causal latency comparison. [Live smoke](compatibility/results/2026-09-24-live-smoke-after-rebuild.json) |
| Subscription transcription | The quiet original remained byte-for-byte intact. Its first attempt under the activated fix returned terminal `invalid_transcription_response` on attempt 10, with no transcript or assistant send; preparation and Telegram workflows failed at transcription. A fresh owner note spoke the exact release sentence; the subscription transcript matched exactly in one attempt, its guarded copy preserved the sentence, original bytes/hash and Telegram envelope were saved, and one linked reply was delivered. | The pre-reset voice gate and quiet-note handling passed. Repeat the voice check after the controlled storage transition as part of release acceptance. [Quiet-note outcome](compatibility/results/2026-09-24-quiet-voice-live-outcome.json), [exact-phrase evidence](compatibility/results/2026-09-24-exact-owner-voice-gate.json) |
| Honcho | Earlier attached production ingestion, scoped recall, outage, and restart acceptance passed on the former installation. Fresh Honcho PostgreSQL and Redis are initialized, while API, deriver, and provider gateway remain fenced. The preserved login, embedding credential, and spending ledger have not yet undergone post-reset production acceptance. | Fresh post-reset subscription reasoning, guarded embedding, ingestion, retrieval, restart, provider-failure recovery, ready workspace, and completed projection receipt. Opted-in history and monthly-cap activation remain separate. [Earlier acceptance](compatibility/results/2026-09-15-honcho-production-acceptance.json), [fresh procedure](docs/release-acceptance.md) |
| Remote Git | The latest code increments were merged into local `main` under the shared integration lock. Fetch succeeded before those merges; HTTPS push could not read a GitHub username. | Push and verify `origin/main` once authentication is available. Report local and remote outcomes separately. |

## Next actions

The owner-approved 13/3 reset scope was erased and independently checked. The new
`original-only-v1` stores were initialized with four inactive fences and no runtime
activation. The empty-store check reached the reset admin inventory and stopped on
19 historical files outside the approved 13/3 review. Automatic approval review
rejected their irreversible deletion, and the owner was asked to decide that exact
additional scope. The Telegram backlog boundary has not been attempted; no fresh
owner traffic should be sent until it is confirmed and acceptance mode starts.
[Current reset evidence](compatibility/results/2026-09-25-reset-initialized-baseline-blocker.json).

1. Await the owner's decision on the exact 19 historical files. If approved, retire them by their saved identities and rerun the [empty-baseline gate](docs/original-only-archive-plan.md), then confirm the one-time Telegram backlog boundary and enter acceptance mode. If kept, leave the installation fenced and the empty-baseline gate pending. [Blocker evidence](compatibility/results/2026-09-25-reset-initialized-baseline-blocker.json).
2. Run the [live release procedure](docs/release-acceptance.md) with new post-boundary event and receipt IDs. It requires ordinary owner messages, voice, intentional silence, private/group isolation, a non-owner human reply and reaction in the designated group, exact owner approval, reconnect/restart recovery, and active memory recall after an owner correction. Record failures as well as passes.
3. Repeat Honcho's production acceptance against the post-reset installation within the existing cap. Establish its verified connection, ready workspace, new context snapshot, and completed ingestion receipt before claiming memory active.
4. Investigate the remaining group delay before release: a pre-reset turn on the updated code delivered in 86.453 seconds, with 85.346 seconds before the assistant result. The reply had no internal citation, but this single faster observation does not establish a reliable latency improvement. [Live timing](compatibility/results/2026-09-24-live-smoke-after-rebuild.json).
5. Verify in-flight send and uncertain-delivery recovery on the release candidate. Isolated gateway/store replay and one completed-action replay against the active legacy installation passed; active in-flight recovery is still pending. [Replay evidence](compatibility/results/2026-09-24-mvp-live-findings-followup.json).
6. After original-only activation, perform the new live retirement and reaction checks in [the release procedure](docs/release-acceptance.md). Save the captured owner event, target message, and each human reaction update ID and timestamp; confirm admin rights and that no old conversation reply is sent. Do not count synthetic fixture traffic or missing reaction updates as a live pass.

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
