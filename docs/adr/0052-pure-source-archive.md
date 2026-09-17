<adr>

# ADR-0052: Pure source archive storage boundary

<status>
Accepted boundary from the owner's 2026-09-17 instruction: "the archive db should
be storage for pure data + guarded version." Implementation and open
classification questions are tracked in [TASK.md](../../TASK.md).
</status>

<decision>
The archive stores pure source data and its guarded versions, with the identities,
provenance, and guarded revision history required to preserve and interpret them.
Generated memory, runtime context, native runtime state, and workflow execution
state belong outside the archive database. Guarding runtime text does not make
that text original source data or place its guarded copy in the source archive.

This is a storage boundary, not a retention change. Preserve owned data, owner
edits, learning consent, audience enforcement, and durable execution evidence
when separating stores. Original-data capture must remain independent of memory
and orchestration availability; recoverable workflow handoff must prevent lost
work and duplicate effects.

The exact database/role layout, placement of transcripts and extracted text, and
cross-store handoff mechanism are unresolved. No migration or activation is
claimed by this decision.
</decision>

<supersession>
This amends the storage placement in ADR-0030, ADR-0033, ADR-0041, ADR-0042,
ADR-0044, and ADR-0051 where memory, control, or workflow records share the source
archive. It supersedes the same-archive-transaction outbox placement requirement
while retaining durable handoff, permanent deduplication, and recovery guarantees.
It does not remove the source model, guarded revisions, generated-record
preservation, portable native memory exports, or separate native Hermes/Honcho
ownership. Accepted historical ADR files remain unchanged; [SPECS.md](../../SPECS.md)
defines the intended target.
</supersession>

</adr>
