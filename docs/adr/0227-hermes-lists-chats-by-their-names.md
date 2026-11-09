# ADR-0227: Hermes lists chats by their names

<status>
Accepted on 2026-11-09, after the owner opened the native Hermes dashboard and
asked what its profile list and its "Untitled session" rows were, then said the
naming was not clear and agreed to fix it. Extends
[ADR-0163](0163-chat-conversation-carries-into-new-guard-epochs.md) and
[ADR-0168](0168-superseded-epoch-profiles-are-removed.md), which matched a
chat's profiles by an exact logical profile.
</status>

<context>
The native dashboard's profile selector showed `default` and
`this dashboard (nocheh-…)` for the same owner profile, one `nocheh-<hash>`
entry per group, and an amber "Managing profile" warning although nothing else
was selected. Hermes injects its own home's name, `default`, as the page's
profile; Nocheh's catalog named the same profile by its hash. The Sessions list
showed one empty "Untitled session" for each memory review and titled the
Telegram conversation with its first message and archive source tag.

Opening a chat in the dashboard also prepared that chat's profile with its
logical profile written out, while Telegram turns leave it blank. Carrying and
removing copies compared the two exactly, so a chat opened in the dashboard
before its next Telegram message started its new guard epoch with no
conversation, and its earlier copies were never removed.
</context>

<decision>
- The catalog lists the owner's private chat as `private-chat` and each allowed
  group as `group-<name>-<code>`: the name is its Telegram title in lower-case
  Latin letters, digits, `-` and `_` (at most 32), else its public username,
  else left out; the code is the first six hex characters of its chat ID's
  hash, lengthened to 12 or 24 only when two groups share six. Every group name
  ends with its own chat's code, so a renamed group never takes over another
  group's name. Hermes's own `display_name` carries the full title, and the
  group's description names it. The name is only how the dashboard finds a
  profile: the logical profile (`nocheh-<hash>`) stays the chat link, Nocheh's
  own lookups such as scheduled jobs use it, and lookups by it and by the
  native profile still work. Owner-made profiles may not be named
  `private-chat` or start with `group-`.
- The native page names no profile of its own, so unnamed requests reach the
  owner's private chat as before and the selector shows it once.
- Hermes no longer titles a Telegram session after its first message (its
  untitled-platform list gains `telegram`, as it has `cron`); browser and job
  sessions keep Hermes's titles. After a Telegram turn the session gets its
  chat's name: `Private chat`, the group's title, or the group and topic. It is
  written at Hermes's top automatic rank, so it replaces a first-message title,
  stays once set, and gives way only to a title set by hand. A name already
  used takes Hermes's next number.
- A memory review marks its empty native session hidden with Hermes's own
  hidden flag.
- Carrying and removing copies treat a chat's own profile as the same whether
  a turn named it or left it blank. Named owner profiles stay separate.
</decision>

<consequences>
- The selector, its warning, Profiles and Sessions say which chat each entry
  is. A group whose title has no Latin letters is listed by username or code
  alone; its full title shows on Profiles and in the Chat page context line.
- A renamed group changes its listed name at the next listing; a bookmarked
  dashboard address with the old name stops finding it, and never finds
  another group.
- A Telegram session keeps the chat name it got first; a group renamed later
  keeps its earlier session title. No title model call is made for Telegram
  sessions.
- Opening a chat in the dashboard no longer drops its conversation at the next
  guard epoch, and its superseded copies are removed again.
</consequences>
