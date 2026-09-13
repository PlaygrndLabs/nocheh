<adr>

# ADR-0043: Owner workflow controls and inspection-only execution history

Status: implementation decision for the accepted local Inngest migration,
2026-09-14. Activation evidence remains in [TASK.md](../../TASK.md).

<decision>

Nocheh exposes metadata-only workflow observations, durable control receipts and
revision-validated owner retry/cancel operations. Family fencing and authoritative
domain receipts reject stale controls and prevent reopening closed or uncertain
effects. Existing native schedule and source-policy controls remain authoritative.

The owner server exposes Inngest's pinned native history UI under `/inngest`.
Its existing session, origin and CSRF checks protect the browser boundary. The
archive's authenticated listener forwards a fixed set of inspection paths and
parsed GraphQL queries to the internal server with server-held credentials.
Mutations, subscriptions, event ingress, debugger endpoints and unknown query
roots are denied. This extends the separate inspection boundary described by
[ADR-0042](0042-host-workflow-archive-coordination.md).

Version-specific adapters supply the local route base and CSRF header, remove
execution buttons and replace the external Monaco viewer with local read-only
text. Backend validation enforces inspection independently of those UI changes.
Signature checks fail closed when pinned assets differ. A restrictive content
policy blocks external scripts, fonts and connections. Future server upgrades
must repeat these adapter, authorization and browser acceptance checks.

Nocheh's Monitoring page combines workflow stages, retry/wait state, receipts,
outbox backlog and worker freshness with existing Telegram/provider observations.
It refreshes every ten seconds. Source inspection and maintenance remain in
Nocheh; native Inngest history is not an execution authority.

</decision>

</adr>
