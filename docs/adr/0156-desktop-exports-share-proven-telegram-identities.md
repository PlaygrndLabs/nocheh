# ADR-0156: Desktop exports share the Telegram identities Telegram proves

<status>
Accepted on 2026-10-19 after the owner asked whether importing group history
from exported Telegram data is fully compatible and prevents duplicates
("are we fully compatible with import group chats history from exported
Telegram data and prevent duplicate and kind of that issues?") and chose the
recommended fix. Extends [ADR-0051](0051-platform-independent-sources.md),
which kept Bot API and Desktop namespaces distinct until their identity
mapping was established.
</status>

<context>
A Telegram Desktop export of a group the bot is in repeats messages the bot
already captured live. Every Desktop message and sender had its own Desktop
identity, so each repeated message was a second source object: search showed
it twice, Honcho memory could learn it twice with import learning on, and each
member became a second person. Two exports of the same chat taken at
different times also kept every edited message twice.
</context>

<decision>
- A Desktop sender `user<N>` is the Bot API user `N`, and `channel<N>` is the
  Bot API chat `-100<N>`. Telegram user and channel ids are global, so this is
  proven, not guessed.
- A supergroup or channel export (`private_supergroup`, `public_supergroup`,
  `private_channel`, `public_channel`, with bare id `N`) that the owner mapped
  to the live chat `-100<N>` observes the Bot API message objects of that chat,
  including reply and thread targets. Supergroups and channels number messages
  once for every member.
- Basic groups number messages per member, and an unmapped export has no
  proven live chat, so those messages stay Desktop objects.
- An imported observation of a message the bot also captured live is kept as
  import evidence with its files, returned to the import as `live_copy` and
  counted as a duplicate, marked "Also saved live" for the owner, skipped in
  the assistant's archive search, and never written to Honcho memory: the live
  copy is the message's latest revision.
- Among exported copies of one message, the copy with the latest
  `edited_unixtime` (then the latest import) is the latest revision, so a
  newer export replaces the older one's Honcho writes as in
  [ADR-0154](0154-message-edits-replace-honcho-writes.md).
- The import page names the matching live chat for a supergroup or channel
  export the owner has not mapped to it. The owner still chooses the mapping.
</decision>

<consequences>
- Importing a group export the bot was already in adds only the messages the
  bot never saw, plus import evidence of the rest.
- One person has one memory identity across live messages and imports.
- A basic group export, or one kept private, still repeats messages the bot
  saw live.
- Earlier imports keep their Desktop identities; re-importing applies this.
</consequences>
