# ADR-0195: The agent reads a chat in order and searches by meaning

<status>
Accepted on 2026-10-29 as part 3 of the chat-review build the owner approved
("I all thing is ready start build."). The plan the owner accepted lists "Read a
chat in order" as a small Nocheh tool and Honcho search by meaning as an extra
tool for learned chats. Extends
[ADR-0021](0021-scoped-native-assistant-processes.md) and
[ADR-0191](0191-imports-share-secret-checks-and-become-ready.md).
</status>

<context>
- The agent's archive search returns at most ten messages in which every query
  word appears. A request such as "summarize last week" or "go through this
  chat" found only scattered messages, so its answer was short and incomplete.
- Honcho, which Nocheh pins, already searches its messages by meaning and by
  words together. Nocheh used only Honcho's answers about people and projects,
  not that search.
</context>

<decision>
- `nocheh_archive_page` reads one chat oldest first, up to 50 records a page
  and about 30,000 characters: messages, edits, reactions, Nocheh's replies and
  service messages, with the text of their files and voice notes. Button presses
  and member changes are left out.
- Order is the time Telegram gave each message; a reply Nocheh sent has only the
  time it was saved. A page ends with the last record's time and id, so the next
  page never repeats or skips one. `from` and `to` bound the times read. Each
  page says how many of the chat's records are read through and the total.
- Each record is read through the same access check and secret-check copy as an
  archive read. A record still being checked shows that, without text. An
  imported copy of a message also captured live appears once. Only the owner may
  name another chat; anyone else reads the chat they are in.
- `nocheh_memory_search` asks Honcho's workspace search within the sessions the
  audience may read, after the question passes the secret check as a recall
  question does. Only the archived messages behind each hit's own receipt leave
  that step, and the agent gets them back through the archive's access check,
  never Honcho's copy. A chat that was not learned returns nothing and says so.
</decision>

<consequences>
- The agent can go through a period or a whole chat for ordinary replies, and
  report how far it got. A very large chat still takes many pages, so the
  background jobs of the next part do that work outside a reply.
- Search by meaning helps only in learned chats; exact-word search stays the
  default for everything else.
- Nothing new is stored: both tools read what the archive and Honcho already
  hold.
</consequences>
