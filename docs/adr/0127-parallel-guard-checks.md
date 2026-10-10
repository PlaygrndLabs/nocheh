# ADR-0127: Secret-guard checks run side by side

<status>
Accepted on 2026-10-10. Builds on
[ADR-0126](0126-owner-set-parallel-replies-and-runs.md), whose consequences
name guard detection as the next one-at-a-time step.
</status>

<context>
Every message is checked by the secret guard before it is answered. Two
serializers made that check one at a time across the whole installation:

- Hermes held one process-wide lock around `/internal/detect`, so every
  detector model call (message preparation, Hermes memory reviews, Honcho
  context refreshes and guarded tool results) waited for the previous one.
- Message preparation held one global advisory lock, so only one event was
  prepared at a time; other events retried every two seconds.

An idle owner turn spent about 12 seconds in preparation, and parallel replies
would mostly queue at the guard instead of the reply queue.
</context>

<decision>

- `NOCHEH_PARALLEL_GUARD_CHECKS` (default 3, range 1 to 4) is an ordinary
  Nocheh setting, edited in Settings › Speed or `.env`.
- Hermes replaces the detector lock with a bounded semaphore of that size.
  Detector calls share no mutable state: the trusted-detector marker is a
  context variable and credential resolution keeps its own lock.
- Preparation takes a per-event advisory lock, so one event is never prepared
  twice at once, and then one of that many slot locks, so that many different
  events prepare side by side. A contender that gets neither returns the same
  short `receipt_pending` wait as before.
- The upper bound of 4 keeps preparation within the eight-connection store
  pools: each running preparation holds one control and one derived connection
  while its detector call is in flight.
- Compose passes the value to `hermes` and `nocheh-app`; both stop on a
  malformed value.

</decision>

<consequences>
- Several messages arriving together are guarded at the same time, and
  background Hermes memory reviews no longer hold back the owner's next
  message at the detector.
- Each check is one model call, so more checks at once use more of the shared
  provider subscription at the same moment. The number of calls is unchanged.
</consequences>
