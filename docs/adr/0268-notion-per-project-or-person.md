# ADR-0268: Notion connections owned by a project or by the owner

<status>
Accepted on 2026-11-21, as step 2 of the shared and private connectors plan. The
owner decided, on 2026-11-20: a service connects to a project (shared by its groups)
or to a person (private, used only in that person's private chat and schedules);
groups have no connectors; only the owner adds a project's connection; the owner's
current Notion becomes the owner's own connection, and a project can have its own
Notion. Amends [ADR-0175](0175-notion-through-its-mcp-server.md) (Notion only from
the owner's private chat) for a project's Notion. Keeps
[ADR-0203](0203-owner-approved-jobs-read-notion.md) (jobs read the owner's own
Notion) and [ADR-0267](0267-share-group-chats.md).
</status>

## Context

Notion was one owner setting (`owner_notion`) with one sign-in, used only in the
owner's private chat and in jobs approved there. The owner wants a project, such as
one company, to have its own Notion that the project's groups can use, kept apart
from the owner's own and from every other project's.

## Decision

1. **One table of connections.** `connections` in the control store replaces
   `owner_notion`, which is dropped (development mode). Rows are `notion:own`
   (seeded, off) and `notion:project:<project id>`, each with its own switch,
   approval and revision. A project's row is made on its first save.
2. **Its own sign-in.** The management service keeps a project's sign-in in
   `notion-project-<project id>.json`, apart from the owner's `notion.json`. The
   dashboard's Notion routes take `?project=`, and the sign-in return remembers which
   connection it was for.
3. **Where it is used.** The owner's own: the owner's private chat and jobs approved
   there, as before. A project's: that project's groups and topics, and the owner's
   private chat when the call names the project. Never another project's group, a
   group in no project, an archived project or a job (`assertNotionHere`). A group
   call that names no connection uses its group's project.
4. **Approval.** A project's Notion offers "reads run, changes ask" (default) or
   "everything asks", never "nothing asks" (400 `invalid_notion_settings`), because
   anyone in its groups can ask. Its authority is `notion_setting:<project>:<rev>`.
   Cards for a project's call go to the owner.
5. **Checked again right before it runs.** `notionRunRefusal` refuses when that
   connection is off (`notion_not_enabled`) or when the call no longer comes from a
   group of that active project or the owner's private chat (`notion_not_here`).
6. **The tool.** Nocheh's `notion` tool gains `operation=connections`, which lists
   the connections usable in this chat (`GET /v1/notion/connections`), and an optional
   `connection` (`own` or a project id) on list and call.
7. **Dashboard.** Settings › Connections keeps the owner's own Notion. Each project's
   drawer in Memory › Projects has a Notion card: sign in, switch, approval,
   disconnect. In the drawer each change saves at once, because the page's Save sits
   behind it.
8. **Portability and reset.** An export carries `connections` (keyed by id, seeded).
   A former `owner_notion` record restores as `notion:own`. The reset baseline allows
   the seeded row.

## Consequences

- The existing Notion setting is dropped: the sign-in file is kept, and the owner
  turns the owner's own Notion on once again.
- Known gaps, accepted for now: a member's private chat can't use a project's Notion
  yet (members can't call tools there; step 5 of the plan); a card names "Project
  Notion" without the project's name (its details carry the id, its origin line the
  group).
- Checks: `test/store-notion-project.test.ts`, `test/store-notion.test.ts`, owner
  portability, reset setup, the MCP unit test, the Notion sign-in Python test and the
  dashboard browser test.
