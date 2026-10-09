# ADR-0112: Expire spent workflow publication records and run links

<status>
Accepted implementation decision. Extends
[0047](0047-receipted-event-handoff.md) and
[0111](0111-complete-workflow-history-retention.md).
</status>

<context>
Every workflow request, continuation, retry and reopening adds a
`workflow_outbox` row, and every Inngest run that claims a workflow adds a
`workflow_runs` row. Neither table was ever pruned, so both grew with every
source, guard epoch and long-running refresh. The publisher and its
run-receipt check read only the current dispatch of an open workflow, and every
path that reopens a closed workflow moves it to a new dispatch with a new
publication record. Once Inngest retention removes a run, its link in
`workflow_runs` points at nothing.
</context>

<decision>
The daily retention worker also connects to the control store with its runtime
role and, under the same `NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS` horizon,
removes in bounded batches:

- publication records and run links of a dispatch older than the workflow's
  current one, once published (or created) and last seen before the cutoff;
- publication records and run links of a workflow closed before the cutoff.

A leased publication record is never removed. `0` keeps every row. The
workflow registry and effect receipts are never removed: the registry is the
permanent deduplication record, and receipts stop an owner retry from
repeating a started or completed effect.
</decision>

<consequences>
Control storage for these two tables is bounded by open work plus the
retention window. A closed workflow's detail view keeps its registry state and
receipts but no longer lists runs or publications after the horizon. The
registry itself still grows with each requested job, including the per-epoch
fan-out that [ADR-0109](0109-standard-honcho-entity-model.md) removes.
</consequences>
