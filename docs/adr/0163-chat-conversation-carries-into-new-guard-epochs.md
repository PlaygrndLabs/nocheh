# ADR-0163: A chat's conversation carries into each new guard epoch

<status>
Proposed on 2026-10-20 after the owner's release test 4 (hide a message, then
Undo). The live check showed that each guard epoch gives a chat a new Hermes
profile with an empty session database, so Nocheh forgot the ongoing
conversation seven times in two days, four of them after automatic learning.
</status>

<context>
A chat's Hermes profile is named from its installation generation, chat, guard
epoch and purpose. The epoch advances when the owner hides or restores a
message, links identities or corrects memory, and when automatic learning
revises an existing learned entry. A new profile copied only its preferences,
so its first turn replayed no history and a follow-up question lost its
context. Stored native history is already brought current in place: before
each turn a profile withholds rows for sources retired since its last turn
([ADR-0123](0123-retired-sources-leave-native-history.md)), and history is
prepared again for the current epoch before the model sees it.
</context>

<decision>
- When a chat's profile for a new guard epoch is first prepared, its sessions
  are seeded once from the newest earlier-epoch profile of the same chat,
  installation generation and purpose that holds a conversation. Filtering
  profiles and named runtime profiles do not carry.
- Only stored user messages and delivered answers are carried, up to the 120
  most recent. Tool calls, tool results, reasoning and compaction summaries
  stay in the earlier profile, as do Hermes native notes.
- Carried user messages keep their archive source markers, and rows already
  withheld keep their placeholders, so the first turn in the new profile
  withholds anything retired since before history is prepared for the new
  epoch.
- A profile that already holds a chat session is never overwritten. A failure
  to carry is logged and the turn runs on an empty conversation, as before.
</decision>

<consequences>
- Nocheh keeps the recent conversation across hides, restores and automatic
  learning, and the first reply after an epoch change no longer starts cold.
- Content that reached the conversation only through tools, such as shared
  memory, does not cross into the new epoch; delivered answers that quoted it
  do, as they are this chat's own messages.
- Earlier-epoch profiles remain on disk; pruning them is separate work.
</consequences>
