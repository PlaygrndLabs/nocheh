# ADR-0171: Notion through its MCP server

<status>
Accepted on 2026-10-26. The owner asked "how can connect Notion (use MCP)?",
and the coordinator asked for the optional Notion connector that ADR-0160
planned: off by default, with Nocheh's own task list staying the main one.
The owner was asked which Notion calls should ask first; the recommended
choice, reads run and changes ask, is the default, and Settings offers all three.
</status>

<context>
Notion's hosted MCP server at `https://mcp.notion.com/mcp` signs in with OAuth
(PKCE, a dynamically registered public client) on any plan. On a Business plan
a workspace owner can create an MCP token instead. Access tokens last about
eight hours, and each refresh returns a new refresh token that must be saved
before it is used. Nocheh's existing MCP tool sends no credentials and runs
only after the owner approves the exact call.
</context>

<decision>
- Settings › Connections › Notion signs in. The dashboard asks the management
  service for a sign-in address, Notion returns the browser to
  `<dashboard>/?connect=notion`, and the dashboard hands the code back. An MCP
  token can be pasted instead and is checked before it is saved. The sign-in
  is kept in `admin/connections/notion.json` (mode 600) with the other keys.
  Only the management and executor services read it, and no view returns it.
- Refreshes run under one lock. A refused refresh (`invalid_grant`) forgets the
  tokens and shows "Sign in again"; it is never retried.
- Whether Notion is on, and which calls ask first, live in the control store
  (`owner_notion`). The choices are: reads run and changes ask (the default),
  everything asks, or nothing asks. For Notion this choice replaces the owner
  freedom setting, and deny rules still win.
- The assistant's `nocheh_notion` tool proposes a controlled `mcp` action whose
  arguments name the `notion` connection instead of an address. Only the
  owner's own private chat can propose one, and only while Notion is on.
  Searches, fetches and `get`, `list` and `query` tools count as reads; any
  other tool is a change. An allowed call runs at once, and the tool waits up
  to a minute for its answer.
- The executor adds the owner's bearer token only for the Notion connection.
  It accepts Notion's streamed replies and its protocol versions, and reports
  a missing or refused sign-in as a failed call that sent nothing. A call
  approved before Notion was turned off is blocked when it would run.
</decision>

<consequences>
- Notion pages Nocheh reads come back through the same secret check as other
  tool results. What Nocheh can see is what the owner shared during sign-in.
- Group chats, project chats and scheduled jobs never reach Notion.
- Syncing Nocheh's tasks into a Notion database is not part of this; the
  task's `external` slot (ADR-0167) is kept for it.
</consequences>
