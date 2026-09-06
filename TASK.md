# Rebuild progress

Accepted plan: [docs/rebuild-plan.md](docs/rebuild-plan.md).
Baseline: `9dd0b58` on `codex/legacy-nocheh`. Work branch: `codex/hermes-rebuild`.
Old persisted data requires no migration.

| Phase | Work | Status |
| --- | --- | --- |
| 0 | Preserve baseline and record architecture | Complete: `add2341` |
| 1 | Prove subscription compatibility | Complete locally; VPS deferred by owner in ADR-0019 |
| 2 | Bootstrap replacement runtime | Complete: `9d72c32` |
| 3 | Durable capture and archive | Complete: Compose acceptance, actual database outage and native capture tests pass |
| 4 | Import, retrieval, export, replay | Pending |
| 5 | Optional guard on every model attempt | Pending |
| 6 | Scoped assistant and transcription | Pending |
| 7 | Isolated Honcho comparison, maximum $5 | Pending; live portion needs temporary key |
| 8 | Validate, cut over, merge into main | Pending |

Complete acceptance checks, commit each phase, and proceed automatically. Missing
credentials or unrun live checks must never be recorded as successful validation.
The release remains blocked if required subscription transcription does not work.

Phase 1 evidence and reproduction: [compatibility/README.md](compatibility/README.md).
21 offline tests pass. Hermes-owned login and live refresh are verified; the
refreshed credentials pass chat, detection and transcription with the pinned
upstreams. ADR-0019 removes the unavailable VPS from this rebuild's acceptance gate.
Container refresh, native chat, literal detection and Ogg/Opus transcription pass
in [the Compose report](compatibility/results/2026-09-06-compose.json). All five
services start healthy from empty state. Development edits synchronize and restart
both TypeScript and Python services; normal operation retains that same state.
One container HTTP acceptance test and 21 subscription contract tests pass.
No VPS has been provisioned or tested. Phase 3 evidence: [archive behavior and acceptance](docs/archive.md). Three
TypeScript tests (including isolated real PostgreSQL) and six native-integration
tests pass. A real database stop/start recovered the unchanged original exactly
once. Live Telegram and assistant dispatch remain Phase 6 checks. Continue with
Phase 4.
