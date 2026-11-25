# ADR-0310: A reaction to a gone message is not a problem

<status>
Accepted on 2026-11-25. The owner got a problem notice for one failed send: a reaction that
Telegram refused with `message_not_found`, because the message it was for had been deleted.
Amends the problem rule of [ADR-0238](0238-record-every-send-to-a-chat-app.md).
</status>

## Context

- Nocheh reacts to a message it is working on (👀, then 👍 or 👎). The sender can delete that
  message before a reaction goes. Telegram then answers `message to react not found`, recorded
  as `message_not_found`.
- ADR-0238 counted every failed or uncertain send as a problem, except the expected no-ops
  `message_not_modified`, `button_answer_expired` and `reaction_not_allowed`, a leave that found
  Nocheh gone and a recovered try. So a deleted message raised a problem notice the owner cannot
  act on.
- A reply, card or edit to a missing message is different: the person may never see it, so it
  stays a problem.

## Decision

1. A `reaction` send that failed with `message_not_found` is not a problem: Health, `/v1/status`
   `chat_sends.problems` and the owner's problem notices leave it out.
2. It is still recorded and listed in System › Sent to apps, with its code and `problem: false`.
3. Every other kind that fails with `message_not_found` stays a problem.

## Consequences

- A bug that reacts to a wrong message ID no longer shows on Health. The record and its code
  stay in Sent to apps to look it up.
