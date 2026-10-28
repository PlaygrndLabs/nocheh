# ADR-0183: A native review that failed without changing notes runs again

<status>
Accepted on 2026-10-28 after 57 redone Hermes native memory reviews on the
owner's development install all ended uncertain: each one's first run failed
on a refused secret check before it changed any notes, and Hermes then refused
to start it again. Extends the durable native review handoff in
[ADR-0097](0097-durable-native-review-handoff.md) and the bounded uncertain
observation in [ADR-0124](0124-native-review-once-per-source.md); Hermes'
internal workflow is unchanged.
</status>

<context>
ADR-0097 never launches an already-started native review again, because a
review that started may already have written native notes and a second run
could write them twice. A start marker with no `done` receipt is reported as
uncertain, and ADR-0124 closes it after a bounded number of observations.

That rule also caught reviews that are known to have done nothing. When the
review child raises or returns without `done`, the profile's notes
(`MEMORY.md` and `USER.md`) are still byte for byte what they were before it
started, so nothing would be written twice by running it again. A secret check
refused by the provider, a provider timeout or a stopped child each left the
review uncertain for good, and the source was never reviewed.
</context>

<decision>

- Before a review runs, the Hermes turn takes a snapshot of the profile's
  native notes, under the profile's memory lock. When the review raises or
  ends without `done` and the notes are unchanged, its receipt becomes
  `failed`; when the notes changed, the receipt stays `running` and the review
  stays uncertain as before.
- Observing a review reports `failed` for a `failed` receipt. Starting a
  `failed` review, under its lease, removes its start marker and launches it
  again. Any other started review is still never launched again.
- The app treats `failed` as a retryable end: the job goes back to pending
  with a growing gap (60 seconds doubled per attempt, up to 32 minutes) and
  runs at most four attempts in all, after which it is uncertain and closes as
  ADR-0124 describes.

</decision>

<consequences>

- A review that never touched the notes no longer blocks its source; a passing
  provider refusal or timeout costs one later attempt instead of the review.
- A review that changed notes and then failed is still never repeated, so no
  native note is written twice.
- Reviews already stuck with a `running` receipt from before this change stay
  uncertain until a one-off development data fix marks them `failed`; no
  migration is written.

</consequences>
