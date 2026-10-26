# ADR-0168: Superseded guard-epoch profiles are removed once idle

<status>
Accepted on 2026-10-26, when the owner said "yes for all" to cleaning up old
chat history copies after the release test rerun. Test 4 found that the
previous epoch's profile still held the hidden reply in its session database,
and test 5 showed that busy reactions start several profiles a minute.
</status>

<context>
Each guard epoch gives a chat a new Hermes profile, and since
[ADR-0163](0163-chat-conversation-carries-into-new-guard-epochs.md) the new
profile carries the recent conversation. The earlier profiles stayed on disk,
unused. They kept rows that were hidden or corrected later, since retirements
are applied only to the profile that takes the next turn, and they grew with
every hide, restore, correction, learning revision and reaction.
</context>

<decision>
- When a chat's profile for a guard epoch is prepared, earlier-epoch profiles
  of the same chat, owner flag, installation generation, logical profile and
  kind (assistant or filtering) are removed.
- A profile is removed only after 15 minutes with no change to its files, so a
  turn or memory review that started before the epoch changed can finish. A
  profile whose memory or carry lock is held is left for a later turn.
- An assistant profile removes its predecessors only after its own
  conversation was carried without error, or once it holds its own session, so
  a failed carry never loses the conversation.
- Profiles of other chats, installations or purposes, and newer epochs, are
  never touched. A removal that fails is logged and retried on a later turn.
</decision>

<consequences>
- Hidden and corrected content no longer stays behind in superseded profiles,
  and the profile folder no longer grows with every epoch change.
- The dashboard's list of earlier native profiles shows only those not yet
  removed. Hermes native notes of a removed profile are gone; they were never
  carried into the new epoch.
- An epoch change that was less than 15 minutes ago still leaves its previous
  profile until a later turn of that chat.
