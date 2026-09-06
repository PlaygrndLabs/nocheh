# Rebuild progress

Accepted plan: [docs/rebuild-plan.md](docs/rebuild-plan.md).
Baseline: `9dd0b58` on `codex/legacy-nocheh`. Work branch: `codex/hermes-rebuild`.
Old persisted data requires no migration.

| Phase | Work | Status |
| --- | --- | --- |
| 0 | Preserve baseline and record architecture | Complete: `add2341` |
| 1 | Prove subscription compatibility | Complete locally; VPS deferred by owner in ADR-0019 |
| 2 | Bootstrap replacement runtime | In progress: shared local-development and automated Compose stack |
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
21 offline tests pass. Hermes-owned login and live refresh are verified; the
refreshed credentials pass chat, detection and transcription with the pinned
upstreams. ADR-0019 removes the unavailable VPS from this rebuild's acceptance gate.
Continue automatically with local Compose, including live container checks. No VPS
has been provisioned or tested.
