# ADR-0291: A message joins the running turn in its chat

<status>
Accepted on 2026-11-24. The owner asked for "Talk while it works" ("love 'Talk while it works'
all hermes these days have this feat"). Extends
[ADR-0125](0125-per-chat-telegram-dispatch-lanes.md) and the per-chat turn order kept by the
agent's lanes; it changes no earlier decision.
</status>

## Context

A message sent while the agent still works on an earlier one in the same chat waited in line,
and got its own reply only after the first turn ended. Hermes has its own steer: a running
agent takes user text (`AIAgent.steer(text, ticket=...)`), reads it as a marked user message
right after its current tool step, and can say which tickets it read (`withdraw_steer`). Nocheh
runs each turn as its own sealed process and must keep every message answered once and in order.

## Decision

1. **Same person, same conversation, same rights.** A new message joins the turn running in its
   first lane only when its whole checked scope and lane equal that turn's: the same person in
   the same chat or topic, under the same guard epoch and revision. A member's message never
   joins the owner's turn, nor the owner's a member's.
2. **Plain messages only.** A private answer, an ask about a member, an approval's follow-up, a
   fixed reply, a scheduled run and a job never join or take joiners. A message with a photo, or
   one of the questions a turn answers with a fixed reply, may be joined into but never joins,
   because the agent reads only a joined message's text.
3. **Order first.** A message joins only when every message waiting before it in its lane joined
   the same turn. The child takes joined messages in order and takes none once its conversation
   ended, so the ones the agent read are always the first ones offered.
4. **Hermes's own steer, no Hermes changes.** The parent writes each joined message as one line on
   the turn's stdin after the request, framed as a turn frames a message (speaker line, reply
   block, archive source). The child hands it to `AIAgent.steer` with the message's run id as the
   ticket, but only once the agent has run a tool in this turn: Hermes places a steer after the
   newest tool result, and before the turn's first tool that is a result in older history. When
   the conversation ends, it withdraws every ticket the agent never read and names the rest in
   its result (`joined`).
5. **Sealed turns.** The bridge sends joined messages to the launcher's `/v1/turn/steer`, with the
   service token, the turn's pass and a random nonce the turn was started with. The launcher writes
   them to that turn's container stdin only; anything else is refused.
6. **Answered or not.** A joined message the agent read, in a turn that ended done or silent,
   closes `suppressed` with `joined_turn`: no reply of its own, 👍 on it, and it counts as answered
   for memory suggestions and knowledge proposals. Any other joined message runs as its own turn
   right after, as before.

## Consequences

- Most quick replies make no tool call, so the agent finishes before it can read a joined
  message; that message then gets its own reply right after, as before.
- Notes the agent writes after reading a joined message are labelled with the running turn's
  message. Retiring a joined message withholds its row in Hermes's history like any row that
  cites it.
- If the running turn's reply is withdrawn after it ended (its context changed), the turn runs
  again without the joined messages, which were already closed as answered.
