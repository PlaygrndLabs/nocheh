# Guarded projections and primary Honcho memory (ADR-0033)

Owner-approved replacement plan: [guarded-memory-plan.md](docs/guarded-memory-plan.md).
These phases are distinct from the earlier runtime-platform phases below. G1 commit: `7d474a1`; G2 commit: `c99d324`.

| Phase | Actual status |
| --- | --- |
| G1 — Durable guarded versions | Complete; 42 JS/TS checks and 91 pinned Hermes Python checks pass; new routing inactive |
| G2 — Owner dashboard editor | Complete; owner API, conflict/race tests and synthetic browser edit/history/restore pass |
| G3 — On/off throughout | Complete; 45 JS/TS and 94 pinned Hermes checks pass; Compose activation remains G7 |
| G4 — Live Honcho connection | Pending; dedicated credentials required |
| G5 — Primary Honcho memory | Pending |
| G6 — Edits, switching and recovery | Pending |
| G7 — Local acceptance and final graph | Pending |

G1 evidence: isolated PostgreSQL covers byte preservation, duplicate/concurrent capture,
restart, partial detector failure recovery, derived text and consent separation. Host
suite setup failures were resolved using explicit fixture DB credentials and the pinned
Hermes image. AST graph refreshed without model calls.

# Rebuild progress

Memory/privacy work is tracked separately in [space-memory-plan.md](docs/space-memory-plan.md)
and ADR-0030, on the isolated `codex/memory-space-policies` worktree.

## Owner dashboard extension — 2026-09-07

Accepted [dashboard/CLI plan](docs/dashboard-cli-plan.md), ADR-0025. Each increment
is committed separately; these do not replace the production release gates below.

| Increment | Actual status |
| --- | --- |
| D1 — Compatibility and configuration | Complete: native preferences persist, validated config show/set/apply with redaction/conflict/recovery; 12 configuration/scope tests plus one pinned dashboard auth/extension test pass |
| D2 — Dashboard and import jobs | Complete: local native dashboard extension, shared owner API, settings, archive search and durable manual imports; 16 TypeScript tests and 39 pinned Python tests pass |
| D3 — Native memory and isolated Honcho CLI | Pending |
| D4 — Source graph and operations | Pending |

D1 also built the pinned upstream dashboard frontend successfully from its npm
lockfile in a temporary directory. Packaging and serving it are D2 work. No live
provider requests or production setting changes were required for D1 verification.

D2 [dashboard instructions](docs/dashboard.md). The local browser renders live
archive status, redacted settings and upload controls. HTTP acceptance verifies
unauthorized/cross-site rejection and cancellation/restart/resume using isolated
fixtures. ZIP traversal/symlink and changed-export failures pass. Existing real
PostgreSQL import/export tests verify exact originals and silent replay. Native
agent/mutation routes are denied at the dashboard ASGI boundary. Production
Telegram/provider configuration was not changed by these dashboard checks.

After the requested reset on 2026-09-07, a fresh Compose runtime was started with
the supplied Telegram bot token and owner/group IDs in the ignored `.env`.
All five services are healthy. Fresh Hermes sign-in and live subscription checks
pass. Telegram is enabled: the owner's real `/start` was captured, dispatched and
answered with confirmed Telegram delivery. Four real text messages in the selected
group were also captured and answered; no batch of older history arrived.
An optional read-only pgweb browser is available with `./scripts/nocheh db`.
The rebuild is
**not released**: remaining Telegram acceptance,
cutover and the merge to `main` remain pending.

Accepted plan: [docs/rebuild-plan.md](docs/rebuild-plan.md).
Baseline: `9dd0b58` on `codex/legacy-nocheh`. Work: `codex/hermes-rebuild`.
No legacy data migration is required. VPS work is deferred by ADR-0019.

| Phase | Actual status |
| --- | --- |
| 0 — Preserve baseline and architecture | Complete: `add2341` |
| 1 — Subscription compatibility | Complete locally: `8fd69cc` |
| 2 — Compose runtime | Complete: `9d72c32` |
| 3 — Durable capture and archive | Complete: `d29dbab` |
| 4 — Import, search, export, replay | Complete: `aa39e60` |
| 5 — Optional outgoing guard | Complete: `eb6d319` |
| 6 — Scoped assistant and voice | Implemented at `43eea5e`; real owner DM and four group replies pass; full group isolation/silence, voice, approval and reconnect checks pending |
| 7 — Honcho comparison, maximum $5 | Runnable harness at `2d27262`; live comparison pending separate credentials; optional |
| 8 — Operations, cutover, merge | Backup/restore implemented at `4efe7c3`; real Telegram gate, cutover and merge pending |

## Last validation before the reset — 2026-09-07

- 14 TypeScript tests pass against real Compose PostgreSQL where required;
  30 Python native integration/operations tests pass. No main-suite skips.
