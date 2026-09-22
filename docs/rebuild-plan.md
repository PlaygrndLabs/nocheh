# Nocheh rebuild execution and acceptance

[SPECS.md](../SPECS.md) is the product definition; [TASK.md](../TASK.md) records
actual completion and activation. Follow [AGENTS.md](../AGENTS.md) for verified
increments and Git integration. ADR-0018 began this sequence; ADR-0019 selects
local Compose, ADR-0033 replaces the original guard/memory design, and ADR-0039
separates integration into main from release. ADR-0061 retires the optional
Honcho comparison. Historical ADRs retain the rationale.

## Phase checkpoints

| Phase | Work and acceptance procedure |
| --- | --- |
| 0 — Baseline | Verify the legacy branch and record the architecture decision. |
| 1 — Subscription compatibility | Pin the tested upstreams; prove native chat, literal detection, Ogg/Opus transcription, refresh, quota, and failure handling against the actual account locally. |
| 2 — Compose | Build TypeScript services and thin Hermes integration; verify fresh startup, PostgreSQL, files, internal authentication/configuration, and health. Repeat subscription compatibility inside Compose. |
| 3 — Capture | Exercise crash/outage/restart, duplicate and concurrent updates, edits, partial downloads, provenance, and outbound receipt recovery. Verify originals and file bytes across each case. |
| 4 — Retrieval and portability | Test Desktop import with supplied/missing media, scoped search/read/download, export/reimport, and silent replay. Verify identities and original bytes round-trip. |
| 5 — Guarding | The original checkpoint is superseded by the [guarded-projection sequence](guarded-memory-plan.md). Verify on/off selection, exact local masking, authoritative owner edits, and per-attempt failure closure. |
| 6 — Assistant | Verify native memory, group/topic audience policy, owner recall, transcript persistence/retry, useful conversation and intentional silence, and owner-controlled actions. Run actual Telegram checks. |
| 8 — Operations and release | Rehearse fresh install, backup/inactive restore, quota/backlog/guard recovery, then complete [remaining live release acceptance](release-acceptance.md). Record cutover separately from Git integration. |

## Verification procedure

- Subscription transcription is a feasibility/release gate: retain failures and stop dependent release work; continue independent implementation. Missing credentials and unrun checks stay pending.
- Include Unicode, repeated/overlapping secrets, malformed detector output, auxiliary calls, complete history, provider switches, retries, tool results, transcripts, and image-derived text in boundary checks.
- Check audience isolation through native memory, sessions, filesystem/tools, source citations, and delivery. Test approval changes and uncertain delivery reconciliation without blind resend.
- Use local Compose; VPS verification remains deferred. [TASK.md](../TASK.md) links the recorded evidence and preserves original phase commit hashes.
