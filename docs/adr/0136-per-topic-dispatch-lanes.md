# ADR-0136: Each group topic has its own dispatch lane

<status>
Accepted on 2026-10-12. Supersedes the "Topics of one group share the group's
lane" rule of [ADR-0125](0125-per-chat-telegram-dispatch-lanes.md); its
per-conversation order, receipts and native batch handling are unchanged.
</status>

<context>
After topics began sharing one memory
([ADR-0135](0135-group-topics-share-memory.md)), the owner asked three
questions in three topics of one group within about a minute. They ran strictly
one after another because the whole group shared one dispatch lane, so the
second and third waited 53 and 76 seconds in the Hermes queue before their own
work started. Each topic already has its own space, Hermes profile and
conversation history, Honcho session and delivery binding, and native text
batches are keyed per chat, topic and sender, so nothing in a topic's turn
depends on another topic's turn finishing first.
</context>

<decision>

- The dispatch lane key is the turn's conversation space: the chat for a
  private chat or a group's General chat, and `<group>/topic/<n>` for a topic.
- Turns in one topic still start in arrival order and one at a time. Turns in
  different topics of one group run side by side like different chats, within
  the owner-set reply limit and agent-run slots
  ([ADR-0126](0126-owner-set-parallel-replies-and-runs.md)).

</decision>

<consequences>
- A slow answer in one topic no longer delays the group's other topics.
- A busy group can take more of the shared reply slots at once; the owner-set
  reply limit still caps the total.
- A topic turn can read another topic's memory while that topic's turn is
  still running; it sees what was stored before it started.
</consequences>
