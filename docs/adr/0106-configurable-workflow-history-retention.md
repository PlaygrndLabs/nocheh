# ADR-0106: Configurable Inngest telemetry retention, off by default

<status>
Accepted implementation decision. Extends
[0105](0105-shared-background-engine-queue.md) and
[0046](0046-consolidated-inngest-installation.md).
</status>

<context>
The pinned self-hosted Inngest has no retention setting and never removes its
PostgreSQL `spans`, `history` or `traces` rows. Test use filled 35 GB before
those rows were deleted on owner direction. Nocheh reads none of them for
receipts or recovery; they serve the Inngest inspection UI and backups. The
owner asked for retention to be configurable and off by default.
</context>

<decision>
`NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS` is an editable installation setting,
validated as `0` (off, the default) or 1-3650 days. The `nocheh-db` entrypoint
starts a retention worker after store initialization, except for an inactive
restore. With `0` it exits immediately. Otherwise it connects locally as the
`nocheh_inngest` role and, hourly, removes in bounded batches the spans and
history of runs whose newest activity precedes the cutoff, and trace rows older
than the cutoff; `traces` has no run index. Each batch is its own transaction
with a 60-second statement limit. On stop, the entrypoint ends the worker
before PostgreSQL, so a shutdown is never held by a retention session.

Inngest events and run records, Redis queue and run state, and every Nocheh
store are outside retention.
</decision>

<consequences>
With retention off, behavior is unchanged and telemetry grows until the owner
sets a horizon. With it on, expired runs disappear from the Inngest UI and from
later backups, and an active run can lose trace rows, but not spans or history,
older than the cutoff. Disk pages freed by deletion are reused by PostgreSQL
rather than returned to the host. The small `events`, `function_runs`,
`function_finishes` and `trace_runs` tables still grow. A synthetic fixture on
the pinned Inngest showed that pruned and fully truncated telemetry tables
leave later runs working normally.
</consequences>
