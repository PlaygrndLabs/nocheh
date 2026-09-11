# ADR-0031: Native schedules with captured, supervised fires

Status: accepted; P6 verified locally. Date: 2026-09-08.

Hermes owns each profile's native `cron/jobs.json`, schedule parser, editor and
session history. Nocheh's runtime supervisor starts exactly one scheduler under a
process/file lock. The standalone native ticker, webhook fire and arbitrary
script/provider execution stay disabled. Owner inspection never creates or repairs
a native job store.

Owner-created definitions are archived before becoming runnable. Each scheduled
slot or explicit manual request has a durable fire identity. Its original prompt
and definition are captured before a managed claim and fresh isolated agent turn.
Results remain separate derived records with native session provenance. Profile
locks prevent overlapping browser, Telegram and scheduled turns. Global/profile/
job preference inheritance is shared; job limits are applied only to that child.
Tools still require approvals and cannot bypass a profile's disabled executor.

Results default to local storage. Choosing Telegram creates an exact approval
proposal for each completed result to that job's selected scope. It never sends
automatically. Empty, cancelled, interrupted, overlong and stale-audience results
cannot become implicit delivery. Owner-private and selected group schedules are
supported; topic schedules and interactive/script/skill jobs remain unavailable.

More than 60 seconds late is a missed occurrence, recorded with its skipped range.
There is no automatic catch-up. The owner can request one catch-up explicitly.
Overlapping slots are recorded as skipped. Each observed scheduled slot or missed
range consumes one repeat; explicit manual/catch-up runs do not consume repeats.
Intervals keep their original cadence after downtime. Pause stops future starts;
Cancel requests interruption of active work without undoing completed effects.

A crash never causes external execution to repeat. Fsynced results can be reconciled;
uncertain/incomplete fires remain interrupted. Schedule advancement follows source
capture, so a replay can only recover an existing fire. Restore copies native jobs
and archive records but leaves the scheduler inactive and credentials held aside.

The full native editor remains available for the supported schedule fields. Small
pinned-source patches add conflict revisions, request identities, run limits and
explicit cancel/catch-up controls. CLI and dashboard call the same owner adapter.

[Content-free acceptance evidence](../../compatibility/results/2026-09-08-native-schedules.json).
