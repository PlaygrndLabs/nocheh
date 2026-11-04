# ADR-0208: Running jobs carry across quiet epochs

<status>
Accepted on 2026-11-04, after the owner's choice that reactions and automatic
learning keep updating while a job runs: they hide nothing, so the job keeps going.
Every other change still waits for the job or ends its run, as before. Extends
[ADR-0200](0200-waiting-approvals-survive-reaction-epochs.md) and
[ADR-0205](0205-owner-approved-jobs-work-in-a-sealed-box.md). Amends
[ADR-0207](0207-a-background-job-is-one-hermes-run.md). Keeps
[ADR-0201](0201-job-reports-survive-reaction-epochs.md).
</status>

<context>
- Since ADR-0207 a job is one Hermes run of up to about 55 minutes. Every check of a
  running run required its exact binding: the broker on each model request and each
  streamed chunk, the app server on each tool call, the delivery check at the turn's
  start and end, the heartbeat, the supervisor's look every 15 s and the receipt. Any
  new epoch therefore ended the run, and Hermes takes a 409 from the broker as final.
- So that a reaction or an automatic learning revision did not end a run, both waited
  while a job's run ran (`foregroundReplyActive`). In a busy group, reactions and
  learning then stood still for up to a job's length.
- Reaction epochs and automatic learning revisions are recorded as quiet: they hide
  and replace no message (ADR-0200). Waiting and approved actions (ADR-0200), a job's
  report (ADR-0201) and a job's box (ADR-0205) already carry across them with
  `carriesForward`.
- A relaunched run was bound to the current epoch. After any new epoch, quiet or not,
  its physical profile was new, so Hermes could not reload its history, and it got the
  first message again with the restart text.
- A learning batch commits its epoch together with publications that stay pending
  until it finishes, and every reader is refused meanwhile
  (`guard_transition_pending`). A run never met that moment while learning waited for
  it.
</context>

<decision>
- **One rule.** A running job run's own binding is accepted at the current one only
  by `carriesForward`: the same generation and mode, and every later epoch recorded in
  `guard_quiet_epochs`. Only reaction epochs and automatic learning revisions are
  recorded there. No other comparison is added.
- **Who carries.** Only a background job's run, as its own signed credential names it
  (a `job-` profile and the run's event), while its managed run waits or runs with a
  live lease and was not stopped, and only under the binding the run was given.
  Replies, browser and scheduled runs, memory reviews and filters keep the exact check.
  Telegram requests keep their exact-binding rule, and an owner command's check of its
  own binding stays exact.
- **Where it carries.**
  - The audience check (`AudienceRepository.assert`) returns the current binding for
    such a run. The broker's turn binding, its preparation and `assertCurrent` (each
    attempt and each streamed chunk) and the app server's check of every scoped call
    go through it.
  - The run's runtime turn, and the binding the launcher reads, keep the run's own
    binding, so its physical profile stays the one Hermes derives from the credential.
  - The heartbeat's context and fence, the supervisor's look, the delivery check, the
    run's profile and the receipt use `carriesForward` or `assertCarried`. A run that
    carried ends done, not interrupted.
  - The claim signs the run's credential for its own binding, after `assertCarried`.
  - The storage-less broker fallback stays exact: only storage admits a job's run.
- **What it reads.** Everything a carried run reads is checked under the current
  binding, never its own. Preparation keys the secret check's prepared values by the
  current epoch, guarded copies are read under the current binding, and native memory
  uses the current workspace. Only quiet epochs lie between the two, so nothing the run
  already holds was withdrawn.
- **Changes it asks for.** An action a carried run asks for is bound to the run's own
  binding and profile, with its arguments checked under the current one. It carries
  from there by ADR-0200, which never lasts longer than an action bound to the current
  binding. The run reads it back under its own binding, and a shell action runs in the
  run's own workspace.
- **Held changes.** `foregroundReplyActive` no longer counts a job's run for a reaction
  epoch or an automatic learning revision, so both publish while it runs. For approved
  knowledge changes, deferred owner commands that carry a binding and memory sharing
  grants, it counts a running job run whose binding carries to theirs, so they still
  wait for it. Replies, browser and scheduled runs hold all of them in their own epoch,
  as before. A learning batch still waits for a running approved action.
