# ADR-0185: A notes review stopped at its time limit without changing notes runs again

<status>
Accepted on 2026-10-28 after reruns on the owner's development install showed
Hermes native reviews killed at the 220-second child limit ending uncertain
although their notes were unchanged. Extends
[ADR-0183](0183-failed-native-review-without-effect-runs-again.md).
</status>

<context>
ADR-0183 lets a review run again when the review child itself reports a
failure without changing `MEMORY.md` or `USER.md`. A child the supervisor
stops at its time limit is killed outright, so it never writes that `failed`
receipt; its receipt stays `running` and the review stays uncertain, though it
changed nothing. Slow secret checks made several reruns hit the limit.
</context>

<decision>

- The supervisor takes a snapshot of the profile's notes before it runs the
  review child. When the child raises, times out or exits with an error, the
  supervisor takes the profile's memory lock, so no run of the review is left,
  and turns a `running` receipt into `failed` when the notes are unchanged.
- A missing receipt, a `done` receipt or changed notes are left as they are,
  so such a review is still never launched again.

</decision>

<consequences>

- A review stopped at its time limit before it changed any notes runs again,
  within the app's attempt limit from ADR-0183.
- A review stopped after it changed notes stays uncertain, as before.

</consequences>
