# ADR-0314: Memory-label notices wait until the failure lasts

<status>
Accepted on 2026-11-28, after a live test where the "Memory labels" notice was sent and marked
"Working again" two minutes later, twice in one afternoon. Amends when the problem check
(`tools/operations/provider/problems.py`) tells about note lines.
</status>

## Context

- Note lines (`NOTE_LINES`: `notes`, `memory_read`, `note_labels`, `forwards_read`, `source_tags`,
  `note_refs`) count failed and working steps per day. A new or worse count was told on the
  next check, every two minutes.
- A failed step falls back to a less exact source, and the next try usually works. The owner got
  a notice and its ✅ edit for a failure that had already passed.
- A failure that lasts must still be told.

## Decision

1. A note line that is new or worse, with a known working count, is held instead of told.
2. It is told when a check finds it still held ten minutes after it was first held
   (`HOLD_SECONDS`), or when it failed three more times than when it was last told
   (`HOLD_FAILURES`), even with working steps in between.
3. While held, a failure resets the wait for a working step. A working step after the last
   failure drops the hold without a message, and those failures are not news later.
4. A held line whose notice did not go through is told again on the next check.
5. System › Health lists every failure as before. Model, reader and other lines are unchanged.
6. A failed source-tag request logs its code (`source_tags_failed`), and a
   `derivative_identity_conflict` logs which fields differed, by name only, so the next one
   can be traced.

## Consequences

- A lasting memory-label failure reaches the owner up to ten minutes later than before.
- One that recovers on its own reaches only System › Health.
