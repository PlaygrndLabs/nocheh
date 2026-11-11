# ADR-0233: Data tools over MCP

<status>
Accepted on 2026-11-10, as step 5 of the build that makes the brain and the
memory engine swappable, after the owner said "start build." Extends the scoped
turn processes of [ADR-0021](0021-scoped-native-assistant-processes.md), the
controlled execution of [ADR-0029](0029-controlled-tool-execution.md), the
security service of [ADR-0037](0037-external-security-plugin-service.md) and the
owner export of [ADR-0230](0230-portable-export-carries-owner-work.md).
Replaces the Nocheh plugin's own Hermes tools and the shell, browser and MCP
switches kept in each Hermes profile. Every route, check and approval behind the
tools is unchanged.
</status>

<context>
- Nocheh's data tools (archive, memory recall and search, tasks, Notion, message
  and operation requests, background jobs, knowledge proposals) were Python tools
  inside the Hermes plugin. Each called a Nocheh `/v1` route with the turn's own
  pass. Only Hermes could use them.
- The brain is to be swappable, one at a time. MCP is the tool interface brains
  already speak, and Hermes has a native MCP client.
- Hermes names an MCP tool `mcp__<server>__<tool>`, stops using a server for a
  minute after three failed calls, and checks a server with a plain HTTP request
  first, which the Hermes request boundary blocks.
- The per-chat switches for commands, web pages and outside tools lived in Hermes
  profile preferences. Nocheh could not check them itself, a schedule kept its own
  copy, and another brain would not see them.
- The official TypeScript MCP library adds about 80 packages, mostly for sessions
  and event streams Nocheh does not need.
</context>

<decision>
- Nocheh serves `/mcp`: one JSON-RPC message per POST, a JSON answer, no session
  and no request from the server to the client. It speaks revisions 2025-11-25,
  2025-06-18 and 2025-03-26 and answers `initialize`, `ping`, `tools/list` and
  `tools/call`; a notification gets 202, and GET or DELETE gets 405. It is
  written in `src/mcp`, without the MCP library.
- A tool call still running after 20 seconds, such as a long memory recall, is
  answered as an event stream when the client takes one: a comment line every 20
  seconds, then the answer as one message. Hermes stops reading a silent answer
  after 300 seconds, and a recall may take up to ten minutes.
- The broker serves it for isolated turns, and `nocheh-app` for turns without the
  isolated runtime. Only a turn's own pass reaches it: the service token is
  refused (`turn_credential_required`), and so is any request with an `Origin`
  header.
- Each tool calls the same service's existing `/v1` route again, on the port the
  request came in on, with the caller's pass. Every check stays where it was:
  audience, epochs, effect policy, the secret check, the owner-private check and
  the job box and the machine checks of
  [ADR-0231](0231-owner-approved-jobs-work-on-the-owners-machines-over-ssh.md).
  `/mcp` itself grants nothing. As before, a job's `box` or `machine` is
  refused before any call when the turn is not in the isolated runtime.
- There are 18 tools with the arguments and answers the plugin tools had, the
  same error codes, bounds and parts. The MCP server is named `nocheh`, and a tool
  is named without the old `nocheh_` prefix, so the brain sees
  `mcp__nocheh__archive_search` where it saw `nocheh_archive_search`. Tool texts
  refer to each other by those names. The memory tools name no memory engine; the
  memory routes they call sit in one map in `src/mcp/tools.ts`.
- A refused or failed tool call is a normal answer, not an MCP error: its text is
  a JSON object such as `{"error":"tool_disabled_by_owner"}`, as before. So a
  refusal never trips the brain's failure limit.
- The turn process may send its deadline in `X-Nocheh-Turn-Deadline` (epoch
  seconds). It only shortens a long memory recall, leaving 45 seconds for the
  reply. A value already past leaves no time for a recall; a value more than an
  hour ahead is ignored. The tool's own call back to the route has no read limit
  but that budget.
- A turn's pass names its brain in a `brain` claim, `hermes` by default; only a
  turn pass may carry one. The broker records it on each effect in
  `security_events.brain`.
