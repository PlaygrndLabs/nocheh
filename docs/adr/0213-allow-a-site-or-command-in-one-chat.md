# ADR-0213: Allow a site or command in one chat from its card

<status>
Accepted on 2026-11-08, after the owner asked for Claude Code-style auto-approve
on approval cards, using Hermes's approval words. The details follow the
recommendations the owner was shown: a web read can be allowed in its chat or
topic for 12 hours or for 30 days, an exact command for 30 days, and a connected
tool or a Telegram message is still decided one by one. Extends
[ADR-0200](0200-waiting-approvals-survive-reaction-epochs.md) and
[ADR-0212](0212-approved-operations-answer-in-the-chat-that-asked.md).
</status>

<context>
- A standing permission today matches one fingerprint, which includes the guard
  epoch. Any reaction or learning revision ends it in practice, so the owner
  approves the same weather site again and again.
- Hermes's own approvals know the scopes once, session and always, and key an
  always-allow rule as `plugin_rule:<rule_key>`. Their gate waits inside a turn and
  keeps session approvals in that process, so it cannot hold a decision the owner
  makes later from the private chat (see ADR-0212).
- A web page can steer the agent. An allow-everything mode, like Hermes's `/yolo`,
  would let a page send chat content anywhere.
</context>

<decision>
- **Rule.** A chat rule is an `action_permissions` row with `grain='chat'`. It
  covers one `match_key`, one kind, one chat or topic (`space_id`), one logical
  profile and one installation generation, and never a job's operation. It
  survives epochs. Exact grants keep their fingerprint and epoch.
- **Key.** `controlled_actions.match_key` is set when an operation is proposed,
  from its guarded arguments, in Hermes's `rule_key` format:
  `nocheh_browser:<host>` for a web read and `nocheh_shell:<sha256 of the command>`
  for a command. Other operations have none.
- **Buttons.** A web read's card shows Allow once, Allow where asked for 12 hours,
  Always allow this site where asked and Reject (`na`, `nc`, `nw`, `nd`). A command's
  card shows Allow once, Always allow it where asked and Reject. "Where asked" is the
  chat or topic of the request, since the card itself is in the owner's private chat. Everything else keeps
  Approve and Reject. The gateway accepts two to four buttons, Approve first and
  Reject last, for one action, two to a row. Only the owner's press decides.
- **Decision.** Allow here or Always allow approves the operation and inserts the
  rule in one owner command: 12 hours or 30 days, up to 1000 uses. Other
  operations already waiting in that chat for the same site or command are
  queued and run under it. `/v1/tools/decide` takes the same `allow` field.
- **Matching.** One query serves the proposal, the card offer, the claim and the
  preview; the start check repeats it for the claimed rule. Deny rules still win,
  a relaunched job run still uses no permission, and the operation still fences
  on its own binding.
- **Answer.** A covered operation gets no card. The proposal says a rule the owner
  set allows it and that its answer will follow; the follow-up of ADR-0212 brings
  the answer.
- **Not added.** No allow-everything mode per chat, and no rule for connected
  tools or Telegram messages.
</decision>

<consequences>
- The owner sees rules on the dashboard's Allowed actions page, marked as chat
  rules, and revokes them there.
- A rule set in a topic covers only that topic; one set in the owner's private
  chat covers only that chat.
- An Allow press on a card whose request changed since it was asked runs nothing
  and sets no rule; the owner is asked again.
- Hermes's own approval gate stays unused. If it gains a channel that works after
  a turn ends, the stored keys already use its format.
</consequences>
