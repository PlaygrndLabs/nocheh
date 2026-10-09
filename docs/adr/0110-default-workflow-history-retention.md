# ADR-0110: Inngest telemetry retention on by default with 14 days

<status>
Accepted by owner decision on 2026-10-09. Supersedes the off default in
ADR-0106; the daily schedule of ADR-0107 and the protected tables are unchanged.
</status>

<context>
ADR-0106 made retention of Inngest run telemetry configurable and off by
default, so spans, history and traces grew without bound unless the owner set a
value. The specification now forbids uncontrolled growth of operational storage
in any component, and the owner chose a 14-day default.
</context>

<decision>
`NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS` defaults to `14` in the installation
defaults, `.env.example`, Compose and the retention worker. `0` still turns
retention off, and the owner can set 1 to 3650 days. An installation whose
`.env` already records a value keeps it.
</decision>

<consequences>
Fresh installations remove telemetry of runs inactive for more than 14 days,
leaving two weeks of history for diagnosing slow replies. Nocheh receipts, the
workflow registry and Inngest queue state are still never removed. Inngest's
other tables (`events`, `function_runs`, `function_finishes`, `trace_runs`) and
Redis remain outside this retention and are tracked separately.
</consequences>
