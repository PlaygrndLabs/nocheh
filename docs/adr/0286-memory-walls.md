# ADR-0286: Memory walls (Honcho named scopes)

<status>
Accepted on 2026-11-23. The owner approved the design ("Memory walls with named
scopes") after a cloud proof against Honcho 3.6.2. Members' private chats keep plain
search with no learned notes (the owner's choice), and that search goes through a wall too.
Learning from project connectors is a later step.
Builds on [ADR-0241](0241-honcho-runs-only-the-tools-it-offered.md) and
[ADR-0267](0267-share-group-chats.md).
</status>

## Context

A group's memory read sent Honcho a list of the sessions it may use, and Honcho trusted
the list. Its model could still reach other sessions through tools the request did not
offer; the gateway refusing those tools (ADR-0241) was the only wall. A cloud proof
showed that with that guard off, a group's chat read text from the owner's private chat.
The list also stopped at 1,000 sessions.

Honcho 3.6.2 has named scopes. A scope is a peer, `scope.<id>`, that observes the
sessions added to it. A chat naming one scope answers as that peer, so every tool,
offered or not, stays inside it. A scope key (an HS256 JWT with `w`, `sc` and audience
`honcho:named-scope`) opens that one scope and nothing else: Honcho refuses it on
workspace search, fact lists, peer cards and context, and on other scopes.

## Decision

1. **A wall is a scope named by its chats.** `memoryWallName(workspace, chats)` is
   `wall-` and the first 40 hex digits of a digest of the workspace and the sorted
   chat ids. The same chats always make the same wall. Any change of the chats a reader
   reads (sharing on or off, a group joining or leaving a project, a new topic) makes
   another wall, built from scratch. A wall never loses a chat while in use, so Honcho's
   asynchronous removal can never leak.
2. **Only groups and topics are in walls.** The owner's private chat, the owner's
   forwards and files, and every private chat are never in one, so no wall key opens them.
3. **What goes through a wall.** A group or topic turn's recall (`memory_recall`), its
   search by meaning and its background learning ask read through the wall of the chats
   its recall reads: its own conversation, its group with every topic, or every group of
   its project while the project shares its group chats. The chat uses the wall's own
   key (ten minutes); search uses the main key with the wall's name. A bound reader's
   search (a member's private chat and its schedules, a private answer) goes through the
   wall of its read set's groups; it still gets no learned notes. The facts a recall
   lists are the wall's own copies (`observer_id` `scope.<wall>`), and a stored fact
   records its wall so it opens from the same place.
4. **Unchanged.** The owner's reads (main key, everything, the brief and every owner
   schedule included). A turn's session context (`limit_to_session`) and fact lists still
   go by session lists with Nocheh's re-check, and every search hit is still re-checked
   against its receipt. Sharing rules stay
   one-way approved copies. Nocheh keeps the gateway tool guard and its hit re-checks as
   a second layer.
5. **Keeping walls whole.** `memory_walls(workspace, wall, chats, members, ready)` records
   each wall. Opening one adds any learned session (a write done and not retired) it
   lacks, then waits up to 20 s for Honcho to copy what those sessions already learned
   (`GET /scopes/{id}/status`). The copy needs no model. A wall not ready in time refuses
   the read (`memory_wall_syncing`); a failed copy says so (`memory_wall_copy_failed`).
   A new session joins every wall holding its chat when it is opened, before its first
   write, so what it learns reaches those walls as it is learned.
6. **Auth is on.** Honcho runs with `AUTH_USE_AUTH=true` and `AUTH_JWT_SECRET` set to the
   installation's internal token, which Nocheh already holds as `NOCHEH_MEMORY_TOKEN`.
   Nocheh's main key and the CLI's key are admin JWTs signed with it.

## Consequences

- Each new message is still read by Honcho's model once; it saves what it learns to
  every observer, walls included. Embeddings repeat per wall, a small cost.
- A message learned in the moment its session joins a wall can miss that wall. This
  edge is accepted: the next learning of that session reaches it.
- Engines without walls (no `openWall`) keep the session lists, as before.
- Checks: `test/memory-engine.test.ts`, `test/store-memory-walls.test.ts`,
  `test/store-native-memory.test.ts`, `test/fact-opening.test.ts`,
  `test/store-fact-opening.test.ts`, `test/store-learning-engine.test.ts`,
  `services/honcho/test_setup.py` and `services/honcho/test_cli.py`.
