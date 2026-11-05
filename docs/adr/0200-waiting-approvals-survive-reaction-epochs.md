# ADR-0200: Waiting approvals survive reaction epochs

<status>
Accepted on 2026-11-01, when the owner chose "All three, in order" to build steps
2 to 4 so Nocheh works like a Claude Code session; a background job that checks a
Notion task table against a group chat needs its approvals to outlive group
activity. Extends [ADR-0029](0029-controlled-tool-execution.md) and follows the
same rule as [ADR-0108](0108-first-derivative-selection-does-not-revoke.md): a
change that hides or replaces no message does not revoke. Extended on 2026-11-03,
when the owner chose "Keep them valid": automatic learning revisions are quiet too,
and an approved action that carries now also runs.
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
- Automatic learning rewrites learned memories every few minutes in a busy chat,
  and each revision advances the epoch. A list of changes the owner approves an
  hour later would often be dead.
- The executor checked the owner's tool settings by the action's own native
  profile, whose name holds its epoch. Control resolves native profiles only for
  the current epoch, and never for a job's own profile. So an action that carried
  across an epoch, and every action a job asked for, was approved and then failed
  with `tool_policy_unavailable`.
- A learning batch writes pending memory publications. While they are pending,
  starting an action and the executor's settings check are refused, so an action
  claimed just before a batch ended as ambiguous or failed.
</context>

<decision>
- An epoch that only records a reaction change, or an automatic learning revision
  (`activateBatch`), is written to `guard_quiet_epochs` in the same transaction,
  under the same lock, that advances it. No other epoch is recorded: owner
  corrections, hides, guarded-copy and selection replacements, project
  organization, schedule and knowledge changes advance their own unrecorded epoch.
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
  rejecting the action. A learning batch waits while an approved action is running,
  so no learning publication becomes pending between its claim and its end.
- The executor checks the tool settings of the action's chat: the claim gives the
  chat's stable profile and its space, and the executor reads the settings a turn of
  that chat copies: an owner's named profile's own, else the space's, else its
  chat's. A job's own profile is not a chat profile, so a job's action follows its
  chat's settings, and the owner's private chat has no settings per topic. Both
  lookups use the stable name, and a failed read is tried twice more a second apart,
  so a new epoch during the check does not fail the action.
</decision>

<note date="2026-11-04">
Extended by [ADR-0208](0208-running-jobs-carry-across-quiet-epochs.md): a background
job's running run carries across quiet epochs too, by the same `carriesForward`, at
the broker, the app server, its heartbeat, its delivery check and its receipt, and
reactions and automatic learning no longer wait for it. An action such a run asks for
is bound to the run's own binding and profile. Replies, browser and scheduled runs
keep the exact binding.
</note>

<consequences>
- Reactions in any chat and automatic learning no longer cancel waiting or approved
  actions, and an approved action then runs. The owner still approves the exact
  operation shown on the card.
- Trade-off: a waiting action may have used a reaction that was later changed.
  For example, a member removes a 👍 that the proposal mentioned. Later reads skip
  that reaction, but the action still runs as shown on the card. This is accepted,
  because a reaction change hides no message and the owner reviews the exact
  operation.
- Trade-off: a waiting action may quote learned wording that a revision has since
  replaced, including one that followed a participant's correction in the chat.
  The card still shows the exact operation, and a later turn of the asking chat
  still reads it whole. The audience does not widen: a revision keeps its entry's
  scope, its evidence must be readable by the same audience, and it never retires
  an entry. Message edits advance no epoch, so before this a revision that followed
  an edit also stopped cards built on the earlier wording; now nothing does.
- Hiding or restoring messages, guarded-copy and memory edits, owner corrections,
  automatic project organization after learning, schedule and knowledge changes,
  Honcho attach and mode changes still stop waiting actions, and any epoch source
  added later stops them too unless it records itself as quiet.
- A learning batch can wait up to one action's lease (120 seconds) while an
  approved action runs.
- Still open: a shell action runs in its own epoch's profile workspace, which is
  removed after 15 idle minutes once the chat has a later epoch's profile. A shell
  approval that waits longer then fails without running. Another pending
  publication, such as an owner correction, between claim and start still ends the
  action as ambiguous, and one that lasts through the settings check's three reads
  fails it with `tool_policy_unavailable`.
- Telegram message requests keep their exact-binding rule.
- `guard_quiet_epochs` is not pruned; rows are small, and a missing row only makes
  an action stop.
</consequences>