- 21 subscription contracts pass with simulated transport failures. Five Honcho
  budget/scoring tests pass; no paid requests or live comparison occurred.
- Live subscription refresh, native chat, literal detection and Ogg/Opus
  transcription pass again after configuration and worker cleanup.
  [Latest report](compatibility/results/2026-09-07-cleanup-subscription.json).
- Native memory store, recall across process restarts and another-group isolation
  passed the [synthetic live rehearsal](compatibility/results/2026-09-07-assistant-memory.json).
  Recall reached 152 seconds in that run; it is not a latency guarantee.
- Required guard failure/retry/redirect tests pass. Native guarded chat passed
  again after cleanup with one required boundary attempt and no guard failures;
  the saved `auto` policy is restored. Earlier transient failures remain in the
  [historical guard report](compatibility/results/2026-09-07-guard.json).
- `.env` configuration checkpoint `4f3fade` preserves archive credentials and keeps
  Hermes OAuth in its native file. Format-2 backup/restore matched eight table
  fingerprints and 38 state files; five restored services were healthy and inactive.
  The rehearsal is stopped. [Report](compatibility/results/2026-09-07-environment.json).

## Cleanup and behavior fixes

The retired application is recoverable on the legacy branch. Its remaining local
`web/` build output and dependencies were removed. Active documentation describes
this runtime; historical research and accepted ADRs remain available.

Edit only the ignored root `.env` for local configuration. The requested fresh
reset removed the entire `data/` directory, including previous configuration,
archive files, backups, experiment state and the dedicated Hermes login.
Committed synthetic evidence and historical decisions remain in Git.

Archive capture, attachments, assistant work and approved actions progress in
independent non-overlapping loops. Slow inference cannot block capture/downloads.
Committed media avoids native duplicate downloads and unscoped sticker vision;
round video notes use the transcript path. Malformed source messages remain
archived with a visible suppressed dispatch and do not starve subsequent work.

## Remaining release gates

The first real owner-DM capture and reply passed after enabling the gateway.
Fresh subscription refresh, chat, detector and Ogg/Opus checks also passed.
[Content-free live evidence](compatibility/results/2026-09-07-telegram-dm.json).
Selected-group membership and send permissions now pass; membership events are
archived. [Access evidence](compatibility/results/2026-09-07-telegram-group-access.json).
After the earlier privacy-mode check, four ordinary owner-authored group messages
were delivered and answered. This proves those messages' capture/replies, not
visibility of every group member's messages. Credentials and IDs are already saved
locally. Follow [Telegram setup and acceptance](docs/telegram.md).
Intentional group silence, private/group isolation, voice persistence,
owner-approved delivery and reconnect/restart checks remain **unrun**.
Container health does not prove these.
Do not merge until they pass; commit the completed phase and proceed automatically.

## Local inspection and latency — 2026-09-07

The [pgweb browser](docs/database-viewer.md) is running on loopback port 8782.
UI queries and PostgreSQL read-only privileges were verified, including a denied
zero-row update after disabling transaction read-only mode.
[Viewer evidence](compatibility/results/2026-09-07-database-viewer.json).

Four observed group replies took 16.55–35.17 seconds after archive receipt.
Capture was about one second after Telegram's source timestamp. The slowest turn
spent about 1 second queued, 4 seconds preparing Hermes, 28 seconds in the agent
phase (two model rounds, two archive searches), and 2 seconds completing delivery.
Archive searches themselves took about 0.1 seconds. Per-turn process startup,
serial assistant dispatch, and non-streamed responses remain latency limitations.
The trusted ChatGPT route bypasses guard detection under `auto`.
This diagnosis does not claim a performance fix or a completed release gate.

The optional [Honcho experiment](experiments/honcho/README.md) needs a separate
bridge login and an explicitly supplied temporary key. Live compatibility,
derivation and recall comparison remain pending. Its $5 budget is unused.

### Owner dashboard D3 — native memory and isolated Honcho CLI

- [x] Owner-only profile enumeration, bounded native notes and paginated SQLite
  session inspection; selected profiles cannot open another profile's session.
- [x] Native preference forms use the shared revision-checked resolver.
- [x] Official Honcho CLI 0.1.4 and SDK 2.4.0 pinned in a separate internal-only
  runner; stored data commands, JSON output, pagination, lifecycle aliases and
  honest unavailable dashboard state. Read lookups cannot create records.
- [x] Compose regression: 16 TypeScript tests and 41 Hermes integration tests;
  two CLI boundary tests and one real upstream CLI/SDK fixture test pass.
- [ ] Optional live Honcho compatibility remains pending separate credentials.

### Owner dashboard D4 — evidence graph and operations

