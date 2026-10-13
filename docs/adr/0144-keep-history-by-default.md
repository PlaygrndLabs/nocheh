# ADR-0144: Workflow history and Hermes delivery logs are kept by default

<status>
Accepted on 2026-10-13 by owner decision ("keep data for ever"), answering
whether workflow history should also keep one month like the delivery logs.
Supersedes the 14-day default of
[ADR-0110](0110-default-workflow-history-retention.md) and the 30-day default
of [ADR-0143](0143-hermes-delivery-log-retention.md). The retention mechanisms
of ADR-0107, ADR-0111, ADR-0112, ADR-0113, ADR-0121, ADR-0130 and ADR-0143 are
unchanged.
</status>

<context>
Workflow history retention removed Inngest run history and telemetry, spent
workflow records, model-call security events, guard invalidation notes,
superseded Honcho context summaries and spent guard fragments after 14 days.
Hermes delivery log retention was about to remove finished journals after 30
days. The owner chose to keep this data.
</context>

<decision>

- `NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS` and
  `NOCHEH_HERMES_JOURNAL_RETENTION_DAYS` default to `0` in the installation
  defaults, Compose, the retention worker and Hermes. `0` keeps everything.
- Both remain owner settings in dashboard Settings › Advanced, from 1 to 3650
  days; an installation whose `.env` records a number keeps it.
- Nothing else changes: the daily passes still run and do nothing at `0`.

</decision>

<consequences>
- Workflow history, operational records and Hermes journals grow with use
  until the owner sets a number of days. The storage view reports them as
  kept forever.
- Hermes' boot rescan of outbound and dispatch intents and the scheduler's
  scan of managed receipts read every journal ever written, so they slow down
  as journals accumulate; setting a number of days bounds them again.
</consequences>
