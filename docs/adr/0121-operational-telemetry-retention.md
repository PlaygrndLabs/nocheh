# ADR-0121: Expire broker model-call events and guard invalidation notes

<status>
Accepted implementation decision. Extends
[0111](0111-complete-workflow-history-retention.md) and
[0112](0112-spent-workflow-record-retention.md).
</status>

<context>
The storage re-examination found two control tables that grow with ordinary
use and that nothing prunes:

- `security_events` receives about four rows for every reasoning-provider call
  the security broker makes (`model.request`), which makes it the fastest
  growing control table. After a reply, those rows are read only by the reply
  stage breakdown, which looks at the reply's own attempt window, and by the
  owner's effect log.
- `guard_invalidations` receives one row for every guard or learned revision
  that replaces content. Every such change advances the guard epoch, so a row
  is never written twice, and no code reads the table.

The same table also records approvals and outcomes of actions and tools,
including ambiguous outcomes that require the owner's investigation.
</context>

<decision>
The daily retention worker removes, under the same
`NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS` horizon and in bounded batches,
`model.request` security events and guard invalidation notes created before
the cutoff. Security events of every other kind stay: they are the owner's
audit of actions and tools, and they grow with owner activity, not with model
traffic. `0` keeps every row. Both tables gain an index that serves the
cutoff scan.
</decision>

<consequences>
Control storage for broker telemetry is bounded by the retention window. The
owner's effect log and an old reply's stage breakdown no longer show provider
calls older than the window; the CPA provider monitor keeps its own request
history.
</consequences>
