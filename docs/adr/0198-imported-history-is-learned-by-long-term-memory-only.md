# ADR-0198: Imported history is learned by long-term memory only

<status>
Accepted on 2026-10-31. The owner approved skipping memory notes when an import's
history is learned ("yes"), after the import cost estimate showed that the notes
review was most of the cost, and then skipping the learning question about each
old message too. Extends
[ADR-0124](0124-native-review-once-per-source.md) and
[ADR-0191](0191-imports-share-secret-checks-and-become-ready.md).
</status>

<context>
- Learning a message ran one Hermes memory-notes review for it, a full model turn
  over the message and its context, and one Honcho learning question about it
  (`learning.interpret`), as well as Honcho reading and summarizing the chat. Measured
  runs used about 19,000 input tokens for a review and 12,500 for a learning answer.
- An export of tens of thousands of messages meant tens of thousands of both. Old
  history rarely changes what the assistant should note about the owner now, and a
  job that needs the whole history reads the chat itself.
- The import estimate counted the notes review but not the learning answer.
</context>

<decision>
- A message whose original came from an import is not queued for a memory-notes
  review, and no learning question is asked about it. Honcho still reads and
  summarizes it, which still needs the owner's learning approval at import.
- Live messages are reviewed and interpreted as before.
- The import estimate shows only long-term memory: Honcho's reading and summaries.
</decision>

<consequences>
- Learning an import costs a fraction of what it did, and its notes reviews no
  longer hold the background slot for hours.
- Assistant notes and learned meanings and rules come from live conversations only.
  A fact from old history reaches replies through long-term memory, search by
  meaning, archive search and reading the chat.
</consequences>
