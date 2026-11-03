# ADR-0201: Job reports survive reaction epochs

<status>
Accepted on 2026-11-01, when the owner chose "All three, in order" to build steps
2 to 4 so Nocheh works like a Claude Code session; a background job that checks a
Notion task table against a group chat runs long, and groups react meanwhile.
Extends [ADR-0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md) and
[ADR-0200](0200-waiting-approvals-survive-reaction-epochs.md).
</status>

<context>
- A job's report is the answer of its last step. It is sent to the chat where the
  job was asked, part after part, as trusted Telegram messages.
- Each part was checked for the job's audience in the epoch the job was asked in.
  So any epoch change since then, even a reaction in another group, made the
  check refuse it (`audience_context_changed`), and long jobs lost their reports.
- A step ends done only if its epoch did not change while it ran. So the last
  step's binding is the epoch the report was written in.
</context>

<decision>
- Before each new part, the last step's binding must carry to the current one
  (`carriesForward`, ADR-0200): only quiet epochs may lie between. Otherwise the
  job ends as failed with `job_report_outdated` and no further part is sent.
  Changes before the last step do not count; that step read only what was
  visible then.
- The part is checked and staged for the job's audience in the current epoch.
  Nothing is rebound, and the Telegram message keeps its exact-binding rule.
- A part's message and its report record commit in one transaction, under a lock
  on the job. A retry after a crash or in a later epoch, or a second tick, cannot
  send a part twice.
- A job whose Stop was pressed stages no further part and ends as stopped.
</decision>

<consequences>
- Reactions in any chat no longer lose a job's report.
- Automatic learning revisions are quiet too since 2026-11-03 (ADR-0200), so they
  no longer fail a report before its next part is staged. A report may then quote
  learned wording that a revision replaced after its last step.
- A reaction or an automatic learning revision between staging a part and sending
  it still cancels that part, and the job fails with `job_report_not_delivered`.
- A part already staged when Stop is pressed may still arrive.
</consequences>
