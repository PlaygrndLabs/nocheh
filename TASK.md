# Rebuild progress

Accepted plan: [docs/rebuild-plan.md](docs/rebuild-plan.md).
Baseline: `9dd0b58` on `codex/legacy-nocheh`. Work branch: `codex/hermes-rebuild`.
Old persisted data requires no migration.

| Phase | Work | Status |
| --- | --- | --- |
| 0 | Preserve baseline and record architecture | Complete: `add2341` |
| 1 | Prove subscription compatibility | In progress: local chat/detection/STT pass; live refresh and VPS pending |
| 2 | Bootstrap replacement runtime | Pending Phase 1 |
| 3 | Durable capture and archive | Pending |
| 4 | Import, retrieval, export, replay | Pending |
| 5 | Optional guard on every model attempt | Pending |
| 6 | Scoped assistant and transcription | Pending |
| 7 | Isolated Honcho comparison, maximum $5 | Pending; live portion needs temporary key |
| 8 | Validate, cut over, merge into main | Pending |

Complete acceptance checks, commit each phase, and proceed automatically. Missing
credentials or unrun live checks must never be recorded as successful validation.
The release remains blocked if required subscription transcription does not work.

Phase 1 evidence and reproduction: [compatibility/README.md](compatibility/README.md).
19 offline tests pass. The subscription-only paths pass locally using the pinned
Hermes revision and codex-asr image; this is not target-VPS validation. Resume by
completing the fresh Hermes device login and supplying the VPS host/user and
application directory, then run the required live checks. Keep the legacy runtime
until the phase gate passes.
