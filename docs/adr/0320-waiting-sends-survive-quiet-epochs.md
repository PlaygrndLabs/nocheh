# ADR-0320: Waiting sends survive quiet epochs

<status>
Accepted on 2026-11-28, after a live test: the owner pressed Approve on a card for a message to another group, and the
card said "Approved, but not sent: something it used changed after it was asked". An automatic learning batch had moved
the guard epoch 0.5 s before the press was decided. Extends [ADR-0200](0200-waiting-approvals-survive-reaction-epochs.md)
from tool actions to Telegram sends.
</status>

## Context

- A Telegram send (`telegram_action_requests`) is bound to the guard binding it was proposed under. Its approval, the
  workflow's claim, its text check and the bot's last check before sending all required that exact binding.
- Every reaction in any chat, and every automatic learning batch, moves the epoch. On the live install that happened
  several times an hour. Any card left open across one was cancelled with `action_context_changed`.
- ADR-0200 already lets tool actions carry across such quiet epochs (`carriesForward`): they hide and replace no message.

## Decision

1. The send's fence (proposal, system staging, approval and claim) accepts a binding that carries to the current one, as
   tool actions do. Any epoch that is not quiet still closes it with `action_context_changed`.
2. Its text check (`text`) and the bot's last check (`validate`) take the current binding when the old one carries, and
   read the guarded copy under it. Nothing is rebound: the request keeps its binding, fingerprint and guarded revision,
   and the proposal hash, text hash, guarded revision and active copy checks are unchanged.
3. A memory follow-up's fact grant is still matched by the request's own binding; its guarded copy is read under the
   carried one.

## Consequences

- An owner can approve a message an hour later in a busy install, as with tool cards.
- An owner correction, a hide, a policy, project or schedule change between the proposal and the press still cancels it.
- A scheduled run's result (`requestScheduled`) still needs its exact binding; it is not changed here.
