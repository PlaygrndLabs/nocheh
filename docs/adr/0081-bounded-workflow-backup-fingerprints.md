<decision>

# Bounded workflow backup fingerprints

Status: accepted, 2026-10-02.

Extends [0023](0023-consistent-backups-and-inactive-restore.md) and
[0041](0041-local-inngest-workflows.md) on workflow snapshot verification.

<context>

The populated release backup exhausted PostgreSQL temporary disk while sorting
complete Inngest row JSON for table fingerprints. Large workflow payloads made
verification require substantially more temporary space than the stored dump.
Deleting workflow history would violate the common recovery-point requirement.

</context>

<choice>

New workflow snapshots identify `row-sha256-v2` in their metadata. PostgreSQL
serializes each row in UTC, hashes its UTF-8 JSON with SHA-256, and sorts only
the fixed-size hexadecimal digests with C collation. The existing streaming
SHA-256 accumulator hashes all sorted lines, retaining duplicate multiplicity.
Raw workflow values do not leave PostgreSQL during this comparison.

Restore selects the saved algorithm. Snapshots without a format retain the
original `row-json-v1` comparison; an unknown format fails before restoration.
Dump checksums, quiescence, database fingerprints, Redis verification, and
inactive restore gates remain independently required.

</choice>

<verification>

Synthetic PostgreSQL checks enforce a 4 MiB temporary-file limit against large
rows: the old full-row sort fails and the new comparison succeeds. Additional
checks cover row order, duplicate multiplicity, changed values, UTC stability,
old-format output, algorithm selection, and rejection of unknown formats. A
completed populated backup and inactive restore remain separate live gates.

</verification>

</decision>
