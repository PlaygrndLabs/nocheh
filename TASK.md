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
| Live Telegram | On the rebuilt pre-reset installation, an ordinary owner DM kept its harmless marker in the guarded copy. A group reply was delivered once, with no private phrase or raw internal citation; the owner found it clear and private. Eleven group context items excluded the private phrase and source ID. Capture-to-delivery took 86.453 seconds versus about 125.4 seconds in the prior observation; 85.346 seconds preceded the assistant result. | Repeat fresh checks after reset, obtain a non-owner human group reply/reaction, and verify active in-flight send recovery. The measured group turn remains slow and is not a controlled causal latency comparison. [Live smoke](compatibility/results/2026-09-24-live-smoke-after-rebuild.json) |
| Subscription transcription | The rebuilt installation captured three owner voice notes. The first, a 2.127-second quiet recording, returned no transcript and remained pending after four failed attempts. Two later notes produced subscription transcripts, guarded copies without raw masks, and confirmed replies, but neither transcript contained the full requested sentence. | Resolve the failed note and transcription quality before treating voice acceptance as passed; repeat the owner voice gate after reset. [Live smoke](compatibility/results/2026-09-24-live-smoke-after-rebuild.json), [current-revision probe](compatibility/results/2026-09-23-mvp-real-test-current-revision.json) |
| Honcho | Earlier attached production ingestion, scoped recall, outage, and restart acceptance passed on the former installation. The current pre-reset service was running with its subscription login, embedding credential, and $5 pilot cap; health alone does not establish attachment or acceptance after reset. | Fresh post-reset subscription reasoning, guarded embedding, ingestion, retrieval, restart, provider-failure recovery, ready workspace, and completed projection receipt. Opted-in history and monthly-cap activation remain separate. [Earlier acceptance](compatibility/results/2026-09-15-honcho-production-acceptance.json), [fresh procedure](docs/release-acceptance.md) |
| Remote Git | The latest code increments were merged into local `main` under the shared integration lock. Fetch succeeded before those merges; HTTPS push could not read a GitHub username. | Push and verify `origin/main` once authentication is available. Report local and remote outcomes separately. |

## Next actions

The requested app and bot rebuild is active. The owner then sent live pre-reset
smoke traffic; group privacy and citation passed, while voice transcription and
quality remain unresolved. The controlled reset still awaits review of the 16
external items. [Content-free live evidence](compatibility/results/2026-09-24-live-smoke-after-rebuild.json).

1. Review the exact 16 external reset items and confirm ownership/effect in the private reset record. Preserve saved configuration, external logins, and spending accounting according to the [reset plan](docs/original-only-archive-plan.md).
2. Run the controlled `legacy` to `original-only-v1` transition and inspect its receipt, then prove the empty baseline before resuming saved policies or writers. The read-only preflight is not reset authorization or execution evidence.
3. Run the [live release procedure](docs/release-acceptance.md) with new post-boundary event and receipt IDs. It requires ordinary owner messages, voice, intentional silence, private/group isolation, a non-owner human reply and reaction in the designated group, exact owner approval, reconnect/restart recovery, and active memory recall after an owner correction. Record failures as well as passes.
4. Repeat Honcho's production acceptance against the post-reset installation within the existing cap. Establish its verified connection, ready workspace, new context snapshot, and completed ingestion receipt before claiming memory active.
5. Investigate the remaining group delay before release: a pre-reset turn on the updated code delivered in 86.453 seconds, with 85.346 seconds before the assistant result. The reply had no internal citation, but this single faster observation does not establish a reliable latency improvement. [Live timing](compatibility/results/2026-09-24-live-smoke-after-rebuild.json).
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

- **Deleted Telegram voice notes:** The Bot API supplies no deletion update for ordinary bot chats. The 2026-09-24 owner report showed a deleted first voice note still Waiting and a second note Processing; those screenshot states do not establish their final outcomes. Clarify whether the desired interaction is an explicit cancel/replace action or a short-window replacement rule before changing reply semantics. Verify the chosen behavior with two real owner notes and saved event IDs; preserve the first captured source as evidence. [Telegram Bot API Update fields](https://core.telegram.org/bots/api#update).
- **Space-memory filters:** native-note/transcript filtering, its provider-payload/destination extension, and live native-review/filter quality and browser policy-save checks remain pending. [Boundaries](docs/space-memory-plan.md).
- **Per-session previews:** explicit isolation for Compose projects, networks, images, ports, state, and credentials remains unimplemented. A worktree alone does not isolate the running installation.
- **`make dev`:** declared phony without a recipe. `./scripts/nocheh dev` targets the local installation's Compose Watch workflow. An isolated fresh-worktree setup and visible persistent preview are follow-up tooling work.
- **VPS:** deferred; local Docker Compose remains the acceptance environment.
