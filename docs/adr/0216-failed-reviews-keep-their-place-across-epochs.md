# ADR-0216: A failed notes review keeps its place across epochs

<status>
Accepted on 2026-11-08 after a Hermes native notes review on the owner's
development install failed once without changing notes, was due to run again
two minutes later, and still had not run an hour and a half later while other
reviews kept running. Extends
[ADR-0173](0173-waiting-native-reviews-keep-their-place.md),
[ADR-0177](0177-stranded-memory-work-is-picked-up-at-start.md) and
[ADR-0183](0183-failed-native-review-without-effect-runs-again.md); Hermes'
internal workflow is unchanged.
</status>

<context>
ADR-0183 sends a review that failed without changing notes back to `pending`
with a growing gap. ADR-0173 renews a waiting review under a newer
authorization epoch, but only one that never started (`attempts=0`). Epochs
advance every few minutes during learning, so a failed review's gap usually
spans one. When the retry came due, its workflow found the binding stale,
failed the exact epoch check and closed as superseded. Nothing asked for it
again: the per-source sweep counted it as already reviewed, the start-up sweep
of ADR-0177 looked only at never-started reviews, and a closed workflow
generation is never reopened. The review stayed `pending` for good.

The same close happened to a never-started review when an epoch landed between
the workflow's renewal and its start; the sweep then rebound the row but asked
for no workflow, so it waited for good as well.
</context>

<decision>

- A pending review is renewed under the current binding whether it never
  started or failed without changing notes. Unchanged input keeps its identity,
  attempts, last failure, gap and place; changed input becomes a new review, as
  in ADR-0173.
- The start-up sweep of ADR-0177 also picks up failed reviews left under an
  earlier epoch.
- When a source's step keeps a waiting review whose workflow already closed, it
  asks for a new workflow generation for it; a review with an open workflow gets
  no second one.
- When an epoch lands while a waiting review is renewed, checked or started, its
  workflow waits two seconds and renews it, instead of closing as superseded.

</decision>

<consequences>

- A failed review runs again within ADR-0183's four attempts, however many
  epochs pass while it waits.
- A review already left waiting without a workflow under an earlier epoch is
  picked up at the next worker start or the next epoch's sweep; no data fix is
  needed.
- A long source is reviewed in fragments. Once one fragment has started, the
  source's other fragments still waiting under an earlier epoch are deleted by
  its next step, as before under ADR-0124's once-per-source rule; that now
  includes fragments that failed once.

</consequences>
