# ADR-0203: Jobs the owner approved read Notion under the owner's setting

<status>
Accepted on 2026-11-01, when the owner chose "All three, in order" to build steps
2 to 4 so Nocheh works like a Claude Code session: a background job checks a
Notion task table against a group chat, which takes many Notion reads. On
2026-11-03 the owner chose "Reads free, changes ask": a job's reads follow the
owner's setting, and its changes always ask. Extends
[ADR-0175](0175-notion-through-its-mcp-server.md) and
[ADR-0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md).
</status>

<context>
- Every Notion call from a job's step waited for a card, whatever the owner's
  Notion setting was, so reading a table of a few hundred rows needed a tap for
  each read.
- A job reads group messages that anyone in that group can write, and it runs
  unattended for up to its time limit.
- ADR-0175 says scheduled jobs never reach Notion. The code lets an owner-scope
  scheduled run propose a Notion call that then asks first.
</context>

<decision>
- A step of a job that the owner asked for in their private chat and approved there
  uses the owner's Notion setting for reads, the same as a live reply there. Every
  input to that check comes from the step's signed credential and Nocheh's own rows:
  the step's operation, the job, its profile, its chat and who decided it. The job
  must still be running and not stopping.
- In a job, a Notion change always asks the owner first, even under "Nothing asks
  me". "Everything asks me" makes reads ask too.
- Group jobs and member jobs never reach Notion, not even as a card. The owner
  freedom setting never applies to jobs.
- Scheduled tasks ask before every Notion call. This corrects ADR-0175's "never
  reach Notion" for owner-scope schedules.
- The job's Approve card has the line "📒 It can read your Notion without asking.
  Changes still ask you." when that applies. It is computed when the card is drawn,
  and the current setting still decides each call.
- Stop also stops a read the setting let run that has not started yet
  (`job_stopped`). A call the owner approved on its own card stays approved.
</decision>

<consequences>
- Group text the job reads can steer which Notion pages it reads. What it reads goes
  only into the owner's report or into another operation that asks the owner.
- A read let through in the seconds before Stop may still run if it started first.
- The card line is not part of the job's fingerprint, so a setting changed after the
  card was drawn applies to the job without a new card.
</consequences>
