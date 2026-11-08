# ADR-0202: Approved actions report how they ended

<status>
Accepted on 2026-11-01, when the owner chose "All three, in order" to build steps
2 to 4 so Nocheh works like a Claude Code session; a background job that checks a
Notion task table asks for Notion calls, and the owner needs to see how each ended.
Extends [ADR-0029](0029-controlled-tool-execution.md),
[ADR-0158](0158-telegram-approval-buttons.md) and
[ADR-0166](0166-a-chat-follows-its-own-message-requests.md).
</status>

<context>
- An operation's card lost its buttons once it was decided, but never said whether
  it then ran. Its end states come from the executor's receipt, a claim that
  records a saved receipt, a lease that expired, or a claim that stops it. None of
  these edited the card.
- A remote tool that answered with its own error (`isError`) was recorded as done.
- An operation that a job's step or a scheduled task asked for got the reply meant
  for the owner's private chat, and its card did not say where it came from. A
  request too long for a card left the agent with no word on where to review it.
- A later turn or job step that lost an operation's ID could list only Telegram
  message requests.
</context>

<decision>
- Once the store commits a new end state of an operation, a `settled` hook asks for
  its card to be edited. It is never awaited, so a card edit cannot delay, fail or
  repeat a receipt. It reads the owner's view and changes nothing.
- The added line comes from a fixed map of codes to the owner-editable lines in
  `telegram.approval_texts`: done, failed with a reason, unsure, or did not run with
  a reason. An unknown code shows "see the dashboard Inbox." No tool, service or
  remote text reaches the card.
- An operation whose start was never recorded did not run, because the executor
  runs only after it. One that stopped before it sent anything, for example because
  the tool is off or Notion needs a sign-in or cannot be reached, did not run either.
- The store edits one card at a time, in the order the edits were asked for, and
  each edit reads the state when it starts. So the last edit shows the latest state,
  whether a press, the hook or the dashboard asked for it.
- A press or `/approve` on an operation whose inputs changed since it was asked
  answers that it did not run, and why.
- An MCP `tools/call` answer with `isError: true` fails with `tool_reported_error`.
  The answer is kept, so the agent can read it by ID.
- A card for an operation that a job's step asked for names the job by its title;
  one from a scheduled task says so. Their agent is told that the owner got the
  card, not to wait for it, and to say what it asked for. A request too long for a
  card tells the agent that the owner can review it in the dashboard Inbox.
- Without an ID, `nocheh_action_status` also lists the last 20 operations of the
  chat or job by ID, kind, state, error code and time, for the same readers as one
  read by its ID (ADR-0200). A job's later steps are told that.
</decision>

<consequences>
- Failed MCP calls now count in Health and in problem notices.
- A slow card edit holds up later edits of the same card, up to its 15 second limit.
- An owner cancel from Workflows does not edit the card yet.
- An operation that had no card, because a setting or a standing permission allowed
  it or it was too long, edits nothing: the gateway edits only cards it sent.
</consequences>
