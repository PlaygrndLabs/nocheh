<adr>

# ADR-0054: Provision separated stores in the PostgreSQL service

<status>
Accepted by the owner in the request to remove `nocheh-store-bootstrap` and merge
it into the related service. Acceptance evidence is recorded in [TASK.md](../../TASK.md).
</status>

<decision>
For the original-only storage layout, `nocheh-postgres` provisions the archive,
derived, control, and workflow databases before its health check succeeds. It
uses the existing administrator credential and the same idempotent, advisory-lock
protected provisioning code. The application and security services keep only
restricted per-store credentials. There is no separate bootstrap service in
ordinary Compose startup.

The database entrypoint skips ordinary provisioning when the inactive restore
marker is present. This lets recovery start PostgreSQL without enabling restored
roles or activating capture. The explicit reset setup command remains separate;
inactive workflow restore invokes its workflow-only command inside PostgreSQL.
Failed provisioning leaves PostgreSQL unhealthy and prevents dependent runtime
services from starting.
</decision>

<supersession>
This changes the original-only layout's setup-only service placement described in
[the execution plan](../original-only-archive-plan.md). The legacy layout continues
to follow [ADR-0049](0049-application-database-bootstrap.md). Historical ADRs
remain unchanged.
</supersession>

</adr>
