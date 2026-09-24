# Nocheh implementation status

This is the current status ledger, last reconciled on 2026-09-24. [SPECS.md](SPECS.md)
defines the intended product; [AGENTS.md](AGENTS.md) defines working rules.
[Status history](docs/task-history.md) summarizes completed and superseded work.
The complete previous ledger remains in Git at `ab643dc:TASK.md` (`git show
ab643dc:TASK.md`); its dated claims are historical, not current acceptance.

## Release decision

**MVP release acceptance is not established.** The tested code is integrated into
local `main`, but the installation still uses the `legacy` storage layout. The
controlled transition, empty-baseline proof, fresh post-reset live checks, and
post-reset Honcho production gate have not run. Git integration, healthy services,
and isolated tests do not complete those gates.

| Area | Last established state | Remaining gate |
| --- | --- | --- |
| Candidate code | The 2026-09-24 isolated gate passed 137 Node/dashboard checks (46 fixture skips), database-loss recovery, and 358 native Hermes tests (three skips). The tested increments `cf33979`, `d3f5ef0`, and `2abc54b` were merged into local `main`. | Repeat affected checks if the candidate changes; these results do not validate live activation. [Evidence](compatibility/results/2026-09-24-mvp-live-findings-followup.json) |
| Running installation | On 2026-09-24, the owner requested an app rerun. The locally integrated `nocheh-app` and `hermes` images were rebuilt; only those two containers were recreated. All 17 owned services were healthy afterward, Telegram was connected, guard mode was on, and no execution holds were present. Fresh synthetic subscription, harmless-marker, explicit-password, and citation-renderer checks passed. | Fresh owner voice and group tests, group latency, active in-flight send recovery, controlled reset, and post-reset acceptance remain pending. [Current rebuild evidence](compatibility/results/2026-09-24-main-app-rebuild.json) |
| Storage transition | The original-only three-store candidate, scoped reset, and acceptance validator passed isolated rehearsals. The saved installation layout is `legacy`. The latest read-only inventory found 17 owned containers, three volumes, 56 classified paths, zero ownership blockers, and 16 undecided immediate items across five external review roots. | Resolve the exact external-item review, execute the documented controlled transition, and prove the new empty baseline. [Plan](docs/original-only-archive-plan.md) |
| Live Telegram | Pre-reset owner text, source/transcript persistence, group silence and private/group boundary, ordinary-language exact approval, and queued-message restart recovery have recorded observations. The voice marker was masked in its guarded copy; the group reply exposed an internal event ID and took 125.4 seconds. Code fixes have isolated checks only. | Repeat affected voice and group checks on the updated installation after reset; complete fresh owner and non-owner human group reply/reaction checks. Recheck latency and uncertain in-flight send recovery. [Pre-reset observations](compatibility/results/2026-09-23-post-rebuild-live-test.json), [fix evidence](compatibility/results/2026-09-24-mvp-live-findings-followup.json) |
| Subscription transcription | A real owner voice source, bytes/hash, automatic Ogg/Opus transcript, and one reply were observed pre-reset. A separate live synthetic subscription probe passed refresh, exact chat, literal detection, and transcription; an earlier exact-chat probe timed out after 129 seconds and remains a reliability observation. | Fresh post-reset owner voice acceptance and a clean guarded answer on the updated detector. [Current-revision probe](compatibility/results/2026-09-23-mvp-real-test-current-revision.json) |
| Honcho | Earlier attached production ingestion, scoped recall, outage, and restart acceptance passed on the former installation. The current pre-reset service was running with its subscription login, embedding credential, and $5 pilot cap; health alone does not establish attachment or acceptance after reset. | Fresh post-reset subscription reasoning, guarded embedding, ingestion, retrieval, restart, provider-failure recovery, ready workspace, and completed projection receipt. Opted-in history and monthly-cap activation remain separate. [Earlier acceptance](compatibility/results/2026-09-15-honcho-production-acceptance.json), [fresh procedure](docs/release-acceptance.md) |
| Remote Git | The latest code increments were merged into local `main` under the shared integration lock. Fetch succeeded before those merges; HTTPS push could not read a GitHub username. | Push and verify `origin/main` once authentication is available. Report local and remote outcomes separately. |

## Next actions

The 2026-09-24 requested local app and bot rebuild is complete. It did not reset
the installation or send a Telegram test message. The exact 16 external reset
items remain undecided, and fresh live acceptance has not run. [Content-free
activation evidence](compatibility/results/2026-09-24-main-app-rebuild.json).

1. Review the exact 16 external reset items and confirm ownership/effect in the private reset record. Preserve saved configuration, external logins, and spending accounting according to the [reset plan](docs/original-only-archive-plan.md).
2. Run the controlled `legacy` to `original-only-v1` transition and inspect its receipt, then prove the empty baseline before resuming saved policies or writers. The read-only preflight is not reset authorization or execution evidence.
3. Run the [live release procedure](docs/release-acceptance.md) with new post-boundary event and receipt IDs. It requires ordinary owner messages, voice, intentional silence, private/group isolation, a non-owner human reply and reaction in the designated group, exact owner approval, reconnect/restart recovery, and active memory recall after an owner correction. Record failures as well as passes.
4. Repeat Honcho's production acceptance against the post-reset installation within the existing cap. Establish its verified connection, ready workspace, new context snapshot, and completed ingestion receipt before claiming memory active.
5. Measure a fresh end-to-end group turn on the updated code. The duplicate native-profile preparation was removed, but an isolated warm-call benchmark measured only a small saving and did not explain the 125.4-second observed turn. Confirm no internal event citation reaches the reply. [Timing and fix evidence](compatibility/results/2026-09-24-mvp-live-findings-followup.json).
6. Verify in-flight send and uncertain-delivery recovery on the release candidate. Isolated gateway/store replay and one completed-action replay against the active legacy installation passed; active in-flight recovery is still pending. [Replay evidence](compatibility/results/2026-09-24-mvp-live-findings-followup.json).

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

- **Space-memory filters:** native-note/transcript filtering, its provider-payload/destination extension, and live native-review/filter quality and browser policy-save checks remain pending. [Boundaries](docs/space-memory-plan.md).
- **Per-session previews:** explicit isolation for Compose projects, networks, images, ports, state, and credentials remains unimplemented. A worktree alone does not isolate the running installation.
- **`make dev`:** declared phony without a recipe. `./scripts/nocheh dev` targets the local installation's Compose Watch workflow. An isolated fresh-worktree setup and visible persistent preview are follow-up tooling work.
- **VPS:** deferred; local Docker Compose remains the acceptance environment.
