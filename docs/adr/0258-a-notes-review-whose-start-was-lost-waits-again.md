# ADR-0258: A notes review whose start was lost waits again

<status>
Accepted on 2026-11-16 after a full tester run left 26 Hermes native notes
reviews closed as uncertain for good, although none of them had ever begun.
Each had waited for a busy profile, and its next start request failed while
Hermes or the app restarted. Amends the "never relaunched" rule of
[ADR-0124](0124-native-review-once-per-source.md) for a review Hermes reports
as `not_found`; extends [ADR-0097](0097-durable-native-review-handoff.md) and
[ADR-0183](0183-failed-native-review-without-effect-runs-again.md).
</status>

<context>
The app claims a review (`running`, one more attempt) before it asks Hermes to
start it. Any error from that request made the review uncertain, for example
Hermes unreachable during a restart, a 400 while Hermes could not read the
served chats from a restarting app, or a 503 from profile preparation. Later
runs only observe it, and Hermes answers `not_found` when it has neither a
start marker nor a receipt for the review. The app counted that as one more
unconfirmed observation, so after eight of them the review closed as
`native_review_unconfirmed` and its source was never reviewed. An app stopped
during the request left the same state. On a development install with live
reload, any restart at the wrong moment can do this.

Hermes writes and fsyncs the review's start marker under
`nocheh-review-runs` before it launches the review, while it holds the global
worker lock, the profile's turn lock and the review's own lock, and the
launched review keeps those locks until it ends. Only a failed run's relaunch
removes the marker, under the same locks, and only for a run that failed
without changing notes. A busy profile, a failed preparation or a request that
never arrived leaves no marker. So `not_found` means that no run of this review
began that could have changed notes, and starting it again cannot write any
note twice.

One case was still open. A start request can outlive the app's interest in it:
the app gives up (it stopped, or the connection broke) while Hermes is still
preparing the profile. Once the app starts the review again, the epoch may
move and its input change, so the source gets a new review under a new id
while the old request goes on to launch the old one.
</context>

<decision>

- When an uncertain review (`running` or `ambiguous`) is observed as
  `not_found` and has used fewer than four attempts, the app sends it back to
  `pending` with `error_code` `native_review_not_started`, its observations
  reset and a 5-second wait, like a busy profile. Its attempts are kept, so
  each lost start counts as one of its four.
- A review waiting again is new work: its workflow renews it under the current
  epoch and checks consent, dependencies and the current binding before it
  starts it, as for any waiting review.
- Hermes launches a review only within 45 seconds of receiving its start
  request (`LAUNCH_DEADLINE`); a later one answers `profile_busy` and launches
  nothing. The app observes a start it saw fail no sooner than 60 seconds
  later (the first gap of an uncertain review), so a start it may have given
  up can no longer launch by the time it finds `not_found`.
- A review that used all four attempts is observed and closed as uncertain as
  before. Every other observation (`ambiguous`, `running`, `done`, `failed`)
  keeps its existing meaning; a review that may have changed notes is still
  never launched again.
- The owner's resume of a review always opens a new workflow generation, since
  a workflow opened while the review waited may already have taken the number
  of its new revision. `memory pause` and `memory resume` take the review's
  `--revision`, which the server has always required.
- The app logs each unconfirmed start or observation with its stage, attempts
  and error code or observed state, and each review sent back to waiting, with
  no content.
- The brain socket states the contract: a brain records a start durably before
  the job runs, so `not_found` means no run began that could have changed
  anything.

</decision>

<consequences>

- A restart during a start request costs that review one attempt, not the
  review.
- A retry under the same id that races a start still in flight is safe: the
  in-flight start either holds the locks, so the retry gets `profile_busy`, or
  has written its start marker, so the retry's own check under the locks finds
  it and returns that state.
- A slow start (more than 45 seconds to prepare the profile) is answered busy
  and asked again 5 seconds later; the slow part of preparation, carrying the
  conversation into a new profile, happens once per profile, so the next
  request is quick. Busy answers cost no attempt.
- A review whose start keeps failing while Hermes still answers observations
  uses its four attempts within a few minutes and then closes as uncertain, as
  before. During a longer outage the observations fail too and count toward
  the existing bound with growing gaps.
- Reviews already closed this way are not repaired automatically. The owner's
  resume (`memory resume ID --revision N`) resets the review's observations;
  its next observation then finds `not_found` and sends it back to waiting.
  Reviews that did start stay uncertain. A resume observes at once, so it is
  meant for reviews that closed long after their start.
- The start markers and the notes live in the same Hermes data folder. Only
  losing the markers while keeping the notes would make a review that ran
  look `not_found` and run again.

</consequences>
