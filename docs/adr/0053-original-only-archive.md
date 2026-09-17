<adr>

# ADR-0053: Original-only archive and versioned derivatives

<status>
Accepted by the owner on 2026-09-18 as part of the implementation request for
"Original-only archive, versioned derivatives, and a clean restart". Implementation
and acceptance are tracked in [TASK.md](../../TASK.md).
</status>

<decision>
Use `nocheh_archive`, `nocheh_derived`, and `nocheh_control` as separate PostgreSQL
databases with separate credentials and explicit repositories. The authoritative
storage and product requirements are in [SPECS.md](../../SPECS.md).

The archive preserves original observations and file provenance. All guarded
representations, including authoritative owner edits, belong in derived storage.
Original audio/video/file bytes are the source; engine outputs remain versioned
derivatives. Native Hermes, Honcho, and Inngest stores remain separate.

Cross-store work uses stable references, durable idempotent handoffs, and explicit
reconciliation instead of cross-domain SQL joins or triggers. Revocation precedes
visibility of changed representations or authorization. Missing preparation fails
closed. Capture continues through control/orchestration outages using its durable
spool. Owner edits are durable records and cannot be discarded as rebuildable cache.

Honcho remains primary long-term memory. Nocheh adds inspectable, correctable
projections of contextual learning and explicit project/sharing management.
Conversation rules never grant administrative authority or action approval.
</decision>

<supersession>
This supersedes ADR-0052's placement of guarded source versions in the archive,
and earlier mixed-store placement in ADRs 0030, 0031, 0033, 0041, 0042, 0044,
and 0051. Their preservation, audience, guard, recovery, and approval requirements
remain applicable. Historical ADR files remain unchanged.
</supersession>

<execution>
The owner authorized a clean content reset after the implementation passes an
isolated rehearsal, preserving setup, external logins, and spending accounting.
The exact reset scope, order, and fresh live gates are in the
[execution plan](../original-only-archive-plan.md). No old-data migration is needed
for that installation; portable import compatibility and inactive restore remain
required. This ADR is not evidence of code completion or a performed reset.
</execution>

</adr>
