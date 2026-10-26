# ADR-0166: A chat follows its own message requests across turns

<status>
Accepted on 2026-10-26, during the rerun of release test 2. The owner rejected
a card, then asked again for the same post. Nocheh checked the earlier request,
the lookup was refused because it came from a later turn, and Nocheh answered
that the request "should still be waiting" for approval. The owner agreed it is
an issue. Narrows the same-turn rule for reading Telegram message requests.
</status>

<context>
A turn could read a Telegram message request only if that same turn created
it, while controlled actions were already readable by any turn of the same chat
and profile. Request IDs also stay only in the turn's tool results, which a new
guard epoch's profile does not carry
([ADR-0163](0163-chat-conversation-carries-into-new-guard-epochs.md)).
</context>

<decision>
- Any turn of the chat and runtime profile that asked for a Telegram message
  can read that request's state and exact text. The text is still checked for
  the current turn's audience before the model sees it. Other chats still get
  `action_not_found`.
- `nocheh_action_status` without an id lists that chat's ten most recent
  message requests with their states.
- The reply instructions say a rejected, cancelled or failed request is
  finished, so asking again makes a new request, and Nocheh must not say a
  request is waiting, approved or sent unless a tool result in that turn shows
  it.
</decision>

<consequences>
- A follow-up such as "did it go out?" gets the real state, and a repeated ask
  after a rejection gets a new card.
- Anyone who can use Nocheh in a chat can see that chat's earlier requests,
  which were made from that chat's own memory.
</consequences>
