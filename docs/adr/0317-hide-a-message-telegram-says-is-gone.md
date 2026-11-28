# ADR-0317: Hide a message Telegram says is gone

<status>
Accepted on 2026-11-28. The owner picked "Auto-hide when Telegram says gone" after a live test: a group message was
deleted, Nocheh's 👍 on it failed with `message_not_found`, and later answers still used the message. Amends
[ADR-0310](0310-a-reaction-to-a-gone-message-is-not-a-problem.md) and the owner-only retirement rule.
</status>

## Context

- In ordinary Bot API chats Telegram does not tell a bot that a message was deleted. Hiding a message was the owner's
  own action in Messages only.
- Telegram does answer a bot that touches a deleted message: a reaction ("message to react not found"), an edit
  ("message to edit not found") or a reply ("message to be replied not found") fails, recorded as `message_not_found`
  in the send records (ADR-0238).
- A failed reply's record named no message, because a reply sends no `message_id`.

## Decision

1. A failed send record whose code is `message_not_found` names the message it was for: an edit or reaction its
   `message_id`, a reply the message it answered (`reply_parameters`, in the same chat).
2. After each drain of the send records, `SourceRetirementRepository.hideGone` checks each such failed Telegram send of
   the last day once (`telegram_gone_checks`). When the archive holds that message and nobody has decided about it yet,
   Nocheh hides it as the owner's hide does: one retirement, revision 1, in one guarded command, with Nocheh's direct
   delivered replies to it that nobody decided about. Pending replies that never started are cancelled, and a running one
   is stopped, as the owner's hide stops it. Quotes are not followed.
3. These retirements carry `decision_authority='telegram'`. Messages shows "Hidden by Nocheh because Telegram said this
   message was deleted" with Undo. The owner's hide or Undo makes the decision the owner's again.
4. A message the owner already hid or brought back is left as it is, also after a later failed send.
5. For one hour after hiding a message, Nocheh also hides a reply it delivers to it later, while the message stays
   hidden by Nocheh.
6. ADR-0310 stands: a failed reaction to a gone message is still not a problem.

## Consequences

- Only messages Nocheh touched are caught. A deleted message Nocheh never replied to, reacted to or edited stays in use
  until the owner hides it.
- A wrong `message_not_found`, such as a reaction to a wrong message id, hides a message the owner may bring back with
  Undo. The original is always kept.
