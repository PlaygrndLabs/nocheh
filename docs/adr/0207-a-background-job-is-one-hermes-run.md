# ADR-0207: A background job is one Hermes run

<status>
Accepted on 2026-11-04, after the owner's choices: a job runs at most 50 minutes in
one go, and bigger work becomes several jobs the agent splits itself; at 80% of its
cost or time limit the agent is warned so it writes its report, and at the limit
Nocheh stops it and sends a short note of what is done and what is left, with no
model call; a running job's card has a Stop button. Supersedes the chain of steps of
[ADR-0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md). Amends
[ADR-0201](0201-job-reports-survive-reaction-epochs.md) and
[ADR-0205](0205-owner-approved-jobs-work-in-a-sealed-box.md). Keeps
[ADR-0200](0200-waiting-approvals-survive-reaction-epochs.md),
[ADR-0203](0203-owner-approved-jobs-read-notion.md),
[ADR-0204](0204-a-jobs-changes-come-on-list-cards.md) and
[ADR-0206](0206-nocheh-prices-a-jobs-model-use-itself.md).
</status>

<context>
- The owner's direction: the agent decides by itself when work needs a job; Hermes
  runs the work (planning, the to-do list, compaction, notices, deciding when it is
  done, the report); Nocheh keeps policy (the card, limits, access, the secret check,
  the box, Stop and delivery). No Hermes file is edited: only the agent's constructor
  arguments, profile configuration and hooks in Nocheh's own plugin.
- ADR-0197 ran a job as a chain of sealed steps of 20 iterations and 540 s each, with
  a continue message between steps and a short wrap-up step at a limit. Nocheh
  guessed from each step's answer whether the work was done.
- Each step was told to finish after about 144 s. The turn passed no run budget, so
  Hermes read the profile's 180 s, and its time notice ("Produce the required final
  deliverable") came at 80% of that. An answer that was not cut off by a limit ended
  the whole job.
- A turn's credential is refused when it expires more than one hour ahead, by the
  broker and by the turn's own check, and a running turn cannot take a new one. One
  run therefore has to finish within one credential.
- A spike on 2026-10-29 ran Hermes's Kanban board with workers in sealed containers.
  Its stock worker hands its claim to the profile's gateway, which would run the
  agent in Hermes's own container; ADR-0029 forbids that.
- ADR-0197 recorded no alternatives.
</context>

<decision>
- **One call, one run.** The agent starts a job with one `start` call, as since
  ADR-0197's note of 2026-11-04. Once approved, the job is one sealed Hermes turn of
  up to its time limit, with Hermes's iteration cap of 300 as a backstop only. Its
  final answer is the report; Hermes's own summary at the iteration cap counts as one.
  There is no continue message, wrap-up step or "this step's time is up". The first
  message says to take as many steps as needed, and that a notice comes when time or
  cost is nearly used up. A job's own turn has no job tool.
- **Time.** The time limit L is the setting (5 to 50 minutes, 45 by default), or 1.5
  times the estimate when that is longer. `start` refuses a job whose L would pass 50
  minutes with `job_too_long`, and the agent narrows the period or splits the work into
  several jobs. Every run of a job shares its deadlines, counted from its start:
  - soft = start + L: Hermes gets `run_budget_seconds` = the time left to it, at least
    30 s, and gives its own notice at 80% of that;
  - hard = soft + 3 min: the heartbeat ends the run with ended `time`, and box commands
    end there;
  - the turn's process is killed 60 s after hard if the cancel did not reach it;
  - the credential expires 2 min after hard, at most 55 minutes after the start, so it
    stays within the one-hour bound;
  - the box expires 5 min after hard.
- **Cost.** Per-call hooks in Nocheh's plugin count the run's tokens: Hermes's API
  calls and its auxiliary calls such as compression and titles. A call without usage,
  a streamed auxiliary call and the summary at the iteration cap each count as one
  unknown call; a failed auxiliary attempt is not counted. The turn writes the
  running totals and, when it changed and at most once a minute, the to-do list as
  progress lines; the heartbeat carries the newest to storage every 5 s, and the
  receipt carries the final ones. Storage prices them at the job's frozen rates
  (ADR-0206), an unknown call at the price of 100,000 input and 8,000 output tokens
  plus the request price, and keeps the larger value, so a run's cost never goes
  down. The job's cost is the sum of its runs', and the dashboard shows it and the
  to-do list while the job runs.
- **Notices at 80%.** Time: Hermes's own notice. Cost: the turn knows the rates, the
  limit and what earlier runs of the job cost; once those and this run's cost reach
  80% of the limit, the next tool result gets one notice to stop new discovery and
  write the report. A job without a price gets no cost notice.
- **Stops at 100%.** On a heartbeat whose job cost has reached its limit, or after the
  hard deadline, storage records the run's ended reason (`cost` or `time`) and cancels
  the run in one transaction. That closes its runtime turn, so the broker refuses its
  next model call, and the heartbeat's answer makes the turn stop. ADR-0206's byte
  backstop also ends a job at `cost`. A run that crashed after the hard deadline ends
  at `time`.
- **The limit note.** A job stopped at a limit gets no report from a model. Nocheh
  sends a short note built from the job's last to-do list instead: completed items as
  done, pending and in-progress ones as left, or that no list was kept. Only a list
  whose run's binding still carries to the last run's is used. The note goes through
  the same path as a report, so ADR-0201's check, the member re-check, Stop and
  per-part staging apply. The job ends `done`, with its ended reason; its card and the
  dashboard say it stopped at its limit and that the note is in the chat. The text is
  the owner's to edit.
