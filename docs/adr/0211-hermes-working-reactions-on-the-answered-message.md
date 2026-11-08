# ADR-0211: Hermes's working reactions on the message a turn answers

<status>
Accepted on 2026-11-08, after the owner asked whether the bot can react to
users' messages and then chose Hermes's built-in reactions: "use Hermes build-in
feature I like it." Extends
[ADR-0188](0188-typing-status-while-a-turn-works.md); keeps its typing status.
</status>

<context>
- The pinned Hermes Telegram adapter has an opt-in working reaction: 👀 on the
  message when processing starts, then 👍 for success, 👎 for failure, and
  nothing for a cancelled turn. It runs from the native background processing
  step, through `on_processing_start` and `on_processing_complete`, and is off
  unless `TELEGRAM_REACTIONS` or the profile's `reactions` is set.
- Nocheh's committed adapter replaces the native `handle_message`, so those hooks
  never ran. Its outbound check for a turn admits only `sendMessage`,
  `sendRichMessage` and `sendChatAction`, so `setMessageReaction` would have been
  refused anyway.
- Every other outbound Bot API request goes through the durable outbound journal,
  keyed by the dispatch and the exact parameters. A retried turn keeps its
  dispatch key, so its 👀 would be answered from the journal instead of being
  sent, and the 👎 of the failed attempt would stay.
- Telegram lets a bot set one reaction per message, from a fixed emoji list; 👀,
  👍 and 👎 are on it. Telegram sends no update for a bot's own reaction, and a
  group can limit which reactions are allowed.
</context>

<decision>
- The committed adapter runs the native hooks around a committed turn: 👀 before
  the answer is worked on, and the outcome after delivery. It keeps Hermes's own
  emoji and its own Telegram calls; Nocheh only binds them to the turn.
- The outcome follows the native rule, with Nocheh's own cases: a delivered reply
  is success (👍); a failed turn, or a delivery Telegram refused or never
  received, is failure (👎). A cancelled turn and a turn that ends in intentional
  silence clear the 👀, so a group with "Every message" replies is not covered
  in 👍. An uncertain delivery, which is never resent, clears it too, since the
  reply may have arrived.
- Each reaction passes its own check: the turn's chat, the exact message the turn
  answers, only 👀, 👍, 👎 or clearing, and the space's current permission.
  Cancellation does not refuse it, so a cancelled turn can still clear its 👀. A
  reaction without a bound check is refused before any request.
- Working reactions skip the outbound journal, like chat actions. They carry no
  content and the next one replaces them, so a retried turn sets 👀 again and a
  long turn adds no archive records.
- Turns that show no typing show no reaction either: someone Nocheh doesn't
  serve, a group message that did not address it, and a fixed control reply.
- The owner setting `TELEGRAM_REACTIONS` (`true` by default) is "React while
  working" in Settings › Telegram. It reaches the Hermes service and takes effect
  on Apply.
</decision>

<consequences>
- A turn costs two small Bot API calls and two permission checks, and no stored
  record. A refused or failed reaction is logged by the native hook and never
  fails the turn.
- A failed attempt shows 👎 until its retry, which sets 👀 again and then 👍 when
  it answers.
- When the space's permission is revoked mid-turn, the 👀 stays: Nocheh does not
  act in a revoked space, even to clear its own reaction.
- Nocheh does not archive its own reactions; they are status, not speech.
- The secret check of a new message runs before the turn starts, so 👀 appears
  after it, together with typing.
</consequences>
