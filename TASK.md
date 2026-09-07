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
| 5 | Optional guard on every model attempt | Complete: `eb6d319` |
| 6 | Scoped assistant and transcription | Checkpoint `43eea5e`; offline/native-memory verified; live Telegram acceptance pending credentials |
| 7 | Isolated Honcho comparison, maximum $5 | Runnable harness verified; live comparison pending temporary key and separate bridge login |
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

Phase 6 implementation: native Telegram decoding/formatting/sending with durable
dispatch receipts; separate native Hermes memory/session processes per profile;
signed archive capabilities; explicit safe tool set; cross-profile session-search
paths disabled; derived voice transcript persistence/retries; owner-DM-only action
approval. 12 TypeScript/PostgreSQL and 21 Python tests pass, including native PTB
batching/delivery against a fixture transport. Live synthetic memory store, recall
after process restart and other-group isolation pass in the [report](compatibility/results/2026-09-07-assistant-memory.json).
Recall took up to 152 seconds in that run; this is not a latency guarantee.

The Telegram token file remains empty and the conversation policy is disabled.
Actual DM/group/voice/approval delivery and reconnect acceptance are not run, so
Phase 6 is not complete and merging remains blocked. [Setup](docs/telegram.md)
includes capture-only ID discovery without Telegram sends. Continue independent
experiment/operations work while waiting for these credentials.

Phase 7: [the isolated harness](experiments/honcho/README.md) builds and boots the
pinned Honcho and CLIProxyAPI revisions. Five budget/scoring tests pass. Actual
container configuration verifies all nine reasoning routes and the embedding
route use the meter; tokenization works without runtime Internet access. The
native Hermes baseline exposes exactly memory/session search, without inference
during its configuration check. Missing credentials produce zero model calls and
$0 in reservations. [Evidence](compatibility/results/2026-09-07-honcho-harness.json).
Live bridge compatibility, Honcho derivation and comparative recall remain
pending. No temporary API key was supplied and no paid request was made. This
optional pending evaluation does not block production; Phase 6 live acceptance does.
