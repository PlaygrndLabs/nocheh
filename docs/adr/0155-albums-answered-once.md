# ADR-0155: An album is answered once, on its first part

<status>
Accepted on 2026-10-19 after the owner said yes to fixing the known gaps before
the release tests ("albums arrive as separate turns").
</status>

<context>
Telegram sends an album as one message per photo or file, sharing a
`media_group_id`. Every message started its own turn, so an album of five
photos got five replies and no turn saw the whole album. Only one part usually
carries the caption.
</context>

<decision>
- The album's parts are the live messages in the same chat with the same
  `media_group_id`, captured within ten minutes of each other, in Telegram
  update order.
- No part is dispatched until every captured part is two seconds old, because
  the parts of one album arrive together.
- The first part runs one turn with every ready, unretired part of the same
  conversation: their texts in order, their files and derived text, and group
  addressing combined across parts. The turn input lists the other parts.
  A part that is still preparing holds the reply for at most two minutes;
  after that the reply goes without it.
- The other parts close without a turn of their own as `album_member`, shown
  as "Answered with its album".
- A turn may read the files of every part of its album.
</decision>

<consequences>
- An album gets one reply, to its first part, that can see every part.
- A part arriving after its album's turn started closes without being seen by
  that turn.
- Each part is still archived, guarded and learned on its own.
</consequences>
