# Rebuild progress

Accepted plan: [docs/rebuild-plan.md](docs/rebuild-plan.md).
Baseline: `9dd0b58` on `codex/legacy-nocheh`. Work branch: `codex/hermes-rebuild`.
Old persisted data requires no migration.

| Phase | Work | Status |
| --- | --- | --- |
| 0 | Preserve baseline and record architecture | Complete: `add2341` |
| 1 | Prove subscription compatibility | Complete locally; VPS deferred by owner in ADR-0019 |
| 2 | Bootstrap replacement runtime | Complete: `9d72c32` |
| 3 | Durable capture and archive | Complete: `d29dbab` |
| 4 | Import, retrieval, export, replay | Complete: `aa39e60` |
| 5 | Optional guard on every model attempt | Complete: 9 TypeScript/PostgreSQL, 16 Python integration, 21 subscription contract tests; live synthetic guard check passed |
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
once. Live Telegram and assistant dispatch remain Phase 6 checks.

Phase 4: five TypeScript/PostgreSQL tests and nine Python integration tests pass
in the final Compose acceptance suite (2026-09-07). The local CLI rehearsal
imports Telegram Desktop data and supplied media idempotently and exports/reimports
originals without historical replies. Transcript search has matching scope checks;
export preserves derived content, source references and provenance. The earlier
permission-review timeout is resolved.

Phase 5: exact-span masking, destination trust, database caching and the pinned
mandatory HTTPX boundary are implemented. Native synchronous/asynchronous SDK
tests cover retries, route changes, redirects and zero protected sends on guard
failure. Subscription contract tests remain passing. The final live synthetic
check passed all three detector fixtures and native guarded chat; earlier live
detector failures/timeouts are retained in the [report](compatibility/results/2026-09-07-guard.json).
Their transient root cause was not established; required failures remain visible
and fail closed. See [guard operation and limits](docs/guard.md).
The saved default `auto` mode is restored after the required-guard rehearsal.
Continue with Phase 6; the Telegram token and owner/group IDs are not configured.
