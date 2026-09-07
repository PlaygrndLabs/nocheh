# Space memory implementation

Accepted in ADR-0028. Hermes handles learning; Nocheh handles owned source delivery
and audience access. Import review needs explicit approval at import confirmation.

| Phase | Deliverable | Status |
|---|---|---|
| M1 | Versioned group/topic policies, inherited preferences, source index | Verified: TypeScript build and 6 policy/archive/PostgreSQL tests pass |
| M2 | Owner recall and durable native review, import approval | Pending |
| M3 | Approved/filtered retrieval, policy revisions and delivery checks | Pending |
| M4 | Dashboard and CLI policies, memory, graph and review controls | Pending |
| M5 | Isolated Compose acceptance, backup/restore, compatibility | Pending |

Acceptance: owner cross-source recall; inherited topic overrides; exact sharing and
revocation; no cross-audience originals/citations/notes; native review lifecycle;
import-without-review and explicitly approved review; restart/retry/quota handling;
STT preservation; UI/CLI round-trip; reproducible compatibility tests. Missing live
credentials remain pending. No production deployment or main merge is implied.
