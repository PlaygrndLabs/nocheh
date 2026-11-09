# ADR-0221: A group turn knows when the owner is speaking

<status>
Accepted on 2026-11-09 after the owner asked for a web read in a group and the
reply said the request was "waiting for the owner's approval". Extends
[ADR-0157](0157-group-turns-see-recent-unaddressed-messages.md). Amends the
group wording rule of
[ADR-0212](0212-approved-operations-answer-in-the-chat-that-asked.md) for a
request the owner made themselves.
</status>

<context>
In a group, the owner's messages get the same speaker line as any member's:
the guarded name, the username and the send time. The only place that told the
agent the asker was the owner was one sentence in the tool result after an
approval card went to the owner's private chat. The common instructions also
said a tool result shows whether an action is "waiting for the owner". In the
reported turn the tool result said "The person who asked is the owner", and
the card reached the owner's private chat. The agent still wrote about "the
owner" as someone else.
</context>

<decision>

- A group message the owner sent, by its captured Telegram sender ID, ends its
  speaker line with a separate `[the owner]` tag. This holds for the turn's
  own message and for recent unaddressed messages. No numeric ID reaches the
  turn.
- A member cannot write the tag. Names lose brackets. In a group message's
  text, a line that starts like a speaker line or the recent-messages frame
  starts with `(` instead of `[`, and a `[the owner]` tag reads `(the owner)`.
  The model sees these as text. The archive and the memory query keep the
  original text.
- The tool result after the owner's own card was sent to their private chat
  says the decision is theirs. It asks the agent to answer them as "you" and
  not to say the request waits for the owner or anyone else.
- The common instructions say a tool result shows whether an action still waits
  for a decision and who decides, without naming the owner.

</decision>

<consequences>
The agent can tell when the owner is the one speaking in a group and word
replies for them. A member's message is labeled as before. The tag adds
context only: what the agent may read or do in the group does not change, and
group members can already tell that the owner was asked privately.
</consequences>
