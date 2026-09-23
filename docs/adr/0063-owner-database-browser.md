# ADR-0063: Owner database browser

Accepted by the owner, 2026-09-23. Implementation and activation evidence are in
[TASK.md](../../TASK.md).

<decision>

The owner dashboard exposes a read-only table browser for installation data.
Discovery comes from configured database identities and registered native profile
paths. The browser accepts a database identity, a discovered table, and validated
column names; it never accepts SQL or a database path from the browser.

PostgreSQL reads execute in their existing Compose database containers with a
read-only session and statement timeout. SQLite opens with `mode=ro` and
`query_only`. Queries return bounded pages and truncated cell previews. Redis
queue and cache state has no relational table shape; Monitoring shows its service
health but not raw keys.

The archive's product-level view remains the place for evidence and guarded-copy
editing. The database browser does not create a raw-row mutation path, because
that would bypass revisions, authorization, invalidation, and provenance.

This extends [ADR-0025](0025-owner-dashboard-and-management-cli.md) on owner
inspection and [ADR-0053](0053-original-only-archive.md) on separate stores.

</decision>