- **Ended reasons.** A run ends at `cost`, `time` or `stopped`, set once, only while
  it is live, in the same transaction as its cancel. A job keeps `cost` or `time` when
  it ended with a limit note.
- **Relaunch.** A run that failed or was interrupted before the hard deadline is
  relaunched at most twice (three runs in all), only with at least 3 minutes to the
  soft deadline, while the job's cost is under its limit, and only after the member's
  access is checked again; a member who lost access fails the job with
  `job_not_permitted` and frees its slot. In the epoch where an earlier run of the job
  ran, the run reloads its history and gets a resume line. In a new epoch its profile
  is new and its earlier work cannot be kept: it gets the first message again and a
  restart line, with its last to-do list only while that list may still be shown. A
  relaunched run gets no autonomy: every change it asks for waits for a card,
  including Notion calls that would otherwise run without one, and standing
  permissions do not apply.
- **The report's member check.** Before the first part of a report or note is staged,
  the member's access is checked as at approval.
- **Heartbeat tolerance.** On the background channel only, the heartbeat keeps the
  run through no answer, a server error and a guard publication in progress
  (`guard_transition_pending`), until 45 s after its last success. Anything else, such
  as a lost lease, a changed guard context, a job that no longer runs or a member who
  lost access, stops the run at once. The broker still checks every model request.
- **Stop on the card.** A job's card has one Stop button while the job waits for a
  slot or runs. A press follows the card's rule: the owner stops any job; the person
  who asked stops only their own job, on its card in its chat. It stops the job like
  the tool's stop; the card says it is stopping, then stopped, and loses the button.
  Changes the job left waiting are rejected with `job_stopped`, as before.
- **Nocheh keeps a supervisor and a progress relay.** The supervisor watches each
  job's run every 15 s, sends its report or note, and relaunches or fails it. The
  relay goes from the hooks through progress lines to the heartbeat. They stay because
  Hermes does not resume a run after its process ends, and only Nocheh can check the
  member's access, the cost and the time against its own records. Nocheh's code for
  jobs grows by them, while the step chain, its continue and wrap-up texts and the
  guess about when the work is done are gone.
- **Changes held while a run runs.** A running job run with a live lease holds these
  until it ends, at most about 55 minutes: reaction epochs, automatic learning,
  approved knowledge changes, deferred owner commands that carry a binding, and memory
  sharing grants. Owner commands from the dashboard carry no binding and stay
  immediate, as do owner corrections and source or privacy revocations.
- Every profile compresses its context from 100,000 tokens.
- The scripted model of the installation rehearsal gains `todo_list` calls,
  `[[delay:S]]`, the resume rule and notice, resume and restart events, so the full
  tester can drive long runs, Stop, a killed turn and both limits.
</decision>

<note date="2026-11-04">
Amended by [ADR-0208](0208-running-jobs-carry-across-quiet-epochs.md): a running job
run carries across reaction epochs and automatic learning revisions, and they no
longer wait for it. Approved knowledge changes, deferred owner commands that carry a
binding and memory sharing grants still wait, and any other epoch still ends the run.
A relaunch keeps the last run's binding while it carries to the current one, so after
only quiet epochs it also reloads its history and gets the resume line. The restart
text now follows only a change that is not quiet, so it no longer shows the to-do list.
</note>

<alternatives>
- **Hermes Kanban.** Rejected for now. Its stock worker runs the agent in Hermes's
  own container, which ADR-0029 forbids; its start hook is a parameter, not a
  supported lane; and it would put a writable board in a container the model steers.
  To be looked at again when Hermes offers a configurable external worker lane, when
  a job must split into parallel parts or take questions while it runs, or when jobs
  must run longer than one credential.
- **Keeping the chain of steps.** It kept the 144 s notice problem, Nocheh's guess
  about when the work was done, and messages from Nocheh steering the agent's work.
- **Refreshing the credential or raising its one-hour limit**, so a run could last
  longer. That is a change to the credential's security and needs its own decision.
</alternatives>

<consequences>
- A job is at most about 55 minutes from start to its last stop; bigger work is
  several jobs and several cards.
- One box per run: after a run that ended abnormally the next run gets a new box, and
  what was in /work is lost. /chat is filled once per run, within the launcher's fill
  time, so a big chat can stay partial for the whole run.
- A job holds its slot, and a launcher slot, for up to about 55 minutes.
- The cost notice and the counts come from Nocheh's code inside the run, the same
  trust as the step counts before, with ADR-0206's byte backstop, which does not rely
  on them. The overspend at a limit is about one model call and a heartbeat.
- A relaunch may repeat the last tool round. Changes wait on cards, so a repeated
  change shows up there and does not run by itself; reads may repeat.
- Open: the iteration-cap summary may be tried twice and is counted once; failed or
  interrupted main calls are not counted, so only the backstop bounds them; a crash
  between 3 minutes before the soft deadline and the hard deadline fails the job
  instead of sending a note; a long run with a real model, compaction quality and the
  bytes per token of the backstop are to be measured on a real installation.
- Every Hermes upgrade re-checks the constructor arguments, the time notice and its
  80% rule, the iteration-cap summary, the hook names and payloads, the compression
  setting, per-round persistence and history reload, and re-runs the background-job
  scenarios of the full tester.
</consequences>
