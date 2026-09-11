# Space memory implementation

[SPECS.md](../SPECS.md) defines memory, audience access, and import consent.
[TASK.md](../TASK.md) records current status; ADR-0030 and ADR-0033 explain the
native/primary-memory decisions. This file retains the M1–M5 checkpoints and
recorded limitations. Follow [AGENTS.md](../AGENTS.md) for Git integration.

| Phase | Deliverable | Status |
|---|---|---|
| M1 | Versioned group/topic policies, inherited preferences, source index | Verified: TypeScript build and 6 policy/archive/PostgreSQL tests pass |
| M2 | Owner recall and durable native review, import approval | Verified: build, 8 TypeScript/PostgreSQL and 8 isolated native Python tests |
| M3 | Approved/filtered retrieval, policy revisions and delivery checks | Implemented and fixture-tested for archive text. Native-note/transcript filtering remains blocked pending owner approval of the provider payload and destination |
| M4 | Dashboard and CLI policies, memory, graph and review controls | Implemented; HTTP/CLI/native tests and browser recall/preview/sharing/mobile layout pass. Browser policy-save check blocked by automatic approval review |
| M5 | Isolated Compose acceptance, backup/restore, compatibility | Fixture suite passes: 34 TypeScript/HTTP/graph + 51 native Python tests; 15-table restore and pinned entrypoints verified. Live and approval gates remain pending |

Commits: M1 `1f7ce49`; M2 `5a16ad7`; M3 checkpoint `d755c24`; M4 `b7bd674`.

M3 enforces topic scope on original reads, files, graph and actions, retires group
profiles on policy changes, and rechecks the revision before native Telegram sends.
Exact shares never grant access to their private provenance. Optional filtering
currently accepts original archive text only; failures withhold wider knowledge.
Automatic approval review rejected extending its inputs to native notes and STT
transcripts. That extension is not implemented or enabled.

Acceptance: owner cross-source recall; inherited topic overrides; exact sharing and
revocation; no cross-audience originals/citations/notes; native review lifecycle;
import-without-review and explicitly approved review; restart/retry/quota handling;
STT preservation; UI/CLI round-trip; reproducible compatibility tests. Missing live
credentials remain pending. Acceptance here does not activate providers or declare
a release. Verified Git integration follows AGENTS.md independently.

Final fixture evidence: [2026-09-08-space-memory.json](../compatibility/results/2026-09-08-space-memory.json).
Release acceptance is incomplete. Live native review/filter quality, real Telegram
acceptance, the blocked filtering extension and the browser policy-save check remain
pending. The five checkpoints were integrated with the runtime-platform work and
subsequently consolidated into main under ADR-0039.
The Nocheh dashboard hosts memory controls; native browser chat and administration
are retained. Integration build and 37 TypeScript tests pass; native tests cover
72 cases, with the browser tool-count expectation updated for memory recall.

Backup format 3 fingerprints policy/source-index/share/review/cache tables and saves
`admin/jobs` alongside files and native state. Restores still accept formats 1 and 2,
verify their recorded table set, and leave copied login and Telegram inactive.
