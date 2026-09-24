# Owner dashboard and CLI execution

[SPECS.md](../SPECS.md) defines the product; [TASK.md](../TASK.md) records delivered
work and pending evidence. ADR-0027 supersedes ADR-0025's Hermes-hosted shell:
Nocheh owns the root application and Hermes has its native page. This file retains
the D1–D4 execution checkpoints, not the superseded pre-implementation design.

## Increments and acceptance

| Increment | Work | Acceptance procedure |
| --- | --- | --- |
| D1 — Configuration | Verify pinned native packaging/plugin/auth; connect the shared settings resolver and owner forms | Preserve native preferences across turns; check actual effective values, redacted show/save/apply, invalid/stale writes, apply recovery, and protection of scope/guard/provider rules. |
| D2 — Dashboard and imports | Package the owner dashboard and shared management API; connect resumable imports and jobs | Check owner/cross-site auth, malicious ZIP paths/symlinks, bounded uploads, scope mapping, supplied/missing media, repeated imports, cancel/restart/resume, exact originals, and zero historical replies. Compare CLI and UI operations. |
| D3 — Memory and Honcho inspection | Connect native profiles/notes/sessions and the pinned isolated Honcho CLI wrapper | Check wrong-profile denial, credential isolation, pagination, JSON output, meaningful exit codes, unavailable services, and reads that do not create data or invoke unmetered inference. Live Honcho compatibility is a separate gate. |
| D4 — Evidence graph and operations | Connect scoped source graph/inspection/export and durable diagnosis/backup/restore jobs | Verify links against originals, graph scope/provenance, keyboard and non-WebGL access, desktop/mobile interaction, authenticated downloads, job exclusion, inactive restore, and original/state integrity. |

## Related procedures

- [Dashboard and CLI guide](dashboard.md): available commands, settings ownership, native integration, and graph controls.
- [Import/export](import-export.md): source round-trips and media handling.
- [Runtime-platform sequence](runtime-platform-plan.md): independent Nocheh UI, native chat, broader tools, scheduling, and release acceptance.
- [Shared provider](shared-provider-plan.md) and [guarded memory](guarded-memory-plan.md): production connection gates, separate from data inspection.

Follow [AGENTS.md](../AGENTS.md) for commits and previews. D1–D4 are implemented;
older D3/D4 pending rows in the previous full ledger (`git show ab643dc:TASK.md`) are historical; [TASK.md](../TASK.md) has current status.
