# ADR-0274: People names everywhere, and a private note per person

<status>
Accepted on 2026-11-22. The owner asked that the name set in Memory › People be the person's
name everywhere, because a Telegram name can be wrong, rude or anonymous, and asked for a private
note about each person that only the owner reads. Amends the People-name rule of
[ADR-0261](0261-recalled-facts-and-search-hits-name-their-source.md) and the members' app
assignee rule of [ADR-0265](0265-member-mini-app.md).
</status>

## Context

ADR-0261 showed a People name only in the owner's own chats, beside the name Telegram showed.
A memory review found the name already reached groups another way: memory records about a
person and the "[related through …]" header of a group's recall carry the person's People name.
The owner chose to make that the rule instead of hiding it: the People name is the name everyone
reads. Anything the owner wants kept private about a person goes in a separate note.

## Decision

1. **The People name is the person's name everywhere.** When the owner set it (`ownerChosenName`:
   a rename, a merge or a confirmed card; never a name Nocheh gave by itself or the automatic
   `telegram actor …` name):
   - Groups, topics, private answers and members read it in source tags in place of the Telegram
     name, the @username beside it as before. The owner still reads `“Bob”, saved as “Brother”`.
     A Desktop export's own names stay hidden from everyone but the owner; a People name shows.
   - Reminder lines, note sources and the owner's member asks name people by it
     (`peopleNames`).
   - The members' app names an assignee by it, under the same rule as before: only someone in a
     group the member reaches; anyone else is counted.
   - Memory records of the person's messages carry it as `sender_name`; the message's own
     Telegram name stays in its payload. Records written before the rename keep their form; no
     re-learning is asked.
   - `identityPeopleNames` and `accountPeopleNames` in `src/stores/entities.ts` are the one read.
2. **The owner's private note.** `memory_entity_notes` holds one note per active person, at
   most 4,000 characters, with its own revision so the person's revision is untouched. Only the
   owner writes it (`POST /v1/entities/:id/note`, empty clears it), and writing it moves no guard
   epoch and asks no memory refresh. It is read only:
   - on the dashboard's People page;
   - by the owner's own `owner_read` view of people;
   - in the owner's own recall (no scope, not bound to a member), under
     `[the owner's private note about <name>: …]`, for the people the question names, together at
     most 4,000 characters.
   It is never sent to the memory engine and never read by a group, a topic, a member or a
   private answer. The stored owner command keeps no note text. The derivative export carries it.
3. **The People page says so.** The name field says everyone sees it. A person whose name the
   owner set shows a "Shown" badge. A notice, dismissed once per browser, lists those names so
   the owner can check none is private.

## Consequences

- A name the owner meant as private, such as a nickname, is now shown in groups. The notice
  lists them once so the owner can move them into the note.
- One more read per tag batch and per memory record of a person's message.
- Development mode: the table is added at startup; no data is moved.
