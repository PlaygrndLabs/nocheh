# ADR-0135: A group's topics share one memory by default

<status>
Accepted on 2026-10-12. Amends [ADR-0030](0030-configurable-space-memory.md) and
[ADR-0115](0115-honcho-session-revisions.md): a group or topic turn reads its
whole group's conversations unless the owner keeps topic memory separate.
</status>

<context>
A question asked in a group's second forum topic could not recall what the
owner had said in another topic of the same group. Every recall path compared
the turn's space (`<group>/topic/<n>`) with the source's space exactly, so each
topic, and the group's General chat, had a separate memory. The owner wants all
topics of a group to share one memory by default.
</context>

<decision>

- `TELEGRAM_TOPIC_MEMORY` is `group` (the default, "Whole group" in Settings ›
  Telegram access) or `topic` ("Each topic"). Storage services read it as
  part of the assistant policy; an unknown value stops startup.
- Identities do not change. Each conversation keeps its own space, Honcho
  session and audience, Hermes conversation history, delivery binding and
  policy, so existing data needs no rewrite and the setting can be changed in
  either direction at any time.
- Reads widen instead. `recallScope` gives a scoped principal its own space
  and, with group topic memory, its group; `inRecall` and the SQL
  `recallCondition` admit the group's base conversation and every
  `<group>/topic/<n>`. Archive reads and search, reply and reaction relations,
  Honcho recall sessions and connected peers, owner corrections, persistent
  fact grants, and approved or filtered sharing all use it.
- The group boundary holds: a group or topic turn never reads the owner's
  private chat or another group, and a source whose topic membership is
  unknown stays unavailable.
- The base Honcho context of a turn stays its own topic's session summary and
  the speaker's representation within that session; the recall tool and
  archive search reach the other topics. Hermes native notes stay per
  conversation profile.

</decision>

<consequences>
- A topic can recall the group's other topics as soon as Settings are
  applied; choosing "Each topic" restores the earlier separation.
- An owner grant or sharing release made for one topic is usable in every
  topic of that group while topics share memory.
</consequences>
