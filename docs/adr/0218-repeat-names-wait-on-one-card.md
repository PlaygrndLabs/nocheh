# ADR-0218: Repeat names for one person or project wait on one card

<status>
Accepted on 2026-11-08 after the owner's Waiting list showed three separate
"Remember …?" cards for one project: its name, the name with the word
"project", and the name with its Persian spelling in brackets. The owner asked
for them to be one waiting item, merged automatically or by hand. Extends
[ADR-0056](0056-connected-entity-memory.md) and
[ADR-0091](0091-bounded-agent-knowledge-organization.md).
</status>

<context>
A suggestion card's identity was its kind plus its exact name, lower-cased.
Learning never saw the cards still waiting, so each new spelling, language or
added word made another card. Nothing could merge cards, and confirming two of
them made two projects.

Confirming a project card also made its entity under a different ID than the
one later learning uses for a project. The second entity broke the unique
project index, so learning failed for any message that named the project.

Honcho has no peer merge or alias. A waiting card is not an entity, binding or
Honcho peer, so merging cards changes no memory.
</context>

<decision>

- A person or project card can hold other names. A folded name stays its own
  row, with its own evidence, and points at its card. Account-link cards never
  fold.
- A new name joins a waiting card of the same kind and the same known-entity
  candidate when learning names that card as `same_as`, or when the names
  match once case, a leading `@` and a trailing `(…)` are ignored. Everything
  else is a new card, as before. The join locks the card, so two names that
  arrive together cannot make two cards or join an answered one.
- Learning sees up to 20 of the newest waiting person and project cards, each
  with up to 10 folded names, but only cards whose evidence its conversation
  may read and learn from. Nocheh checks at most 500 waiting cards to find
  them. Learning recognizes another name for the same thing in any language.
  No word list is used.
- Waiting cards are the first thing dropped when a learning request is too
  long, and they are not part of the key that lets learning reuse earlier
  work, so a new card never forces a message to be learned again.
- The owner can fold a card into another waiting card of the same kind, take a
  folded name back out, or answer a card as a person or project Nocheh already
  knows. Folding and splitting change only the waiting list. They are plain
  revision-checked transactions, not owner commands, so they start no memory
  refresh. A repeated request returns the same result.
- Every fold or split changes the card's revision, so an answer given before
  a name joined cannot cover it. The owner answers only on the card. A
  folded name cannot be answered on its own. One answer covers every name:
  Remember adds a confirmed mention for each name shown on the card to one
  entity, and Dismiss dismisses them all.
- Export and restore carry which card each folded name waits on.
- Learning finds a confirmed project by any of its confirmed names, not only
  its project name. A name shared by more than one project finds none of them.
  A project suggestion whose name matches a known project is dropped, as known
  people already are.
- A project's memory entity has one ID however it was made, so a confirmed
  card and later learning share it.

</decision>

<consequences>

- The Waiting list shows one item per person or project with "Also called"
  names, and project cards say they are projects.
- Folding is reversible until the card is answered. A wrong `same_as` costs
  the owner one "Not the same" tap. It never links an identity on its own.
- Cards from other chats are not shown to learning, so a repeat across chats
  still needs a manual fold.
- Cards made before this change keep their separate rows until folded by hand.

</consequences>
