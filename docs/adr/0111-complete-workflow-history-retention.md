# ADR-0111: Inngest retention covers every run history table

<status>
Accepted implementation decision. Extends
[0110](0110-default-workflow-history-retention.md) and
[0107](0107-daily-workflow-history-retention.md); supersedes the boundary in
[0106](0106-configurable-workflow-history-retention.md) that kept Inngest
events and run records outside retention.
</status>

<context>
The specification forbids uncontrolled growth of operational storage in any
component. Retention removed only `spans`, `history` and `traces`. The pinned
Inngest (v1.44.0) also writes `events`, `function_runs`, `function_finishes`,
`event_batches`, `trace_runs` and `worker_connections` for every run or
connection and never removes them. In its source these rows are read only by
the inspection UI and its GraphQL API, never by execution, which keeps queue and
run state in Redis. `queue_snapshot_chunks` is already pruned by Inngest, and
`apps` and `functions` hold registrations, not history. Nocheh reads none of
these tables.
</context>

<decision>
The same daily retention worker and `NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS`
setting also remove, in bounded batches:

- `function_runs` of runs started before the cutoff with no history or finish
  record at or after it, and `function_finishes` recorded before it;
- `events` received before the cutoff that no remaining run record references;
- `event_batches` executed before the cutoff;
- `trace_runs` whose queued, started and ended times all precede the cutoff and
  that have no span ending at or after it (a running trace records a negative
  end time);
- `worker_connections` disconnected before the cutoff; connected rows stay.

`0` still keeps every row.
</decision>

<consequences>
Inngest's PostgreSQL database is bounded by the retention window instead of
growing with every run and event. Expired runs and their triggering events
disappear from the Inngest UI together. Nocheh receipts, the workflow registry,
Inngest app and function registrations, and Redis queue state are unchanged.
A synthetic fixture checks each rule, and the queries run against the pinned
schema. Behavior of a running Inngest after pruning these tables is checked at
the next local Compose acceptance.
</consequences>
