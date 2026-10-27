# ADR-0177: Stranded memory work is picked up at start

<status>
Accepted on 2026-10-27 after the fixes in
[ADR-0173](0173-waiting-native-reviews-keep-their-place.md) and
[ADR-0176](0176-stopped-learning-is-asked-again.md) went live and an idle
installation kept 296 waiting Hermes native reviews and the learning of 78
messages stranded until some later epoch change.
</status>

<context>
Both fixes renew stranded work in the per-source `memory_review` step, which
the archive sweep runs after every guard epoch. Work stranded before the fixes
were installed, or before any restart in the middle of a sweep, waits for the
next epoch, and an idle installation may not have one for hours.
</context>

<decision>

- Once per worker start, after idle superseded source steps are retired, the
  worker requests the per-source `memory_review` step again for each source
  with a never-started native review, or whose newest learning per memory
  audience is pending or failed (other than an unusable saved result), under
  an earlier epoch of the current installation generation.
- A source whose step is still open, or was already requested since the
  worker started, is skipped, so each source is asked for at most once per
  start. Requests go in batches of 100 until a batch is short.

</decision>

<consequences>
- A restart or deployment picks up stranded memory work without waiting for an
  epoch change.
- Stranded work that cannot be renewed, such as learning whose consent was
  withdrawn, costs one per-source step at each start and no model call.
</consequences>
