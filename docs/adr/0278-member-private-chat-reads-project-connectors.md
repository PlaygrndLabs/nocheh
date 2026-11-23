# ADR-0278: A member's private chat reads its projects' connectors

<status>
Accepted on 2026-11-23. The owner asked on 2026-11-23 that a member's private chat and
their schedules work by project, to cover connectors, and that a group in no project, or
in a project that does not share its group chats, keep working by group. Closes the
known gaps of [ADR-0268](0268-notion-per-project-or-person.md) and
[ADR-0270](0270-github-live-lookups.md) ("a member's private chat can't use a
project's Notion or look up its repositories yet"). Amends
[ADR-0262](0262-member-private-chat.md), whose private chat ran no outside tool.
</status>

## Context

A member's private chat reads that chat and the groups they joined, and, while a project
shares its group chats, that project's other groups ([ADR-0267](0267-share-group-chats.md)).
A group of a project uses that project's Notion and GitHub. The member's private chat
did not: it could read a group's talk about a page or a file but not the page or the
file. Members can't approve cards, and the owner should not get cards for a member's
private questions.

## Decision

1. **Which projects.** Every active project that holds a group the member's private chat
   reads now (`memberChatProjects`: the groups `memberReads` gives, fresh, not switched
   off, not left), whether or not that project shares its group chats. Sharing decides
   only which groups' talk is read. A group in no project brings no connector.
2. **What.** That project's Notion, while it is on, and the GitHub repositories linked to
   it. Never the owner's own Notion, GitHub or Gmail, and never another project's
   (403 `notion_owner_private_only`, `notion_not_here`, `github_not_here`).
3. **Reads only, no card.** The member's turn may ask (`POST /v1/tools/propose`) only a
   controlled `mcp` operation on Notion or GitHub. It runs only when it needs no card: a
   GitHub lookup in a live turn, or a Notion read the project's setting lets run (Notion's
   known read tools on that Notion's own pages, or its list of tools). Anything that would
   ask, a change, a read of an outside address or a read while the setting is "everything
   asks", is refused with `member_private_read_only` and nothing of it is kept. Every other
   effect stays refused as before.
4. **Checked again before it runs.** `notionRunRefusal` and `githubRunRefusal` run a member
   chat's operation only while that chat is still an open member private chat, still
   reading a group of that active project, and, for Notion, only a read.
5. **The surface.** The member's routes add `GET /v1/notion/connections`,
   `GET /v1/github/repos`, `POST /v1/tools/propose` and `GET /v1/tools/actions/<id>`; its
   MCP tools and Hermes's member tool set add `notion`, `github` and `action_status`. A
   member chat never gets a follow-up turn ([ADR-0212](0212-approved-operations-answer-in-the-chat-that-asked.md)),
   so a lookup's answer is read in the turn that asked.

## Consequences

- A member sees, through Nocheh, what anyone in that project's groups can already have
  Nocheh read there.
- The owner's Notion setting for a project ("reads run" or "everything asks") also
  decides whether its members can read it from their private chats.
- Schedules run with no live turn; whether a schedule's run may read connectors is
  decided apart.
- Checks: `test/store-member-connectors.test.ts`, `test/member-bound-readers.test.ts`,
  `services/hermes/test_member_private.py`.
