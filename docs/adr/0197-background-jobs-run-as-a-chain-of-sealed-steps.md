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
  proposes a job with a title and the person's own instruction. Nocheh prices the
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

<consequences>
- Any long instruction can run as a job; the instruction and the agent's own
  to-do list decide what it does.
- Each step's cost is kept on the job and in Usage under Background.
- The dashboard view of running jobs and their settings comes in a later part.
</consequences>
