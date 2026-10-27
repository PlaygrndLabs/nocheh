# ADR-0178: A settings apply is followed to its end, across reloads

<status>
Accepted on 2026-10-27 after the owner's report. Refines
[ADR-0146](0146-save-in-page-header.md) and [ADR-0147](0147-save-always-present.md).
</status>

<context>
The owner changed parts in Settings › Models to "Same as main" and pressed Save.
The header showed only "Applying…" with a spinner. The owner wrote "its freezing
on saving and need reload page". The apply on the MacBook took 2 minutes 8
seconds, because Docker Compose waits for every restarted service to report
healthy. After the reload the page showed "Saved, not in use yet" and offered
Apply now, although the apply was still running and finished on its own.
Pressing Apply now then would have failed with "Another task is running".
</context>

<decision>

- Apply reports each step as it starts: restarting the services, going back to
  the previous settings after a failed restart, refreshing memory and updating
  Telegram. The running job keeps the step it is on.
- The settings answer names the apply that is running now, with its step and
  start time. A page that opens or reloads during an apply follows it, as does
  a Save that finds an apply already running.
- While applying, the header shows the step and the time since the apply
  started, for example "Restarting services… 1:05", and the time counts up.
- Every apply ends with a result on the page. Success says "Saved and applied."
  An apply lost by a dashboard restart, a dashboard that stops answering for 2
  minutes, or an apply still running after 25 minutes each end with their own
  plain error and a Try again button. Every server step is bounded, including
  Honcho's restart, which now times out after 5 minutes.

</decision>

<consequences>
A slow restart reads as progress, not a freeze, and a reload never loses an
apply. The full tester checks that a reload during a real apply sees it and
that the apply ends with a result.
</consequences>
