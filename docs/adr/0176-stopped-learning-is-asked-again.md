# ADR-0176: Learning stopped by an epoch is asked again

<status>
Accepted on 2026-10-27 after the history import, when learning that a guard
epoch stopped was found to be closed and never asked again. Extends
[ADR-0173](0173-waiting-native-reviews-keep-their-place.md), which renews
waiting Hermes native reviews the same way.
</status>

<context>
A message's Honcho-based learning (an interpretation job) is prepared under the
guard binding of its time. Learning revises entries and advances the epoch every
few minutes during a busy run, so a job that had not finished found its binding
stale, and its workflow closed as superseded. Only Honcho's own source workflow
asks for learning, and only once, after it first writes a source, so nothing
asked for that message's learning again. A job that closed as too large to ask
had the same fate after the query trimming changed.
</context>

<decision>

- After each epoch, the archive sweep's per-source `memory_review` step also
  looks at the source's newest interpretation job for each memory audience of
  the current installation generation. When that job is bound to an earlier
  epoch and is pending, or failed for any reason other than an unusable saved
  result, its learning is requested again under the current binding.
- The request reuses a finished job with the same inputs, as before, so
  nothing finished is learned twice.
- The source's never-started jobs (pending, no attempts) bound to an earlier
  epoch are then deleted, since they can never run; their workflows close as
  superseded. Jobs that already asked Honcho are kept.
- Running and publishing jobs, current jobs, finished jobs, retired memory
  generations, withdrawn consent and unusable saved results are left alone.

</decision>

<consequences>
- A message's learning is no longer lost to an epoch change; it runs at most
  once more per epoch it is stopped by.
- A job stopped after Honcho answered asks Honcho again, since its saved answer
  belongs to an earlier binding.
- Stopped learning leaves one job per message and audience instead of one per
  epoch, and a renewed job can be the message's first learning, which is the
  one that may suggest organization changes.
- A query still too large after trimming is prepared again on later epochs
  without a model call.
</consequences>
