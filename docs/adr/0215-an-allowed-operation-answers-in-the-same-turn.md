# ADR-0215: An allowed operation answers in the same turn

<status>
Accepted on 2026-11-08, as the third part of the plan the owner approved for
answers after approval: once a rule or the owner freedom setting already allows
an operation, the person who asked gets one message, not "it is running" and a
second reply. Amends [ADR-0212](0212-approved-operations-answer-in-the-chat-that-asked.md):
the 55-second Notion rule is replaced by an explicit mark.
</status>

<context>
- After [ADR-0214](0214-allow-a-site-or-command-in-one-chat.md) an operation can
  run without a card. Its proposal returns at once, so the reply says it is
  running and the follow-up of ADR-0212 brings the answer as a second message.
- `notion_tool` already waits up to 60 seconds in the turn for a call the owner's
  setting allows. ADR-0212 guessed that such a call needed no follow-up when it
  ended within 55 seconds of its request.
</context>

<decision>
- **Signal.** A proposal that will run without a card, under the owner freedom
  setting or a rule, says `allowed: true`.
- **Wait.** `nocheh_shell` and `nocheh_browser` then poll the operation for up to
  60 seconds, as `nocheh_notion` does, and return its result when it ends. A slow
  or failed read returns the proposal, which says the answer will follow.
- **Mark.** Once the tool holds an ended result, it sends a note,
  `/v1/tools/actions/<id>?in_turn=<state>`, naming the state it read. Only
  Nocheh's tool code sends it. When the note comes from the operation's asking
  turn, not from a follow-up turn, and names the current ended state, Nocheh
  records it in `controlled_actions.observed_in_turn`. The note returns only the
  state. If the result read fails or times out, or the note is lost, nothing is
  recorded, so the follow-up repeats the answer rather than dropping it.
- **Skip.** A follow-up is skipped as `answered_in_turn` only when the recorded
  state is still the operation's state and the asking turn's reply went out
  (dispatch `done`). A late receipt that changed the state, or a reply that was
  not sent, still gets its follow-up. The check runs after the wait for the asking
  reply, and merged siblings use it too.
</decision>

<consequences>
- An allowed web read or command answers in one reply when it ends within a
  minute; a slower one keeps the follow-up.
- A turn waits up to a minute longer when it asks for an allowed operation.
- Each poll reads the operation through the secret check, as Notion's wait does.
- A turn that read the answer and then chose silence is followed up, since its
  dispatch did not end as sent.
</consequences>
