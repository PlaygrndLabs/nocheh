<adr>

# ADR-0042: Host workflow coordination through the archive API

Status: implementation decision for the accepted local workflow migration,
2026-09-12. Activation evidence remains in [TASK.md](../../TASK.md).

<decision>

The host Connect worker uses Nocheh's existing loopback archive listener. Bounded,
authenticated archive RPCs claim work, renew leases and commit checkpoint receipts.
Host workers receive no database connection or published PostgreSQL port.

That listener forwards only the pinned SDK's Connect start/flush and trace POSTs
after validating the SDK signing-key hash. Its WebSocket route retains Inngest's
native signed handshake and rejects browser-origin requests. It does not expose
event ingestion or Inngest's UI. The owner inspection interface has a separate
authorization boundary.

Archive family locks fence each import write. A batch lease, immutable configuration
hash, explicit learning choice and committed checkpoints preserve job/source
identities across cancellation, lost replies and worker restarts. Source files and
scope mappings stay in the protected upload job; workflow history receives status
metadata only. Python performs bounded archive import batches under a per-job OS
lock. The existing job protocol reads authoritative progress from the archive.

The publisher waits for recent registration of the required workflow version.
This prevents a first-start event from arriving before its function exists.
Requests remain durable in the outbox while workers are unavailable.

A host supervisor owns the worker process under an OS lock. Backup drains that
process before snapshotting; shutdown and inactive restore do not depend on
Inngest responding. This extends [ADR-0041](0041-local-inngest-workflows.md) and
does not change its activation, provider or release gates.

</decision>

</adr>
