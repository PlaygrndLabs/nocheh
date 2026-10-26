# ADR-0169: Reply runs are not refused for worker capacity

<status>
Accepted on 2026-10-26, when the owner said "yes for all" to the slow-reply
follow-up after the release test rerun. Extends
[ADR-0087](0087-live-background-admission-handoff.md).
</status>

<context>
In release test 3, a reply waited 184 seconds before its run started. Inngest
refused the run with `connect_all_workers_at_capacity`, then retried it with
backoff. Nothing in Nocheh held it. The same refusals hit preparation runs
after the test 4 hide and after the test 5 reactions. Each of those was a
burst of work right after a memory change.

All pipeline functions share one Connect worker, which accepted four step
requests at once. Domain work is already bounded on its own to two operations
and one waiting callback, and any other step request answers "waiting" within
milliseconds. So the four-request limit protected nothing, and it let a
short burst refuse a reply's run.
</context>

<decision>
- The pipeline worker accepts eight step requests at once. The two-operation
  cap, the reserved foreground admission and the single background slot of
  ADR-0087 are unchanged.
- The host worker keeps its own limit of two.
</decision>

<consequences>
- A reply's run starts while background work after a memory change is
  running. If domain capacity is busy, the reply waits in Nocheh's own
  two-second admission retry, not in Inngest's backoff.
- More step requests can each borrow a pooled database connection for their
  short pre-checks. Those wait for a connection rather than fail.