- **Any other epoch ends the run.** After a hide, a correction, a source or privacy
  revocation, a guarded-copy or memory edit, an access change, or a mode or generation
  change, the run's binding no longer carries. Its next model request or chunk is
  refused (`audience_context_changed`), its next heartbeat stops it
  (`guard_context_changed`, not tolerated), its next delivery check fails, and the
  supervisor cancels it, as before.
- **A pending publication.** For a job's run only, the broker's checks, the app
  server's check of each call and the delivery check wait for a pending publication,
  up to 4 s from the first refusal, and then run again in full. One still pending
  refuses, as before. The heartbeat keeps its 45 s tolerance (ADR-0207), and the
  supervisor waits for its next look instead of cancelling.
- **An epoch during a request.** A request takes the current binding once and reads
  under it exactly (`guards.read`), so an epoch that commits while it runs, quiet or
  not, fails it (`guard_context_changed`). For a job's run only, the secret check's
  preparation (each model request and each tool result), a change it asks for, and
  the archive reads (search, memory search hits, a message, current reactions and a
  chat page, so also the box's chat copy) wait out a pending publication and run again
  in full, at most 3 times (`afterEpoch`). Each run starts with the audience check,
  which takes the new binding while the run carries and refuses
  (`audience_context_changed`) once a change that is not quiet passed.
- **A relaunch keeps the binding.** A relaunched run gets the last run's binding while
  that carries to the current one, otherwise the current one. With the kept binding it
  has the same physical profile and session, Hermes reloads its history, and the run
  gets the resume line. After any other change it gets a new profile, the first message
  again and the restart text, as before.
- **Prepared values.** The secret check's prepared values stay per epoch. After a
  quiet epoch Hermes resends the run's history, and it is checked again in the new
  epoch; detector results already saved are reused.
- **Unchanged.** The report and limit note rule of ADR-0201: before each part, the
  last run's binding must carry to the current one. A part whose check an epoch or a
  pending publication interrupts stages nothing, and the job's next tick checks it
  again under the binding then current, by the same rule. The box: kept while only
  quiet epochs passed since the last change (ADR-0205), so it stays for the whole
  run. Python is unchanged.
</decision>

<alternatives>
- **Not counting a job's run in `foregroundReplyActive` without carrying.** Every
  reaction anywhere would end the run.
- **Rebinding a running run to each new epoch.** Its credential, profile and history
  would change mid-run, and nothing is rebound under ADR-0200.
- **A looser check for jobs**, such as any epoch while the job's own chat did not
  change. Rejected: the guard's epochs exist so that nothing a later epoch withdrew is
  read or sent, and only recorded quiet epochs may be carried.
- **Reading a carried run under its own binding.** Every read path checks the current
  binding; reading under an earlier one would need a looser read.
- **Waiting out a pending publication for every turn.** Kept to job runs: a reply is
  short and retried, and only a job's run now meets a learning batch while it runs.
</alternatives>

<consequences>
- Reactions and automatic learning no longer wait for a job, and a job no longer ends
  at one. Knowledge changes, deferred owner commands with a binding and memory grants
  still wait up to a job's length.
- A run goes on with a reaction state or learned wording that changed after it read
  them, as ADR-0200 and ADR-0201 accept: neither change hides a message, and what the
  run reads afterwards is checked in the new epoch.
- The re-check of a run's history after a quiet epoch costs secret-check time, to be
  measured on a real installation.
- The restart text now follows only a change that is not quiet, so its to-do line,
  which needs the list's run to carry, no longer shows. The limit note still uses the
  last list.
- Still open: another tool route that reads under one binding, such as native memory,
  shared memory or a knowledge proposal, fails its call when an epoch commits during
  it, and the model sees a tool error. A pending publication during the run's own
  context, claim or preparation fails its start, and the run is relaunched.
- Every epoch source added later ends a running job run unless it records itself as
  quiet.
</consequences>
