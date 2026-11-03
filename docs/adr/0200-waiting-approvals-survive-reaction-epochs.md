# ADR-0200: Waiting approvals survive reaction epochs

<status>
Accepted on 2026-11-01, when the owner chose "All three, in order" to build steps
2 to 4 so Nocheh works like a Claude Code session; a background job that checks a
Notion task table against a group chat needs its approvals to outlive group
activity. Extends [ADR-0029](0029-controlled-tool-execution.md) and follows the
same rule as [ADR-0108](0108-first-derivative-selection-does-not-revoke.md): a
change that hides or replaces no message does not revoke.
</status>

<context>
- A shell, browser or MCP proposal (such as a Notion call) is bound to the guard
  binding it was made under: installation generation, epoch and mode. Approval,
  bounded permissions, the claim, the start and the agent's own re-read all
  required that exact binding.
- Every reaction change in any chat advances the epoch, so that contexts built on
  the earlier reaction state are rebuilt. It hides and replaces no message. It
  only makes the earlier reaction state of that message unreadable: later reads
  skip a superseded reaction event (`ReactionStateRepository.isCurrent`).
  Yet the tools workflow re-claims waiting actions every 30 seconds, and a claim
  on a stale binding rejected the action for good. Any group member's reaction
  cancelled every waiting card of the owner within about 30 seconds.
- A later turn or job step could not read its own action after any epoch, because
  the action's profile name contains the epoch. The agent then saw "unavailable"
  and could ask again, which made a second card.
- Re-running the secret check on the arguments and comparing hashes is not a safe
  replacement: the secret check finds secrets, not hidden messages or the owner's
  edits, so text from a message hidden after the proposal would pass unchanged.
</context>

<decision>
- An epoch that only records a reaction change is written to `guard_quiet_epochs`
  in the same transaction, under the same lock, that advances it. No other epoch
  is recorded.
- A binding carries to the current one when the generation and mode are the same
  and every later epoch is recorded as quiet (`carriesForward`). The fence of
  decide, grant, claim and start, and the arguments check, accept a carried
  binding. Nothing is rebound: the action keeps its binding and fingerprint, and
  the proposal hash, fingerprint, guarded revision and active copy checks are
  unchanged. One unrecorded epoch in between stops the action as before.
- Bounded permissions are unchanged. They still match the exact fingerprint and
  binding, so a permission given before a reaction covers the action it was given
  for, and the same operation proposed in a later epoch is a new action.
- A later turn or job step of the asking chat reads an action when it has the
  same chat, owner or member scope, purpose and profile under the action's own
  binding. While the binding carries, it gets the whole view as before. Once it
  does not, it gets only the id, kind, state, error code and time, never the
  arguments or result, because the read route marks whatever it returns as shown
  in the new epoch. The error code is the stored one; only an action that has not
  run yet adds `guard_context_changed`, so a finished action never reads as stopped.
- The dashboard Inbox and a conversation's standing permissions use the same carry
  rule, so Approve stays open and a permission stays current after a reaction.
- A claim that finds a pending publication waits for the next attempt instead of
  rejecting the action.
- Automatic learning revisions are not quiet. They replace learned text already
  shown, invalidate it like an owner edit does, and can carry a participant's
  own correction from the chat; nothing tells those apart. Reactions are the only
  quiet reason.
</decision>

<consequences>
- Reactions in any chat no longer cancel waiting or approved actions. The owner
  still approves the exact operation shown on the card.
- Trade-off: a waiting action may have used a reaction that was later changed.
  For example, a member removes a 👍 that the proposal mentioned. Later reads skip
  that reaction, but the action still runs as shown on the card. This is accepted,
  because a reaction change hides no message and the owner reviews the exact
  operation.
- Hiding or restoring messages, guarded-copy and memory edits, owner corrections,
  learning revisions, schedule and knowledge changes, Honcho attach and mode
  changes still stop waiting actions, and any epoch source added later stops them
  too unless it records itself as quiet.
- Telegram message requests keep their exact-binding rule.
- `guard_quiet_epochs` is not pruned; rows are small, and a missing row only makes
  an action stop.
</consequences>