The owner's 3D graph revision replaces fixed SVG columns with a local Three.js
space, deterministic spatial layout, orbit/pan/zoom, node search, direct-connection
highlighting and source inspection. See ADR-0026 and the dashboard instructions.
This presentation change does not advance the pending production release gates.
Verification: nine graph/layout/failure tests, two owner HTTP tests and two pinned
dashboard compatibility tests pass. Live desktop and 375px browser checks cover
node picking, original sources, orbit/zoom, search, scope pagination and full screen.

- [x] Deterministic graph over one archive scope, with cursor pagination, original
  chat identities, author/reply/revision links, files, derived provenance and
  explicit native-note citations. No model calls or graph database.
- [x] Interactive keyboard-accessible graph, source detail, original file download,
  graph JSON and portable archive ZIP export.
- [x] Durable jobs for diagnosis, backup, restart and inactive restore; generated
  destinations, operation exclusion, and no preference writes during inspection.
- [x] Regression: 17 TypeScript and 43 pinned Hermes integration tests pass,
  including graph scope/provenance and operation failure/concurrency paths.
- [x] Local dashboard acceptance: graph node opens original source; diagnostics
  healthy; backup/restore verified all 8 tables and 89 state files with credentials
  inactive; portable ZIP exported 65 records with manifest/count/integrity checks.
- [x] Browser-native authenticated ZIP download verified; download-only HttpOnly
  cookie cannot access settings, and cross-origin downloads are denied.

### Owner dashboard clarity — 2026-09-07

- [x] Navigation grouped into Explore, Manage and Experiments, with purpose text
  and an overview explaining Nocheh's controls and native Hermes responsibilities.
- [x] Separate Nocheh settings and per-profile Hermes preferences; clear save/apply
  timing, masked credential review, and empty secret edits preserve the saved value.
- [x] Three-step import guidance, read-only memory explanations, readable Honcho
  status and maintenance results, with technical details collapsed by default.
- [x] Browser acceptance covers navigation, unchanged native preference save,
  masked credential review/discard, diagnostics and responsive layout. Build and
  owner-management HTTP regression pass; AST-only code graph refreshed.

### Nocheh runtime platform (ADR-0027)

Accepted [seven-phase plan](docs/runtime-platform-plan.md). Complete and verify each
phase, commit separately, then continue automatically. Existing release gates above
remain active. This direction supersedes the earlier Hermes-hosted presentation.

| Phase | Actual status |
| --- | --- |
| P1 — Ownership and runtime adapters | Complete: cbe3022; 30 JS/TS and 44 Python tests pass |
| P2 — Independent Nocheh dashboard | Complete: 1438674; independent root, native return page, desktop/mobile and 3D graph pass; 32 JS/TS and 44 Python tests pass |
| P3 — Configuration and native administration | Complete: 67d6a05; actual native state, shared config revisions, preference inheritance, scoped sessions/files and private profile management; 32 JS/TS and 52 Python tests pass |
| P4 — Native browser chat | Complete: 4effeac; isolated managed turns, original/file capture, native resume/cancel, scoped reconnect, durable receipts and Activity; 33 JS/TS and 64 Python tests plus live owner-private browser chat pass |
| P5 — Controlled broader tools and approvals | Complete: 75f7c39; exact approvals, bounded/revoked permissions, isolated shell and offline browser, public HTTPS MCP; 39 JS/TS + 78 Python full-suite and 16 targeted follow-up tests; live UI/CLI/worker acceptance passes |
| P6 — Native cron | Complete: 725983b; native editor and CLI, one supervised scheduler, durable fires/results, explicit catch-up, cancellation and local delivery; 40 JS/TS + 86 Python tests and live native scheduled subscription turn pass |
| P7 — Compatibility and release acceptance | Tooling verified and committed in the P7 increment: candidate runtime/native/UI builds, portable archive + memory export, inactive recovery with all 18 tables and 175 state files preserved across restart; 41 JS/TS + 91 Python tests and 2 host management checks pass. Real Telegram gates remain pending |


### P7 operations evidence — 2026-09-08

[Content-free report](compatibility/results/2026-09-08-runtime-platform-operations.json).
The native candidate builds and tests with no live state, credentials or test
network. UI/CLI export verified 135 sources and two native SQLite databases. The
current archive had no attachment or native note files; synthetic tests verify
those byte-preservation paths. Full backup and inactive restore preserve all 18
tables and 175 state files. Restored workers, tools, scheduler and copied OAuth
remain held; table fingerprints survive restart unchanged. The rehearsal is stopped.

The first cache-link backup and closed-SQLite export failures are retained in the
report; both were fixed and successfully repeated. No Telegram test messages were
sent. P7 **release acceptance remains incomplete** until the owner supplies the
[remaining Telegram test inputs](docs/release-acceptance.md). Cutover and `main`
merge remain pending; this tooling commit does not waive those gates.
