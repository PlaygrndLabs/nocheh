# ADR-0240: Honcho runs only the tools it offered

<status>
Accepted on 2026-11-12. A design review of members asked whether what the owner
says in their private chat could come back in a group: Honcho might keep a
conclusion under a group's session that it learned from the private chat, and
group reads filter only by session. The request was to check Honcho's own
source, fix a real leak so group turns see only that group's memory and facts
the owner chose to share, and add a canary test that proves private text never
shows up in a group's memory reads.
Builds on [ADR-0109](0109-standard-honcho-entity-model.md),
[ADR-0115](0115-honcho-session-revisions.md) and
[ADR-0225](0225-member-safety-rules.md); keeps
[ADR-0020](0020-mandatory-outgoing-request-guard.md)'s gateway as Honcho's only
way to a model.
</status>

<context>
- A check of the pinned Honcho source (v3.6.0) with Nocheh's settings (peer
  cards and dreams off) found no conclusion kept under one session but learned
  from another. Each learning batch reads one session's messages and nothing
  else, its conclusions carry that session, and duplicates are merged only
  within a session. Summaries read only their own session.
- Every read a group turn makes is held to the group's sessions: a recall or
  learning question asks the person's peer with `filters.session_id`; the
  start-of-turn context asks with `limit_to_session=true`; search filters by
  session. Under a session filter, Honcho's memory chat reads only conclusions
  of those sessions, its message tools search only those sessions, and it drops
  the tools that cannot be held to them. Honcho's own tests cover this
  (`tests/test_session_allowlist.py`).
- One gap is real. Honcho's memory chat runs any of its tools the model names,
  offered or not; only its last answer step checks the name. One tool it never
  offers under a session filter, `get_recent_observations`, reads the person's
  newest conclusions from every session, the owner's private chat included.
  The same path reaches tools that write or delete conclusions. A model names
  such a tool only by mistake or after a planted instruction, for example a
  group message telling it to.
</context>

<decision>
- Nocheh's Honcho gateway (`services/honcho/meter.py`) reads each model answer
  before Honcho sees it. An answer that calls a tool its request did not offer,
  in a whole reply or a stream, or that cannot be read, is refused with a 502
  and logged as `honcho_unoffered_tool_refused` with the tool names only (a
  name outside `[A-Za-z0-9_.-]` is logged as `other`). Honcho asks again, and
  an answer that keeps naming one fails that memory read, which a reply sees as
  limited memory. The provider answered, so the call is still counted and paid.
- Honcho itself is not changed.
- The full tester gains `private_chat_stays_out_of_groups`. The owner says a
  private mark in their private chat, which the fixture's Honcho learning keeps
  as a conclusion. The owner then asks about it in a group, and the fixture
  model answers Honcho's memory chat for that question by calling
  `get_recent_observations`. The scenario passes only when the gateway refused
  that call, no model request held the private mark next to the group question,
  and neither the recall result nor the reply holds the mark.
</decision>

<consequences>
- A group's memory reads keep to the group's sessions even when the model names
  a tool Honcho should not have run there. The check also stops a model from
  writing or deleting conclusions through a tool it was not offered.
- An answer that names an unoffered tool costs one more model call when Honcho
  asks again.
- The protection holds while peer cards and dreams stay off, group context
  reads keep `limit_to_session=true`, session filters never hold `*`, and
  Honcho keeps its vectors in PostgreSQL.
- Sharing rules, grants and suggestions the owner makes still move facts between
  chats on purpose; they are owner decisions, not part of this check.
</consequences>
