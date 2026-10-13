# ADR-0143: Finished Hermes delivery logs expire after one month

<status>
Accepted on 2026-10-12 by owner decision ("keep both logs default for 1
month"). Resolves the open journal question in TASK.md item 9; complements
[ADR-0111](0111-complete-workflow-history-retention.md) and
[ADR-0130](0130-spent-guard-fragment-retention.md).
</status>

<context>
Hermes writes a file journal for every Telegram send (`spool/outbound`), every
turn attempt and owner action (`spool/dispatch`), every Telegram run
(`spool/async-runs`) and every browser or scheduled run
(`nocheh-managed-runs` in the Hermes profile). Nothing deleted them. The boot
rescan of outbound and dispatch intents and the scheduler's two-second scan of
managed receipts read every file ever written, run requests and receipts kept
message and reply text outside archive retirement, and the reset effect
inventory fails above twenty thousand entries.

These journals are also the exactly-once boundary: a finished outbound result
answers a repeated identical send, and a finished run or dispatch result stops
a turn from running again. Their events already reach the archive through the
capture spool.
</context>

<decision>

- Hermes removes a journal only when its result is closed and older than
  `NOCHEH_HERMES_JOURNAL_RETENTION_DAYS` (30 by default, `0` keeps every
  journal, at most 3650). The setting is editable in dashboard Settings.
- Closed means an outbound result of delivered, rejected or ambiguous; any
  dispatch result; or a run result in a closed state. An intent without a
  result, a run without a result, and a managed receipt not yet published to
  Nocheh always stay.
- Hermes prunes once at startup, before the boot rescans, and then once a day.
- Within one journal the result file is removed last, so an interrupted pass
  never leaves an intent that boot recovery would turn into an uncertain send;
  the next pass removes the leftover result.

</decision>

<consequences>
- Boot and scheduler scans stay proportional to the last month of traffic, and
  run text kept by Hermes no longer outlives the retention window.
- A turn or send that is still retried more than a month after it finished
  would no longer find its old result. Nocheh closes dispatches and runs within
  minutes of a closed result, so this needs Nocheh to be down for the whole
  window.
- The archive keeps the outbound intent and result events; only Hermes' local
  copies expire.
</consequences>