- Hermes connects to the `nocheh` server inside each turn process, with the turn's
  pass and deadline as fixed headers, the preliminary check skipped, sampling and
  elicitation off and no resources or prompts. Its toolset `mcp-nocheh` replaces
  `nocheh_archive`, and Hermes's tool search stays off. A turn that does not get all
  18 tools stops before the model with `data_tools_unavailable`, and one that is
  offered any other tool stops with `unexpected_profile_tool`. The turn keeps the
  tools it was given: Hermes's tool refresh at the start of a turn is skipped, as
  Hermes does for its own background review. The connection closes when the turn
  ends. The Hermes image includes its `mcp` extra.
- The switches move to Nocheh, in `chat_tool_settings`: one row for every chat
  (`*`), a chat, or a topic, each with `shell`, `browser` and `mcp` on, off or
  inherited, and its own revision. A tool's value comes from the topic, then its
  chat, then every chat, then on. The owner's private chat and its topics are one
  chat. `mcp` also covers Notion. `POST /v1/tools/propose` refuses with
  `tool_disabled_by_owner` before the secret check, and the executor's claim
  checks again. The owner reads and saves them with `GET` and `POST
  /v1/chat-tools`; the dashboard shows them on a chat's page in Chats and, for
  every chat, in Settings › Assistant. Scheduled runs and background jobs follow
  their chat; a schedule has no switches of its own.
- In development mode the old values are not carried over, so every tool starts
  on. A value saved for one chat in Hermes is ignored; set it again in Chats. A
  value saved for every chat in Hermes's shared settings stops turns
  (`unsupported_preference`) until it is removed once.
- The endpoint takes only a pass that names its turn, and a fraction of a second
  in `X-Nocheh-Turn-Deadline` is dropped. An import takes only a real `false` as
  off and starts each imported row's revision at 1.
- The owner export carries `chat_tool_settings` with the owner's other settings
  ([ADR-0230](0230-portable-export-carries-owner-work.md)). A switch that was on
  arrives inherited, so an import never turns a tool on.
</decision>

<consequences>
- Another brain with an MCP client can use the same tools and checks; it needs a
  pass and its own way to connect.
- A tool call makes one more local HTTP request, on its own connection, and
  connecting adds about a second to the start of a turn, most of it loading
  Hermes's MCP library.
- The hops behind the tools no longer use Node's `fetch`, which stops waiting
  for an answer's first byte after 300 seconds: the loop-back uses `node:http`,
  and the broker's relay and the Honcho client use `longFetch`. Hermes stops one
  tool call after 420 seconds unless the tool asks for more, so the connection
  asks 660 seconds for every Nocheh tool; each route still keeps its own limit.
- Hermes hands each answer to the model wrapped as `{"result": "<text>"}`, so the
  model reads the same JSON as before inside one more string. Answering with
  structured content only would avoid that in Hermes, but a brain that reads only
  text would then see nothing.
- Hermes also frames every MCP tool's answer of 32 characters or more as
  untrusted data: the model is told to treat it as data, not instructions. The
  plugin tools' answers had no such frame. It fits what the tools return, which is
  mostly what other people wrote, and Hermes has no setting to leave it out. The
  scripted model fixture reads the tool's text inside the frame.
- The broker now also relays this chat's action list (`GET /v1/tools/actions`) and
  passes `tool_disabled_by_owner` back from a proposal; other refusals stay opaque.
- Prompts, the scripted model fixture and the acceptance scenarios name tools by
  their new names. The Python tool tests moved to `test/mcp.test.ts`.
- Hermes's own apps, such as its dashboard chat, still have no pass and reach no
  Nocheh data.
</consequences>

<alternatives>
- The official MCP library: about 80 packages for sessions and event streams that
  stateless calls do not use.
- A separate MCP service, or the broker forwarding `/mcp` to `nocheh-app`: one
  more service, or tool calls that skip the broker's own effect checks.
- Keeping the plugin tools beside the MCP tools: two copies of every tool to keep
  the same.
- Keeping the switches in Hermes profiles: Nocheh could not check them on every
  call, and a different brain would lose them.
</alternatives>
