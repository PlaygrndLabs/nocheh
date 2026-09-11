# Nocheh runtime platform execution

Product requirements live in [SPECS.md](../SPECS.md); implementation and remaining
live gates live in [TASK.md](../TASK.md). This is the seven-phase execution sequence
from ADR-0027, interpreted with later memory, guarding, provider, and security ADRs.
Use [AGENTS.md](../AGENTS.md) for commit/integration workflow.

## Phases and acceptance

| Phase | Work | Acceptance procedure |
| --- | --- | --- |
| P1 | Capability-checked runtime adapter and captured source identities | Exercise existing dispatch/management errors and archive round-trips; satisfy the runtime contract with a replacement fixture. |
| P2 | Independent Nocheh root and dedicated native Hermes page | Check navigation, refresh, downloads, HTTP/WebSocket auth, mobile layout, graph, route aliases, and startup with Hermes unavailable. |
| P3 | Shared native configuration and owner administration | Verify actual runtime state, CLI/UI round-trip, effective-value provenance, stale-write conflicts, credential protection, scoped profiles, and inspection without side effects. |
| P4 | Managed native browser chat | Test capture before interpretation, files, resume/cancel, profile binding, guard/quota/refresh failure, and reconnect without duplicate submission. Run live owner-private chat acceptance. |
| P5 | Controlled broader tools and approvals | Test exact approval/denial, standing grants, revocation, changed arguments, scoped workspace/network escape attempts, and uncertain outcomes through UI, CLI, and executor. |
| P6 | Managed native schedules | Test definitions/fires, restart, overlap, cancellation, delivery approval, missed runs, explicit catch-up, and receipt recovery; verify a live subscription scheduled turn. |
| P7 | Compatibility and release | Build pinned candidate/runtime/native assets; rehearse isolated state, portable archive/native memory, backup/rollback, and UI/CLI failure cases. Complete real Telegram voice, isolation, approval, silence, and reconnect gates. |

## Related execution

- [Space memory](space-memory-plan.md), [guarded memory](guarded-memory-plan.md), [shared provider](shared-provider-plan.md), and [security](security-service-plan.md) have separate acceptance/activation checkpoints.
- [Dashboard operations](dashboard.md) describes actual UI and CLI commands. [Release acceptance](release-acceptance.md) supplies the remaining real input procedure.
- New native capabilities become available only after their integration checks pass. An offline compatibility pass or merge into main does not satisfy live release or activation gates.
