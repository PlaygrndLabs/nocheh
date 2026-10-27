# ADR-0173: Waiting native reviews keep their place across epochs

<status>
Accepted on 2026-10-26 after learning a 105-message Telegram history import
left Hermes native memory reviews growing faster than they cleared. Extends
[ADR-0124](0124-native-review-once-per-source.md); Hermes' internal workflow
and the guard epoch rules are unchanged.
</status>

<context>
Learning revises existing learned entries, and each revision advances the
authorization epoch, so a busy learning run advances it every few minutes. A
Hermes native memory review that had not started is bound to the epoch it was
prepared under. After each epoch its workflow closed as superseded and the
next archive sweep queued a new review with a new identity at the back of the
queue, while the old row stayed `pending` for good. Reviews run one at a time
behind the profile lock, so the queue of about 140 reviews grew to over 400
rows and barely moved. Every waiting review also re-validated its input and asked Hermes again
every five seconds while another review held the profile, taking the shared
background slot from Honcho writes and learning.
</context>

<decision>

- When a source's review never started and was prepared under an earlier
  binding, queueing the source prepares its input again under the current
  binding. Unchanged input keeps the review's identity, workflow and place, and
  is rebound to the current binding. Changed input becomes a new review, and
  the earlier never-started rows of that source are deleted.
- A never-started review's own workflow renews it this way when it finds its
  binding stale, instead of closing and waiting for the sweep. A workflow
  whose review row was deleted closes as superseded.
- A source whose learning consent is gone loses its never-started reviews.
- A waiting review does not validate or ask Hermes while another native review
  is running and was updated in the last ten minutes; it looks again in 15
  seconds.

</decision>

<consequences>
- Epochs no longer multiply waiting reviews or send them to the back of the
  queue; the queue drains at Hermes' own pace, one review at a time.
- Started, finished, uncertain and paused reviews are untouched, so a source is
  still reviewed by Hermes at most once per installation generation.
- Learned-entry revisions still advance the epoch; the archive sweep after each
  epoch still costs workflow steps, but no model call and no new review.
</consequences>
