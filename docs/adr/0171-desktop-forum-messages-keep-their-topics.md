# ADR-0171: Desktop forum exports keep their topics

<status>
Accepted on 2026-10-26, when the owner asked whether the import supports a
supergroup export with topics ("this is super gp export and hve topics, are we
support it?"). Extends
[ADR-0156](0156-desktop-exports-share-proven-telegram-identities.md).
</status>

<context>
Telegram Desktop's JSON export has no topic field. It keeps each topic's
`topic_created` service message and each message's `reply_to_message_id`.
The importer read a topic only from `message_thread_id`, which Desktop never
writes, so every imported forum message landed at group level. With "Each
topic" memory, none of them belonged to a topic, and imported messages were
learned into the group's Honcho session instead of their topic's.
</context>

<decision>
- A topic's id is the id of its `topic_created` message. Every other message
  of a topic replies to that message or to another message of the topic, so
  the importer follows reply links back to a `topic_created` message and
  records that topic beside the exported message as `topic_id`. The exported
  message itself is unchanged.
- A message with no reply link is in General, which the Bot API also leaves
  without a topic. A chain that leaves the export, loops or ends at General
  gives no topic.
- The topic applies only when the export is mapped to its own live supergroup
  (`-100<id>`), where Desktop and Bot API topic ids are the same message ids.
  There the message's conversation is the live topic and its source gains the
  live `in_thread` relation, so search, recall and Honcho learning treat it
  like a live message of that topic.
- The import review shows how many topics each exported chat has.
</decision>

<consequences>
- A forum export mapped to its live group fills each topic with its own
  history, including messages the bot never saw.
- A topic created before the export's first date cannot be traced, so its
  messages stay at group level, still visible with "Whole group" memory.
- An unmapped export, or one added to the private chat, keeps no topics.
- Earlier imports keep their group-level conversation; re-importing a fresh
  installation applies this.
</consequences>
