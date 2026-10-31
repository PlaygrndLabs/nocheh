# ADR-0198: Imported history is learned by long-term memory only

<status>
Accepted on 2026-10-31. The owner approved skipping memory notes when an import's
history is learned ("yes"), after the import cost estimate showed that the notes
review was most of the cost. Extends
[ADR-0124](0124-native-review-once-per-source.md) and
[ADR-0191](0191-imports-share-secret-checks-and-become-ready.md).
</status>

<context>
- Learning a message ran one Hermes memory-notes review for it, a full model turn
  over the message and its context, as well as Honcho's learning.
- An export of tens of thousands of messages meant tens of thousands of review
  turns. Old history rarely changes what the assistant should note about the owner
  now, and Honcho already learns from every message.
- The import estimate counted the notes review but not Honcho's learning answer
  for each message (`learning.interpret`, one reasoning call with its search rounds).
</context>

<decision>
- A message whose original came from an import is not queued for a memory-notes
  review. Its Honcho writing and learning are unchanged, and still need the owner's
  learning approval at import.
- Live messages are reviewed as before.
- The import estimate shows long-term memory (Honcho's reading and summaries) and
  learning from each message (one Honcho learning answer per message, at typical
  token counts), and no memory notes.
</decision>

<consequences>
- Learning an import costs a fraction of what it did, and its notes reviews no
  longer hold the background slot for hours.
- Assistant notes reflect live conversations only. A fact from old history reaches
  replies through long-term memory, archive search and reading the chat.
</consequences>
