# ADR-0204: A job's changes come on list cards at its end

<status>
Accepted on 2026-11-01, as part of the steps the owner chose with "All three, in
order": a background job that updates a Notion task table from a group chat asks
for many changes, and one card for each change floods the owner's private chat.
Extends [ADR-0197](0197-background-jobs-run-as-a-chain-of-sealed-steps.md),
[ADR-0202](0202-approved-actions-report-how-they-ended.md) and
[ADR-0203](0203-owner-approved-jobs-read-notion.md).
</status>

<context>
- Each shell, browser or MCP operation that a job's step asked for got its own
  Approve and Reject card in the owner's private chat while the job ran.
- A job's agent does not wait for the owner, so a decision during the job does not
  help it.
- The dashboard Inbox already lists every waiting operation exactly.
</context>

<decision>
- While a job runs, an operation that waits for the owner gets no card. The agent is
  told that it is kept, not to wait for it, and to say in the report what it asked
  for. It stays an ordinary waiting operation, so the Inbox shows and decides it.
- When the job ends done or failed, after its report, Nocheh puts its waiting
  operations on as few cards as Telegram allows. Each card shows each change's
  exact arguments, never a summary, and leaves room for the outcome line. The split
  is frozen in the job's row before any card is sent, as each card's ID, a
  fingerprint of its members' IDs and fingerprints, and the members.
- A change that does not fit a card alone, or cannot be read for one, is counted on
  the last card as waiting in the Inbox. When no change fits a card, one notice
  without buttons names them. The agent is told at once when its change is too long
  for a card.
- Only the owner presses a list card. Approve or Reject decides each member that
  still waits through the usual decision, which checks its own fingerprint, its
  revision and that its inputs still hold (ADR-0200). A member decided since, in the
  Inbox or by an earlier press, keeps that decision, and the answer says how many the
  press decided.
- The card then says how its changes ended: approved, all done, how many of how
  many were made, rejected, or did not run and why. Each member's end edits its card,
  in order.
- Once Stop is pressed, a step's new operation is refused (`job_not_running`), under
  a lock on the job row that orders it against Stop. When the job ends, however it
  ends, its waiting operations end as rejected with `job_stopped` before its card
  changes, and no list card is sent. A failure there fails the tick, which is tried
  again.
- Card texts are owner-editable lines in `telegram.approval_texts`.
</decision>

<consequences>
- The owner sees a job's changes only after it ends, with its report above them.
- One tap can approve several exact changes; each still runs alone, one at a time.
- A long change needs the Inbox.
- Scheduled tasks and live replies keep one card for each operation.
</consequences>
