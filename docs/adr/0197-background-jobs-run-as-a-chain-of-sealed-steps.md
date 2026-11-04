# ADR-0197: Background jobs run as a chain of sealed steps

<status>
Accepted on 2026-10-30 as part 4 of the chat-review build the owner approved
("I all thing is ready start build."). The plan the owner accepted lets the agent
notice a big job, estimate it, wait for Approve, and run it in the background with
a live view and Stop. Extends [ADR-0031](0031-native-managed-schedules.md),
[ADR-0165](0165-approval-card-is-the-answer-and-links-its-place.md) and
[ADR-0195](0195-the-agent-reads-a-chat-in-order-and-searches-by-meaning.md).
</status>

<context>
- A reply turn is bounded to a few minutes, but reading a long chat in order
  takes many pages and can take an hour.
- Hermes already keeps a to-do list in its session history and stops a turn at
  its iteration limit. Nothing in Nocheh should decide what kind of job it is.
</context>

<decision>
- The agent sizes a request with `nocheh_background_job`. When it is large, it
  proposes a job with a title and the person's own instruction (one `start` call
  since 2026-11-04; see the note below). Nocheh prices the
  estimate with the reply model and posts an Approve and Reject card that answers
  the request. The person who asked approves, or the owner when a member's
  estimate is over the cost limit or has no known price. A decision expires after
  a day.
- A job is a chain of steps. Each step is one sealed turn through the security
  launcher with its own credential, continuing one Hermes session in a profile of
  its own, so the chat's replies never wait for it. A step ends at its iteration
  limit and the next one continues; a step that answers on its own ends the job,
  and that answer is the report.
- At the cost or time limit, one short last step writes the report from what the
  job has found. A job's limits are the owner's settings, or half again over its
  approved estimate when that is higher.
- The report goes to the chat where the job was asked, under the job's approval,
  in parts sent in order. Stop cancels the running step and sends no report.
- A job's steps are admitted like replies, not behind memory reviews. At most two jobs run at once. Members start a few jobs a day in each group, set
  by the owner; the owner has no daily limit.
</decision>

<note date="2026-11-04">
Amended on 2026-11-04 after the owner's direction that the agent decides by itself
when work needs a job, and the person never words a request as a job.
- The agent makes one `start` call. Nocheh counts and prices the work inside it,
  so there is no separate size step; the result carries the estimate, the limits
  and who approves. A job whose time limit would pass 1440 minutes is refused with
  `job_too_long`, and the agent narrows the period or splits the work.
- Stop follows the card's rule: the dashboard and the owner stop any job; a member
  stops only the job they asked for, in its own chat. A job of another chat is not
  found, and someone else's job in the same chat is not permitted.
- A job's own turns have no job tool, so a job can neither start nor stop jobs.
- The card says that starting it already used one secret check and, for a member's
  job, that it counts toward their daily limit unless it is rejected.
</note>

<note date="2026-11-04">
The chain of steps is replaced by [ADR-0207](0207-a-background-job-is-one-hermes-run.md):
a job is one Hermes run of at most 50 minutes, warned at 80% of its cost or time limit
and stopped at the limit with a short note of what is done and left instead of a
report; a failed run is relaunched at most twice. There is no continue or wrap-up step,
and `job_too_long` now means a time limit past 50 minutes. Stop is also a button on a
running job's card, by the same rule.
</note>

<consequences>
- Any long instruction can run as a job; the instruction and the agent's own
  to-do list decide what it does.
- Each step's cost is kept on the job and in Usage under Background.
- The dashboard view of running jobs and their settings comes in a later part.
</consequences>
