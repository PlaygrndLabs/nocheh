# Nocheh implementation status

<current>

Notion per project or owner, step 2 of the shared and private connectors plan (owner,
2026-11-20: a service connects to a project or a person; the owner's Notion becomes the
owner's own) ([ADR-0268](docs/adr/0268-notion-per-project-or-person.md)).
- `connections` replaces `owner_notion`; the owner turns the owner's own Notion on once again.
- Memory › Projects: each project's drawer has a Notion card with its own sign-in, switch and
  approval (no "nothing asks"). Used in that project's groups and the owner's private chat,
  never another project's group, a group in no project or a job.
- The `notion` tool lists usable connections; each call names one.
- Checks: [store](test/store-notion-project.test.ts), Notion store, portability, reset setup,
  MCP, Notion sign-in Python test, dashboard browser.
- Next: step 3, GitHub per project. A member's private chat gets a project's Notion in step 5.

Tasks, Chats, Members and Assistant notes as tables and sub-tabs, step 5 part 2 and the last step
of the table-first dashboard plan (owner, 2026-11-19: "avoid scrolling as much as possible and use
tables instead, everywhere"; 2026-11-20: "yes to all").
- These pages now fit one 1600x900 screen: Tasks (was 1.2 screens; its board 1.5), Chats ›
  Sharing (1.2), an open chat, an open member (1.8), Memory › Assistant notes (1.1).
- Tasks: the list is a table of ten a page (task, status, priority, due, list), eight under day
  lines in Today and Upcoming; a new task answers with a toast, as it may be on another page.
  The board shows four cards a column at a time. Cards stay a choice.
- Chats and Members: a full-width table; a chat or a member opens in its place with the way back
  and a choice of any other one. An open chat's cards sit side by side; an open member has three
  sub-tabs. Sharing: rules table and a Defaults sub-tab (`tab=defaults`). Assistant notes: three
  sub-tabs.
- Layout only: no setting, rule or stored data changed.
- Checks: browser (`test/dashboard-pages.browser.mjs`), dashboard unit tests.

Remaining pages as tables and sub-tabs, step 5 part 1 of the table-first dashboard plan (owner,
2026-11-19: "avoid scrolling as much as possible and use tables instead, everywhere";
2026-11-20: "yes to all").
- These pages now fit one 1600x900 screen: Usage (was 2.6 screens), Settings › Telegram (1.9),
  Tasks (1.4), Models (1.3), Connections (1.2), Machines and Privacy & data, Messages (1.4),
  Inbox › History (1.4), Home (1.2), Memory › Long-term memory (1.6).
- Usage: four sub-tabs; recent replies are a table, ten a page. Settings: sub-tabs inside
  Telegram, Models, Privacy & data, Tasks and Connections; Machines and providers are tables;
  a sub-tab with an unsaved setting is marked. A returning GitHub sign-in opens `tab=github`.
- Messages: a table of ten a page with the reply in its own column (`limit` on the message
  list, 1 to 50; the page ends on the tenth message shown, and the next page starts after it).
  Inbox › History: three sub-tabs of tables. Home: attention and set-up steps side by side.
  Long-term memory: three sub-tabs; `chat=` and `about=` links open the facts.
- Layout only: no setting, rule or stored data changed.
- Checks: browser (`test/dashboard-pages.browser.mjs`), [unit](test/store-member-messages.test.ts).

"Share group chats", step 1 of the shared and private connectors plan (owner, 2026-11-20: a
project switch to freely share group data between the project's groups, on by default, for
existing projects too) ([ADR-0267](docs/adr/0267-share-group-chats.md)).
- `projects.share_chats` (default on); the owner's project save takes it. Memory › Projects:
  a "Share group chats" switch with the risk line and a badge; the join notes follow it.
- While on, every group or topic turn of the project, and a member's private chat for a group
  they joined, reads all of the project's served groups: bound on the server per request
  (`bindReads`, `sharedProjectGroups`), never from the pass. Off, each group reads itself and
  Answer privately comes back.
- Checks: [store](test/store-shared-project-chats.test.ts), owner API, private answers,
  projects, dashboard browser; full tester `project_groups_stay_apart` gains the on step (not
  run in cloud this time).

System pages as tables and sub-tabs, step 4 of the table-first dashboard plan (owner,
2026-11-19: "avoid scrolling as much as possible and use tables instead, everywhere";
2026-11-20: "yes to all", which took charts on their own sub-tab so the first screen is tables).
- Every System page fits one 1600x900 screen (Background work was 4.4 screens, Databases 2.3,
  Health 1.9). A sub-tab here shows only its own panel: nothing on these pages is edited, and
  charts can't draw while hidden.
- Health: status (issues as a table), services and connections, storage (databases, local
  folders, largest tables), diagnostics (latest Telegram messages, ten a page).
- Background work: jobs (table, ten a page; a row opens a drawer with the plan, the to-do list
  and the machine-log link), tasks (ten a page, with "Right now" and "Why work is waiting" as
  small tables beside it), history (the four charts, two by two). Links to failed or uncertain
  tasks open `tab=tasks`.
- Backups: actions as one table (`ActionRow`, shared with Memory › Long-term memory) and
  history as a table, ten a page. Sent to apps and Machine log show ten a page. Databases shows
  twelve rows a page (`limit` on the database browser, 1 to 50).
- Checks: [unit](test/test_database_browser.py), [unit](test/dashboard-machines.test.mjs),
  browser (`test/dashboard-pages.browser.mjs`).

Sub-tabs for the two longest pages, step 3 of the table-first dashboard plan (owner,
2026-11-19: "avoid scrolling as much as possible and use tables instead, everywhere";
2026-11-20: "yes to all", which took sub-tabs for long settings pages).
- `SubTabs`/`SubPanel` (`dashboard/ui/page.tsx`) and `useSubTab` (`?tab=`): every panel stays
  mounted and hidden, so unsaved edits survive a switch and the top Save still sends them.
- Settings › Assistant: acting and role, tools and limits, background jobs, built-in
  instructions (was about 7 screens).
- A chat's page: access, role and skills, tools and limits, memory and project; the last tab
  carries a count while the group's project question is open (`useProjectUnanswered`).
- Skills are a table with a drawer per skill; built-in instructions are a table, 12 a page,
  with a search box and a drawer per text. A failed save opens the row it is about.
- Checks: browser (`test/dashboard-pages.browser.mjs`).

Memory pages as tables, step 2 of the table-first dashboard plan (owner, 2026-11-19: "avoid
scrolling as much as possible and use tables instead, everywhere"; 2026-11-20: "yes to all").
- Step 1 (merged): Assistant notes lists past conversations and working notes as tables; the
  "Untitled conversation" rows were each memory review's hidden, empty native session.
- Long-term memory: status and monthly limits are two tables side by side (limits change in a
  dialog); retry, re-learn and replace are one table of three actions, re-learn and replace
  opening a dialog that is the confirmation; facts are a table, ten a page over the server's
  25; the chat filter opens under its search box (`ChatPicker` `compact`).
- Facts and Projects (projects, automatic organizing, recent suggestions) are tables; People
  lists names side by side.
- Notes: the page shows a note's words without ids of Nocheh's own records (`noteWords`). The
  review instruction keeps the `nocheh:event:` ids, because a note's original-message links are
  read from them, and writes no other id.
- A notes review deletes its own empty native session when it ends (Hermes's
  `delete_session_if_empty`), and hides one that holds anything.
- Checks: [unit](services/hermes/test_native_memory.py), [unit](test/dashboard-memory-sources.test.mjs),
  browser (`test/dashboard-pages.browser.mjs`).

Members step 5: the members' app
([ADR-0265](docs/adr/0265-member-mini-app.md); owner, 2026-11-12, approving the Members design
with a members' mini app for tasks; 2026-11-19, the owner's answers to Q1-Q4): Q1 write includes
trash and restore, with no switch for other people's tasks;
Q2 the page in English only, with no language choice, bot texts stay editable English owner texts;
Q3 only members use the app, which follows **Tasks** even when private chat or **Reminders to
themselves** is off, **Remind me** is hidden with one line saying why, non-members get the closed
page, an app reminder that cannot reach its member is skipped
with a Health line, and a group reminder that cannot reach its member goes to the owner as before;
Q4 the owner's own names for people never reach a member or a group: in every project view an
assignee shows by their Telegram name only while linked to a Telegram account in a group the view
reaches, every other one counted as other people; "Made by" and "Finished by" only where the board
shows them, with Telegram names. One branch: a contract, five parts and their integration.
- Launch and listener: `verifyLaunchUser` (Ed25519 launch data, one hour, from the menu button or
  the member's own chat only), the member listener on nocheh-app's port 8790 alone (8780 answers
  404), its checks in order (no Bearer, launch, not the owner, member and app open, `app_since`,
  sign out, Telegram re-check of groups older than 6 hours, write mode, 60 task writes in 10 minutes and
  500 a UTC day), and the `miniapp-back` network
  ([launch](test/member-mini-app.test.ts), [listener](test/store-member-app-server.test.ts),
  [contract](test/member-app-contract.test.ts), [schema](test/store-member-app-schema.test.ts)).
- Tasks: one board per active project of the member's joined groups, reaching only those groups
  and shared with the private chat (`memberTaskViews`); no project view reads who a task is about,
  the owner's names for people or person columns, now also in groups, and assignees only by
  Telegram name (`assigneesSeen`); the page gets the board's statuses and shared columns; versions
  under a key stored in the control database refuse a stale change (409); refused fields, trash
  and restore, comments, `origin` 'app' ([store](test/store-member-app.test.ts),
  [groups](test/store-member-tasks.test.ts), [private chat](test/store-member-reads.test.ts)).
- Reminders: a reminder goes to whoever set it; a member's goes to their own private chat, with
  core's one-time yes (`/internal/notices/authorize`), "Set by you" and no place, after the app's
  group re-check and only with groups confirmed within 6 hours; one set in the
  app that cannot reach them is skipped with a `reminder_skipped` Health line
  ([store](test/store-member-reminders.test.ts), [text](test/task-reminder-text.test.ts),
  [gateway](services/telegram/test_service.py)).
- Menu button: Apply sets the members' page `/m/` as every private chat's default, then the
  owner's page on the owner's chat ([apply](services/hermes/test_settings.py),
  [installer](services/hermes/test_workspaces.py)).
- Page and dashboard: the `/m/` page (four tabs, English only from one dictionary, assignees as
  "Lena, Ravi and 2 other people", statuses and shared columns by the page's own `statuses` and
  `columns` in rows, the drawer, New task and Edit, sign out), Members'
  **Tasks** wording and **Reminders to themselves**, Settings' mini app addresses, the members'
  app origin on Tasks ([dashboard](test/dashboard-member-app.test.mjs),
  [pages](test/dashboard-pages.browser.mjs)).
- Tester: the fake Telegram signs launch data and records menu buttons, the mini app runs in the
  fixture, seven members' app scenarios and the `member_app_never_leaks` sweep
  ([fake](test/test_telegram_mock_members.py), [rehearsal](test/test_telegram_rehearsal.py),
  [sweep](test/test_canary_sweep.py), [scenarios](tools/acceptance/product_scenarios.py)).

  Checks on the integrated branch (2026-11-19): the build and type checks; node unit tests (855:
  585 pass, 266 skipped, and only the 4 workflow tests that also fail on main fail); all 118 store
  test files (312 pass, 0 fail); Python Telegram (159), Hermes (1049, with the 2 environment
  errors that also occur on main) and the repository's Python tests (192, 2 skipped, and
  `test_retired_source_leaves_tags` fails as on main); the dashboard type check, format check and
  its tests (77 of 77); the browser tests (81: 78 pass, and the 3 that also fail on main).
  After the owner's answers (2026-11-19): node unit tests (865: 592 pass, 269 skipped, the same 4
  workflow failures); the member, task and reset store test files (22 files, 59 pass); the
  repository's Python tests (198, 2 skipped); the dashboard checks and its tests (79 of 79); the
  browser tests (82: 79 pass, and the 3 that also fail on main).
  After the review fixes (2026-11-19): the build and type checks; node unit tests (865: 592 pass,
  269 skipped, the same 4 workflow failures); all 120 store test files (315 pass, 0 fail); Python
  Telegram (160), Hermes (1064, 4 skipped, the same 2 environment errors), the repository's Python
  tests (198, 2 skipped) and the review replay tool's (18); the dashboard checks and its tests (79
  of 79); the browser tests (85: 82 pass, and the 3 that also fail on main). The four changed store
  test files fail on the code before the fixes.
  After merging main 2ec967a (2026-11-20; this ADR renumbered from 0263 to 0265): the build;
  node unit tests (891: 616 pass, 271 skipped, the same 4 workflow failures); all 122 store test
  files (317 pass, 0 fail); Python Telegram (160), Hermes (1066, 4 skipped, the same 2
  environment errors), the repository's Python tests (199, 2 skipped) and the review replay
  tool's (18); the dashboard type check and its tests (92 of 92); the format check flags only
  main's `dashboard/pages/settings/connections.tsx`, as on main; the browser tests (94: 91
  pass, and the 3 that also fail on main).
  Full tester on images built from this branch (2026-11-20), every scenario in five parts plus
  the dashboard pages: all pass. Two scenarios of one part first failed only because that part
  ran without the `group_members` setup and passed with it; one tester fix came out of these runs
  (a `getChatMember` fault an earlier scenario never used answered the left-group check, so the
  fake Telegram now drops unused faults by method).
  Pending: the tester does not check the skipped reminder's Health line; live acceptance on the
  owner's install after merge, with a real member, the real menu button and a reminder set in the
  app.
  Left for later: a per-member time zone (C2) and a second menu button (C1) were cut.
  Owner steps: take a backup and rebuild and run every image from the same revision, then apply
  settings once so the menu buttons are set ([deploy](docs/deploy.md#upgrade-to-step-5)).

Security fixes part 5: only addresses no model built open without a card
([ADR-0263](docs/adr/0263-only-addresses-no-model-built-open-without-a-card.md); owner,
2026-11-14 "all yes" on the review's fixes 2 and 7 and the Notion item; 2026-11-19: any outside
tool may get Always allow, short input only).
- One check (`src/link-check.ts`) for "Do what I ask", chat rules, tool rules and Notion:
  `typed`, `forwarded` (≤2 links), `page` (8-character echo check on model-built pages) and
  `named` reads run without a card, at most 10 a message (5 from pages, rule-covered counted);
  other web addresses and every tool call ask; commands run as before.
- Site rules cover one file on shared or send-to sites; no rule covers an address carrying
  data; tool rules cover short input; each rule button's card says what it allows.
- Notion Nothing asks me: page tools only, outside reads only when given, changes only with
  plain or given links; `/image/` and `/signed/` are outside.
- Checks: [unit](test/link-check.test.ts), [store](test/store-link-check.test.ts),
  [Notion](test/store-notion.test.ts), [buttons](test/store-approval-buttons.test.ts).
  Full tester's tool scenarios pass in the cloud. Pending: a live reply after merge.

Memory step 4: the dashboard shows where messages and facts came from
([ADR-0261](docs/adr/0261-recalled-facts-and-search-hits-name-their-source.md) step 4;
owner, 2026-11-17: track the source of each fact before the MVP; built on the same three
recommended answers as steps 1 to 3). No Honcho code or setting changes and nothing is learned
again; only the owner reads any of it.
- Already there from steps 1 to 3: the engine's `facts()`, `factsById()` and
  `citationCoverage()`, `FactSourceRepository`, the archive thread and topic-opening code, the
  owner labels on the Notes page (without a day or links), links by id on Memory and Inbox
  (`EvidenceLinks`), and the `source_tags` and `note_refs` lines on System › Health.
- Storage: originals in the owner's words (`OwnerOriginals`, `ownerEventLabels`; a retired one
  `{retired:true}`, never an id; “Source not recorded” and fail-closed “Source not available
  right now” without an id, counted as `source_tags`), `GET /v1/memory/originals` (≤50 ids);
  `GET /v1/events/<id>/thread` (`ownerThread`; someone else's private chat kept out of other
  chats' threads) and `GET /v1/memory/message-facts` (engine `everyFact` on stock
  `/conclusions/list` with `source_message_ids`, receipts found on two indexes, facts about
  another participant left out; outside Messages' live paths, so it loads on open and Check again);
  `GET /v1/memory/facts` (newest first, 25 a page, by chat or person, ≤5 originals a fact) and
  `/longterm/coverage`; each review note's `day` (a turn's label names its own) and each note's
  `originals`; empty reasons uncounted, a failed
  engine read counted ([store](test/store-memory-dashboard.test.ts),
  [notes](test/store-note-sources.test.ts), [engine](test/memory-engine.test.ts),
  [relay](services/hermes/test_management_api_errors.py)).
- Pages: Messages › detail **Thread** (Replies to, Topic with its first message, Forwarded
  from, Replies (N); a topic's opening is Topic, never Replies to, and lists no replies) and
  **Learned into memory** (Exact source or Learned with other messages); Memory › Long-term
  **Facts it learned** with the coverage line, **In chat** and **About person** filters and
  People's link; Notes' day and **Original message** links; a label and time beside each
  original on Facts, People, Projects and Inbox review, one lookup per page
  ([logic](test/dashboard-memory-sources.test.mjs), [browser](test/dashboard-pages.browser.mjs),
  preview fixtures in [preview](test/dashboard-preview.ts)).
- Tester: `dashboard_shows_where_memory_came_from` (a reply chain in a new forum topic with
  Bob's LEARNMARK and the owner's PRIVATEMARK in their private chat: thread, topic opening,
  learned facts, the Facts list by chat and newest first, coverage, labels, and a retired message
  never linked, then restored) and the Notes page's day and originals in
  `native_notes_reach_later_turns`, each seen to fail at its gate on a fake without the fix
  ([scenarios](test/test_source_tag_scenarios.py)).
  Checks (2026-11-19): the build; node unit tests (491: 436 pass, 51 skipped, and only the 4
  workflow tests that also fail on main fail); the dashboard tests (81 of 81) and format check;
  the browser tests (72: 69 pass, and the 3 that also fail on main); the store files of this
  step (memory dashboard, note sources, fact sources, archive thread, owner API, fact opening:
  8 of 8); Python Hermes (1064, with the 2 environment errors that also occur on main) and the
  repository's Python tests (186, 2 skipped).
  Changed from the design: short labels come from one lookup route, not a field on each page's
  answer; Learned into memory and Thread reload with Messages' live updates, not on a timer;
  Notes' links carry no label of their own; the person filter reads only that person's own
  memory participant.
  Pending:
  - The full tester on images: `dashboard_shows_where_memory_came_from` has only run against the
    fake. Its person filter is not gated there (the store and browser tests cover it).
  - A live look at the Thread and Learned sections and the Facts list on the owner's install.
  - Messages' list calls a retired message “Hidden from assistant”, these sections “Retired
    message”; one word may be better.
  - The privacy scan before a push.

Members step 4: member private chat, and 4b: the owner asks about a member
([ADR-0262](docs/adr/0262-member-private-chat.md); owner, 2026-11-12, approving the Members
design, group talk off does not stop private chat; 2026-11-18: Q1 the answer about a member is a
separate message, then dropped; Q2 member saved notes wait; Q3 "they can see tasks in both", read
only). One branch: a contract, six parts and their integration.
- Admission: `members.private_chat` (on by default, also for existing members), `privateTalks`,
  `memberPrivate` and the `conversationScope` member branch; a stranger, or a member paused,
  removed or with private chat off, gets the private fixed reply once a UTC day; the daily cap
  counts group and private turns together, with its own private reply and key
  ([admission](test/member-admission.test.ts), [schema](test/store-member-schema.test.ts),
  [private](test/store-member-private.test.ts), [bot](services/telegram/test_approval_cards.py)).
- Bound readers: the `member`, `member_read` and `lane` claims, `boundReader`, server-only
  `memberChat` from `bindReads` on every request in the app and the broker, the 30-day stale rule
  and the re-check (`telegram.member_status`, at most 10 a turn), the answer-only sites pinned
  ([claims](test/member-claims.test.ts), [readers](test/member-bound-readers.test.ts),
  [reads](test/store-member-reads.test.ts), [passes](services/telegram/test_service.py),
  [check](services/telegram/test_approval_cards.py),
  [Hermes](services/hermes/test_member_private.py)).
- Privacy: `canRead` refuses other private chats and `member_read` sends to every reader but the
  dashboard; owner recall's allowlist; never learned, consented, granted or suggested; read-only
  routes, tools and effect sites; tasks one read-only view per project (D14)
  ([reads](test/store-member-reads.test.ts), [private](test/store-member-private.test.ts),
  [Hermes and lanes](services/hermes/test_member_private.py)).
- 4b: `ask_member_chat`, the ask guard, `owner_member_asks` and its worker, one `member_read`
  message in the owner's chat, never carried, pruned, its quotes hidden
  ([guard](test/owner-member-asks.test.ts), [store](test/store-owner-member-asks.test.ts),
  [Hermes](services/hermes/test_member_read.py), [turns](services/hermes/test_brain_turns.py),
  [history](services/hermes/test_profile_history.py)).
- Dashboard: the local laws line, **Private chat with Nocheh**, Messages' **Members’ chats**
  filter (`private_chats`), Notes labels, six new editable texts
  ([texts](test/dashboard-member-private.test.mjs), [filters](test/archive-filters.test.ts),
  [list](test/store-member-messages.test.ts),
  [pages](test/dashboard-pages.browser.mjs)).
- Tester: fake `getChatMember`, MEMBERMARK canaries with the member's chat as their home, and nine
  member private chat scenarios ([scenarios](tools/acceptance/product_scenarios.py),
  [fake](test/test_telegram_mock_members.py), [seeding](test/test_tester_member_private.py),
  [sweep](test/test_canary_sweep.py)).
- Review fixes: Hermes takes a member's lane before the space's lane, so a member's group turn
  waiting on their private turn holds no group and the owner's turns there go on; stale groups are
  re-checked in the places the readable ones leave, groups past the cap are left out of tool reads
  too (`member_turns.left_out`), and a late 'in' never undoes a newer leave; the ask's answer goes
  under the asking message's continuation key, a refused reply fails once, a silent or unconfirmed
  asking turn still runs the ask, any other end tells the owner once, an ask that expires while it
  runs says so, a removed member's open ask tells the owner once, several accounts give
  `member_chat_several`, the broker relays `/v1/member-asks`, and ask jobs offer no Cancel or
  Retry; an ask's Notes label has its date; a task refusal names at most 50 projects (`more`);
  `private_chats` splits in SQL from the store's chat rows; an import review keeps no learning yes
  for member chats; `notesSender` refuses Nocheh's messages in member chats; the tester's 4b,
  context probes and re-check searches pass against correct code
  ([lanes](services/hermes/test_member_private.py), [rechecks](test/member-admission.test.ts),
  [private](test/store-member-private.test.ts), [reads](test/store-member-reads.test.ts),
  [asks](test/store-owner-member-asks.test.ts), [broker](test/store-security-broker.test.ts),
  [tasks](test/knowledge-broker.test.ts), [list](test/store-member-messages.test.ts),
  [notes](services/hermes/test_turn_process.py), [tester](test/test_tester_member_private.py)).

  Checks on the integrated branch with the review fixes (2026-11-18): the build; node unit
  tests (802: 540 pass, 258 skipped, and only the 4 workflow tests that also fail on main fail);
  all 112 store test files (304 pass, 0 fail); the controlled-actions, managed-runs, sharing and
  workflow-operations suites on the store fixture fail as on main; Python Telegram (157), Hermes
  (1047, with the 2 environment errors that also occur on main) and the repository's Python tests
  (172, 2 skipped); the dashboard build, format check and its tests (72 of 72); the browser tests
  (67: 64 pass, and the 3 that also fail on main).
  The whole full tester on fresh images, in five parts (2026-11-18/19): 45/45, 29/29, 25/25, 30/30
  and 17/17, with the canary sweep ("a member's marks never left theirs"). Its first member round
  found an ask's search calling the shared-facts route the ask may not use (fixed, with a unit
  test in [mcp](test/mcp.test.ts)), and two leak checks that counted the owner's own recall query.
  Merged main 1182097 (fact sources, ADR-0261 step 2): bound readers (a private answer, a member's
  private chat, the owner's ask about a member) never open `nocheh:memory:` facts; the facts route is
  in no bound route list and `openFact` refuses any bound reader
  ([readers](test/member-bound-readers.test.ts), [facts](test/fact-opening.test.ts)). The suites were
  run again on the merged branch (store 306/306; node unit only the 4 known; Python as before, and
  `test_retired_source_leaves_tags` fails as on main), and the full tester ran the member scenarios with
  main's five fact scenarios on fresh images: 22/22.
  Pending: live acceptance on the owner's install after merge.
  Left for later: a member with several accounts that have private chats is not asked about (the
  owner is told so); `notesSender` does not tell `member_read` sends apart (`canLearn` and
  `privateHold` refuse them first); reading a group only from when the member joined
  (`read_from`); member saved notes; an own role per member chat; members' own **Answer
  privately**.
  Owner steps: take a backup and rebuild and run every image from the same revision
  ([deploy](docs/deploy.md#upgrade-to-step-4)). Every member then has private chat on; turn it off
  per member on **Members**. Members' chats are under Messages › **Members’ chats**.

Members step 3: members in groups
([ADR-0260](docs/adr/0260-members-in-groups.md); owner, 2026-11-12, approving the Members
design: members are allowed by default in the groups they are in, with a permission scope per
member, no daily limit on small jobs and no approval for web pages and outside tools; the step 3
thread, 2026-11-17: a group with no switch counts as on, no "Asked, not allowed" list, "Add by
Telegram user ID" kept, and the owner's own web and tool requests in groups skip the card).
One branch: a contract, five parts and their integration. `TELEGRAM_GROUP_ACCESS` is retired:
members live in the control store and are managed on the Members page.
- The member directory: `members`, `member_chats`, `member_directory_state` and `member_turns`,
  and `chat_accounts.member_id`'s foreign key ([schema](test/store-member-schema.test.ts)).
  `talks`, `may`, `reaches`, `tasks` and `accounts` answer every person check; a group with no
  switch is on, and a decision made without a message from the group also needs Telegram's
  newest 'in' row ([directory](test/members.test.ts)). It loads in one snapshot after every
  commit that moves the member revision, and within the 2 s watch elsewhere; member commands
  are owner commands with no guard epoch ([repository](test/store-members.test.ts)).
- The gates: admission, the final reply check, the voice cut, the daily message cap
  (`member_daily_limit`), jobs (`job_not_permitted`, a running job and its card's presser),
  posts to other groups (`member_post_not_allowed`, the asker's own card only for a group they
  reach, a send cancelled as `member_changed`), destinations, and web pages and outside tools
  without a card (`group_tools`, `tool_not_permitted`, the claim's check again)
  ([gates](test/store-member-gates.test.ts), [tools](test/store-controlled-actions.test.ts),
  [runs](test/store-controlled-execution.test.ts), [jobs](test/store-background-jobs.test.ts)).
  Task calls check the member again (`member_access_changed`), and read-only tasks give a
  read-only turn ([tasks](test/store-member-tasks.test.ts)). The bot keeps no list: a paused or
  switched-off member gets the stranger's fixed reply, once a UTC day per group, a reply Telegram
  refused or that never left does not use up the day, and a post in a chat's own name gets
  nothing ([dispatch](test/store-telegram-dispatch.test.ts),
  [bot](services/telegram/test_approval_cards.py)). The owner's own group
  requests skip the tool card behind `let ownerGroupTools=true`.
- The carry: at the first start, the lists the last start admitted become members with exactly
  their reach, on rows for granted groups and off rows for every other group chat Nocheh is in,
  once, with skips counted in the `member_carry` log line; a group Nocheh is added to again later is a
  new group, on by default ([carry](test/store-member-carry.test.ts)).
  Reset snapshots are v3 only and carry the members
  ([reset](test/store-reset-setup.test.ts), [acceptance](test/store-reset-acceptance.test.ts),
  [Python](services/hermes/test_reset_configuration.py)). The runtime document is
  `{enabled, owner_id}`, and an old `.env` line is hidden; keeping it never asks for Apply, and
  deleting it asks for one Apply that changes nothing in the services
  ([configuration](test/store-runtime-configuration.test.ts),
  [settings](services/hermes/test_settings.py)). The `group-access` command, the installer's
  checks and Hermes's person checks are gone ([scopes](services/hermes/test_scopes.py),
  [configuration](services/hermes/test_configuration.py)). The add card's own new project moves
  no guard epoch ([adds](test/store-chat-adds.test.ts)).
- The dashboard: Members after Chats, with permissions, groups, pause, remove, the daily cap and
  both add flows, every switch saving at once and the daily cap ("Times each member may ask
  Nocheh a day") with its own Save; Chats shows a read-only "Members here"; the
  Save path for people, Settings' group access and System's daily member jobs are gone; three new
  editable texts ([model](test/dashboard-members-model.test.mjs),
  [routes](test/dashboard-routes.test.mjs), [identities](test/store-member-identities.test.ts),
  [pages](test/dashboard-pages.browser.mjs)).
- Full tester: members are set up through the owner's Members routes, with no restart; new
  scenarios add a member on the dashboard, switch one off in a group, pause one, read a web page
  without a card, keep tasks read only, turn posting off, follow a member who left, run four
  member jobs in a day, reach the daily cap, and post in a chat's own name. The three
  fixed-reply scenarios ask as a person new to the fixture, so a second run the same UTC day
  still sees the reply ([scenarios](tools/acceptance/product_scenarios.py),
  [seeding](test/test_tester_members.py), [fake](services/telegram/test_telegram_http_fixture.py)).
- Review fixes (2026-11-17): a post a member confirmed on their own card is cancelled when they
  no longer reach its target, and the owner's card keeps the owner's word
  ([gates](test/store-member-gates.test.ts)); a member's job stops between its report's parts
  ([runs](test/store-background-job-runs.test.ts)); an upgrade copies switches also when the new
  chat neither folds nor takes the old one's state ([adoption](test/store-chat-adoption.test.ts));
  the carry writes off rows only in the groups Nocheh is in; identities list only members switched
  on in groups Nocheh is in ([identities](test/store-member-identities.test.ts)), and the
  management side asks Telegram once per unnamed person a read, with a refusal ending only that
  lookup and flood control ending the group's ([directory](services/hermes/test_telegram_directory.py));
  a reply running across a new group's own project sends on its first try
  ([dispatch](test/store-telegram-dispatch-chats.test.ts)). The dashboard shows a saved member
  change at once, gives a change made again a new operation ID, says why for the daily cap and
  `member_changed`, leaves out of "Members here" a member Telegram never showed there whose switch
  is off or who left, points Settings › Telegram to Members, and says where web pages and outside
  tools skip the card ([model](test/dashboard-members-model.test.mjs),
  [pages](test/dashboard-pages.browser.mjs)).

  Checks on the integrated branch with the review fixes (2026-11-17): the build; node unit tests
  (676: 431 pass, 241 skipped, and only the 4 workflow tests that also fail on main fail); the
  chat id format gate; all 104 store test files (284 pass, 0 fail); Python Telegram (148), Hermes
  (976, 4 skipped, with the 2 environment errors that also occur on main) and the repository's
  Python tests (126, 2 skipped); the dashboard build, type and format checks and its tests (63 of
  63); the browser tests (62: 59 pass, and the 3 that also fail on main).
- Merged main 7ae9ba1 (memory source labels, ADR-0257; Honcho workspace retries, which took
  ADR-0259, so this step's ADR is [0260](docs/adr/0260-members-in-groups.md)). The owner's notes
  review admits the owner and the members who talk there, reactions included, and its people
  names read the member directory; refusals go out under the `refusal` send class
  ([policy](test/assistant.test.ts), [reviews](test/store-native-review.test.ts),
  [labels](test/source-labels.test.ts), [bot](services/telegram/test_approval_cards.py)). The
  docs say a message kept out of the owner's notes stays out after its sender becomes a member,
  not after a grant ([docs](test/memory-source-docs.test.ts)).
  Checks after the merge (2026-11-17): the build; node unit tests (735: 484 pass, 247 skipped,
  and only the 4 workflow tests that also fail on main fail); all 105 store test files (293 pass,
  0 fail); Python Telegram (152), Hermes (1012, 4 skipped, with the 2 environment errors that
  also occur on main) and the repository's Python tests (143, 2 skipped); the dashboard build,
  format check and its tests (66 of 66); the browser tests (62: 59 pass, and the 3 that also
  fail on main).
  Pending:
  - The whole full tester on images. It has not run on this step, nor main's new memory
    scenarios with members.
  - The add card's own project moving no epoch has no tester scenario; a store test covers it.
  - The privacy scan before a push.
  - Live acceptance on the owner's install after merge.
  Owner steps: apply any waiting change to who can talk in groups on 2b-2, finish any data
  reset, take a backup, and run every service from the same revision
  ([deploy](docs/deploy.md#upgrade-to-step-3)). Then open **Members**: everyone you allowed is a
  member in exactly the groups they could talk in. The old `.env` line is ignored. Making the
  bot an admin in members' groups is recommended. Your own web and tool requests in groups no
  longer show a card; ask if you want that back.

Memory step 3: replies in the turn and where notes came from
([ADR-0261](docs/adr/0261-recalled-facts-and-search-hits-name-their-source.md) step 3;
owner, 2026-11-17: track the source of each fact before the MVP; built on the same three
recommended answers as steps 1 and 2). No Honcho code or setting changes and nothing is learned
again; Hermes's own code is unchanged.
- Already there from steps 1 and 2: `FRAME_WORDS` with the reply words, the retirement plan's
  reply block and reply part spans with their tests, `telegramTopicOpening`, `readable()`,
  `SourceTagRepository`, `_copied()`, the source-usage sentence in archive_search's description,
  and owner recall's `native_session` text (V1).
- The reply block: a turn whose message replies to a message its reader may read quotes it after
  the speaker line (first in the owner's chat) as `[Replying to, by=…: <tag>] (source …)`, up to
  200 characters of the reader's copy unframed, `[End of replied-to message]`, built from the
  read's own relations, `readable()` and one tag request (`SourceRepository.repliedTo`), never
  payload ids; a reply to Nocheh reads `by=nocheh`; owner, group and private-answer turns, and a
  member's private chat (first, as that member reads; never a `member_read` answer, never the ask
  about a member, [store](test/store-member-private.test.ts),
  [Hermes](services/hermes/test_member_private.py));
  recent messages carry `[In reply to, by=…]` parts without text, looked up at once; a forum
  topic's opening is never a reply ([unit](test/telegram-reply-frame.test.ts),
  [store](test/store-telegram-reply.test.ts), [Hermes](services/hermes/test_turn_process.py)).
- Notes: the `reply` read (this turn unless the owner typed the target, earlier rows only when
  the note copies the block's text; owner words `read_reply`), a review's label names its main
  message's day before its place, a turn's note its day from `at_time` in the reader's zone (old
  notes `<day> UTC`); each note in a turn's evidence has a `ref` that `archive_read note=<ref>`
  opens in that turn only (`note_lookups`, 7 days, up to 5 tagged and read-checked sources);
  owner corrections in `memory_recall` have `tag` and `evidence`, owner note hits `day` and
  `sources`; the source-usage sentence is the recall evidence's `about` and ends the default
  `memory.evidence` ([labels](test/source-labels.test.ts), [refs](test/store-note-refs.test.ts),
  [store](test/store-note-sources.test.ts), [recall](test/store-native-memory.test.ts),
  [Hermes](services/hermes/test_note_sources.py), [evidence](services/hermes/test_memory_evidence.py)).
- Tester: `topic_message_is_not_a_reply`, `reply_note_reads_reply`, `reply_source_question`, a
  retired reply target in `retired_source_leaves_tags` (its block, the turn's tool work and its
  note go) and a review note's day and ref in `native_notes_reach_later_turns`, each seen to fail
  at its gate on a fake without the fix; the scripted model's `[[replied:]]` reads a turn's reply
  frame and `[[note_open:]]` opens a note by its ref ([scenarios](test/test_source_tag_scenarios.py),
  [model](test/test_scripted_brain.py)). The fake now names a recall row's role in words, as
  storage does, which `retired_source_leaves_tags`'s fake run had missed since step 2.
  Checks (2026-11-18): the build; node unit tests (456: 401 pass, 51 skipped, and only the 4
  workflow tests that also fail on main fail); the store files of this step (telegram reply and
  dispatch, note refs, note sources and native memory: 25 of 25; archive thread, server, source
  tags, search tags and native review also pass); Python Hermes (1040, with the 2 environment errors that also
  occur on main), Telegram (152) and the repository's Python tests (164, 2 skipped).
  Changed from the design: a review label's day comes before its place, so a cut label keeps it;
  a private answer quotes what its question replies to; `archive_read` no longer requires `id`
  when `note` is given; the model's reply read says "the message it replied to", without "(not
  the owner's own words)", so an owner-chat label stays whole.
  Review fixes: a replied-to text shorter than a run that a later note holds whole reads `reply`;
  a later turn's note copied from a retired message (its turn message, replied-to block, recent
  message or tool result) is withheld with that turn's tool work (`plan()` rules `quoted2`); a
  note ref and owner note hits check canRead before tagging (`SourceTagRepository.checked`), so
  a failed check opens nothing, and a failed tagger is counted; refs not kept count as
  `note_refs`, a line of their own; recall `day` is null for a note with only a UTC day; the
  reply frame's line shapes come from `retired_history.py`; the tester's dictated note no longer
  shares a number with Bob's message ([Hermes](services/hermes/test_note_sources.py),
  [retire](services/hermes/test_retired_history.py), [refs](test/store-note-refs.test.ts),
  [monitor](services/hermes/test_monitoring.py), [health](test/dashboard-system-health.test.mjs)).
  Pending:
  - The full tester on images: the step 3 scenarios have only run against the fake.
  - A live look at a reply block and a note's ref in a group and in the owner's chat.
  - The privacy scan before a push.
  Left for later: step 4 (dashboard).

Memory step 2: recalled facts name their source
([ADR-0261](docs/adr/0261-recalled-facts-and-search-hits-name-their-source.md) step 2;
owner, 2026-11-17: track the source of each fact before the MVP; built on the same three
recommended answers as step 1). No Honcho code or setting changes; peer cards and dreams stay off
and nothing is learned again.
- Engine: `facts()`, `factsById()`, `factExists()`, `mostDerived()`, `citationCoverage()` and
  the summary's message, on Honcho's stock conclusion list, refusing an answer about another
  participant, session or level; Nocheh's Honcho plugin gives uncited facts their batch (at most
  8 messages, `messages_truncated`, never complete) and can count citation coverage (called
  from step 4) ([engine](test/memory-engine.test.ts), [plugin](services/honcho/test_provenance.py)).
- Sources: one receipts query for the reader's audience, the fact's own person first, `by`
  `owner` only for exact, whole all-owner facts; a fact that is not exact rests on messages
  Honcho never names, so it reads `person` and, when it names only its own person's messages,
  `learned in <where> on <when>` with no sender; the source line on a person's, forward's or
  file's message first ([rules](test/fact-sources.test.ts)).
- A turn's memory: up to 100 facts a block as `n. HH:MM fact` under code-built source lines,
  only model text guarded and every line checked, within 20,000 characters, named by its record,
  whose unguarded parent keeps every source (never pruned); prose with `source_tags_unavailable`,
  counted once, when facts or tags can't be read; exact only without a summary; a failed plugin
  counted; the owner's profile rebuilt with Honcho's own pick
  ([unit](test/fact-sources.test.ts), [store](test/store-fact-sources.test.ts)).
- `memory_recall`: answer and facts named by their records, 12 facts listed with two tagged
  sources each, up to 200 stored; `archive_read nocheh:memory:<id> fact=<n>` opens a fact for its
  own audience and refuses while correcting, after its conclusion is gone, or for any fact of a
  record the retired route reports;
  the retired route lists `retired_records` and Hermes withholds rows citing them
  ([unit](test/fact-opening.test.ts), [store](test/store-fact-opening.test.ts),
  [Hermes](services/hermes/test_retired_history.py)).
- Tester: `recalled_fact_opens_its_original`, `fact_about_bob_names_bob` (the fake deriver now
  learns an answer to another person's marked question, citing both), `recall_facts_carry_sources`,
  `forward_fact_names_its_origin`, `per_turn_memory_stays_small` and the facts part of
  `retired_source_leaves_tags`, each seen to fail at its gate on a fake without the fix; the
  scripted model's `[[memory_blocks:]]` reports a turn's blocks
  ([scenarios](test/test_source_tag_scenarios.py), [model](test/test_scripted_brain.py)).
  Checks (2026-11-18): the build; node unit tests (448: 393 pass, 51 skipped, and only the 4
  workflow tests that also fail on main fail); the whole store suite (801 pass; only the files
  that also fail on main fail: controlled-actions, managed-runs, sharing, workflow-operations and
  assistant's untranscribed voice); Python Hermes (1030, with the 2 environment errors that also
  occur on main), Telegram (152) and the repository's Python tests (158, 2 skipped); the Honcho
  provenance tests (19 of 19 with a stand-in for SQLAlchemy).
  Pending:
  - The full tester on images: the step 2 scenarios have only run against the fake. Recall lists
    12 facts, so `recall_facts_carry_sources` and the facts part of `retired_source_leaves_tags`
    ask as GUEST, whose few facts come first.
  - A live look at a turn's source lines and an opened fact in a group and in the owner's chat.
  - The privacy scan before a push.
  Left for later: step 3 (replies in the turn, notes refs) and step 4 (dashboard).

Memory step 1: search hits and opened messages name their source
([ADR-0261](docs/adr/0261-recalled-facts-and-search-hits-name-their-source.md); owner,
2026-11-17: track the source of each fact, not only history without its thread and relations,
before the MVP). Built on the three recommended answers, which the owner may still change: in a
group the owner's words are named by the owner's Telegram name with `by=owner`; the owner's own
chats read times in the Settings › Tasks zone and every other reader reads UTC; only the owner's
own chats read a People name, as `saved as “Brother”`.
- Source tags: code builds `{tag, by, at}` from the archive, the reader's copy and Nocheh's
  records; one guard `prepare` per request; a tag that cannot be built reads
  `source not available right now` and counts as the `source_tags` memory problem on System ›
  Health; every tag passes a batched `readable()` held equal to `canRead`
  ([tags](test/source-tags.test.ts), [store](test/store-source-tags.test.ts),
  [health](test/dashboard-system-health.test.mjs), [Hermes](services/hermes/test_monitoring.py)).
- Search hits: `archive_search`, `memory_search`, `current_reactions`, shared releases and
  grants and `archive_page` items carry tags beside every field they had; `archive_page` no
  longer shows a numeric sender id ([search](test/store-search-tags.test.ts),
  [MCP](test/mcp.test.ts), [sharing](test/store-sharing.test.ts)).
- Opening a message: `archive_read` takes `replies` and `chain` and shows what a message replies
  to, the replies to it, a forward's origin, its topic and the message Nocheh's reply answers,
  each read-checked, within 16,000 characters; it also opens `nocheh:grant:` and
  `nocheh:learned:` ids ([thread](test/store-archive-thread.test.ts)).
- Retire means forget at once: a retired recent or replied-to message quoted in a stored turn is
  withheld with that turn's tool rows and notes ([Hermes](services/hermes/test_retired_history.py));
  owner recall's chat-history hits carry their own text, time and citations
  ([Hermes](services/hermes/test_native_memory.py), [store](test/store-native-memory.test.ts));
  recall evidence skips retired writes and keeps a sibling topic's in a group whose topics share
  memory ([provenance](test/store-provenance.test.ts)).
- Tester: `search_hits_name_their_source`, `group_tags_stay_in_the_group`, `reply_thread_opens`,
  `topic_sharing_group_keeps_evidence`, `retired_source_leaves_tags` and
  `owner_recall_session_hits_have_text`, each seen to fail at its gate on a fake without the fix
  ([scenarios](test/test_source_tag_scenarios.py)).
Full tester 2026-11-17: the six scenarios and the memory and privacy scenarios passed (15 of 15). Pending: a live look at tagged hits in a group and in
the owner's chat. Left for later: the tester has no gate for a shared fact's
`shared by the owner on <day>` (the store tests cover it); steps 2 (facts name their source),
3 (replies in the turn) and 4 (dashboard thread and sources).

Members step 2b-2: only the owner adds Nocheh to groups
([ADR-0253](docs/adr/0253-only-the-owner-adds-nocheh.md); owner, 2026-11-12, approving the
Members design: only the owner adds Nocheh to a group, and anyone else's add leaves; 2026-11-14:
a group Nocheh is already in that the owner never turned on stays silent and is listed as Off).
One branch: five parts and their integration. `TELEGRAM_GROUP_IDS` is retired: a group is on
while its chat record says so.
- Which groups are on: `chats.state` `active` alone serves a group, and a topic follows its
  group. The policy's `group_ids` is derived from the groups that are on, and the runtime
  configuration document is `{enabled, owner_id, group_access}`, so the first start after the
  upgrade writes one revision and one guard epoch. Access keys are checked by shape only and are
  kept while a group is off. New and seeded groups start off, and at each start the owner's
  private chat is the one private chat that is on. A state change moves the directory revision,
  and every process sees it within the 2 s watch
  ([adoption](test/store-chat-adoption.test.ts), [records](test/store-chat-records.test.ts),
  [seeding](test/store-chat-seed.test.ts), [configuration](test/store-runtime-configuration.test.ts),
  [reset](test/store-reset-setup.test.ts)). A reset that keeps setup brings a group still
  waiting to be left back off, with its topics, and an old `TELEGRAM_GROUP_IDS` line, empty or
  not, never makes Settings ask for Apply ([settings](services/hermes/test_settings.py)).
- Adds and removals: a `my_chat_member` update about Nocheh's own bot says who added or removed
  it ([updates](test/chats-telegram-updates.test.ts)). Only a live update about a group's current
  Telegram id, newer than the last state change and taken in after the first start of this
  build (`chat_seed_state.adopt_after`), changes the group; older adds and removals are kept in
  the record only. The owner's add turns it on at once; anyone else's add, a hidden adder's
  included, makes it `pending`, and Nocheh leaves. An add to a group that is on changes
  nothing, and an upgrade is never an add: any add, the owner's too, to an off, pending or
  could-not-leave group within 10 minutes of its upgrade is the upgrade's echo, except the
  owner's add to an off group first recorded in those 10 minutes with no add or state change on
  record, whose own add was not recorded yet. Nocheh leaving makes the group `left`; a removal
  makes it `removed`. An upgrade's new supergroup folds into the old chat when only its own add
  served it and it has no project answer; an owner add folded in turns on only an old chat
  Nocheh was not in, or an off one first recorded just then in the same way. When the two stay
  apart, a new chat on only from the owner's add within 10 minutes of the upgrade takes the old
  chat's Off, Couldn't leave or Leaving and who added Nocheh, and its waiting card never goes; a
  Leaving group's leave moves to the new id and the old chat becomes `left`, unless the new
  chat's card was already sent. Each add or removal keeps a content-free record
  ([adoption](test/store-chat-adoption.test.ts)).
- The add stage: the storage worker's `adds` stage leaves 30 s after someone else's add,
  retrying after 1, 2, 4 and up to 60 minutes with no limit, and settles `left` or
  `could_not_leave`; a leave Telegram still answers with the group's upgrade after six tries,
  over an hour, settles `could_not_leave`. It tells the owner of a member's or a hidden adder's
  add, at most once per group and ten times in all a day; a stranger's add gets no note. A
  removal from a group that was on gets one line, outside those caps. 30 s after the owner's
  add, a group with no project answer joins a new project named after the group, and the
  owner's card offers Move to the three projects updated last, No project, and Turn off; only
  the owner's press in the private chat acts, and each press is its own owner command. A card
  whose send did not go is tried again only while the group is still on from that add and in
  its project; otherwise it ends with no card, and a project it left empty is archived in an
  owner command of its own. The texts are the owner's, under
  `telegram.chat_adds` ([stage](test/store-chat-adds.test.ts),
  [card and backoff](test/chat-adds.test.ts)).
- The owner's switch: `POST /v1/chats/state` turns a group Nocheh is in on or off in one owner
  command, with a project answer when it is turned on (new, an existing project, or none), and
  refuses a chat that is not a group or that Nocheh is not in
  ([adoption](test/store-chat-adoption.test.ts)). The dashboard switch applies at once and
  shows each group's state, a topic its group's, with its own texts for an anonymous add;
  Settings › Telegram has no group list; the import page offers every group that is on, read
  through `/v1/conversations` filtered by `kind` and `state` before paging; System › Sent to
  apps names a leave "Leave a group", and a leave that found Nocheh gone (`already_left`) is not
  a problem, nor is any failed or uncertain try of a leave the stage settled as left, with no
  time window ("Nocheh left"). A served list whose last read failed is not whole, so the import
  page says some groups may be missing. Refresh group names asks at most 50 groups a press,
  those checked longest ago first, and says how many were not checked in the last hour
  ([model](test/dashboard-chats-model.test.mjs),
  [served groups](test/dashboard-chat-directory.test.mjs),
  [filters](test/store-owner-supervision.test.ts), [records](test/store-chat-sends.test.ts),
  [refresh](test/store-telegram-chats.test.ts), [pages](test/dashboard-pages.browser.mjs)).
- The bot and the tools: nocheh-telegram leaves a group through `/internal/telegram/leave`,
  which refuses the owner's chat, a positive id and any chat that is on. Inside its send lock,
  right before the leave, it reads the served list again and asks the app
  (`POST /internal/chats/leave`) whether the group is still pending from that add
  ([route](test/store-server.test.ts)). It keeps a leave's answer by add and Telegram id, so an
  upgraded group's new id is asked on its own. It asks Telegram only for the update kinds Nocheh
  reads, sends the card's buttons in rows, and shows the bot's `getMe` abilities in its health ([leave](services/telegram/test_leave.py),
  [service](services/telegram/test_service.py), [health](services/telegram/test_health.py),
  [cards](services/telegram/test_approval_cards.py)). `configure-telegram --group-id` is
  refused; import mapping, the Telegram directory, Hermes scopes and the reset tools read the
  groups that are on from `GET /internal/chats`
  ([configuration](services/hermes/test_configuration.py), [scopes](services/hermes/test_scopes.py),
  [imports](services/hermes/test_import_jobs.py), [directory](services/hermes/test_telegram_directory.py),
  [reset](services/hermes/test_reset_preservation.py), [operations](test/test_telegram_operations.py)).
- Full tester: the fake Telegram leaves a chat and reports Nocheh's status change, and the
  owner adds the fixture groups at connect. New scenarios cover a member's, a stranger's and an
  anonymous admin's add, a member's re-add, a leave Telegram refuses, a removal, the owner's
  add, and the dashboard switch. Before an add that expects a note, the tester moves other
  groups' earlier leave notes out of the 24 hours, so a kept fixture never fills the cap on all
  notes ([scenarios](tools/acceptance/product_scenarios.py),
  [fake](services/telegram/test_telegram_http_fixture.py)).

  Checks on the integrated branch: the build; all 98 store test files on old-shaped and digest
  chats (256 pass, 0 fail); Python Hermes (970, 4 skipped, with the 2 environment errors that
  also occur on main). On each part's branch: node unit tests (only the 4 workflow tests that
  also fail on main fail); Python Telegram (134); the dashboard tests (51 of 51) and its
  browser tests (50: 47 pass, and the 3 that also fail on main); the tester's own unit tests
  and the Python tests of its fake and reset tools.
  Review fixes, five branches merged here (2026-11-16): the adoption boundary, upgrade echoes
  and folds, each card press as its own command, removal lines outside the caps, the bot's last
  checks before a leave and `already_left`, the served-group list and dashboard texts, the
  reset of a waiting group, the retired list's Apply, and the tester's room for notes. Each
  fix's store tests passed on its own branch (chat adoption, chat adds, chat sends, server,
  owner supervision, owner API, reset setup, reset acceptance and the other chat files), and
  the browser tests on the dashboard branch (52: 49 pass, and the 3 that also fail on main).
  On the merged branch: the build; node unit tests (410: 355 pass, 51 skipped, and
  only the 4 workflow tests that also fail on main fail); the dashboard build and format check;
  Python Telegram (145) and settings (11).
  Second review fixes, four branches merged here (2026-11-16): the owner's add to a group first
  recorded during its upgrade, the stay-apart echo, a card tried again only while still true, a
  leave Telegram keeps answering as upgraded, leave receipts by add and Telegram id, a leave try
  cleared once the leave settled as left, Refresh group names 50 at a time, and a failed read
  again of the served list. Each fix's store tests passed on its own branch: chat adoption
  (10), chat adds (7), chat sends (2), Telegram chats (2), server (2) and the other chat files;
  the browser tests on the dashboard branch (52: 49 pass, and the 3 that also fail on main).
  On the merged branch: the build; node unit tests (411: 356 pass, 51 skipped, and only the 4
  workflow tests that also fail on main fail); the dashboard build and format check; Python
  Telegram (146).
  Pending:
  - The whole full tester on images. It has not run on this step.
  - The store suite and the browser tests on the merged branch.
  - A live Telegram check of the upgrade echo rule and the fold: when Telegram upgrades a group,
    in which order do the upgrade messages and the bot's status update come.
  - Live acceptance on the owner's install after merge.
  Owner steps: after the upgrade, Nocheh stays on in the groups `TELEGRAM_GROUP_IDS` listed,
  and every other group it is in stays silent and reads Off. Add Nocheh yourself to a new group,
  and turn a group on or off in Chats. The old `.env` line is ignored. Take a backup before
  upgrading, and run the app and the bot from the same revision
  ([deploy](docs/deploy.md#upgrade-to-step-2b-2)). A rollback to 2b-1 needs `TELEGRAM_GROUP_IDS` made again from the groups that are
  on ([deploy](docs/deploy.md#roll-back-to-step-2b-1)).

Members step 2b-1: Nocheh's own chat ids ([ADR-0252](docs/adr/0252-chats-get-nochehs-own-ids.md);
owner, 2026-11-12: "I just review the tables and seems what I want if there is a important point
or need my answer ask, else start build.", approving the Members design, whose step 2b is "Chat
records ready for Slack"; "want ensure the db design cover slack for future"). One branch: a
shared contract, four parts and their integration. What Nocheh serves does not change, and
redeploying main undoes it: no stored value is rewritten and the archive is never changed.
Step 2b-2 retired `TELEGRAM_GROUP_IDS`, which this step still read.
- Contract: the chat records (`chat_connections`, `chat_accounts`, `chats`, `chat_ids`,
  `chat_memberships`, `chat_directory_state`), bot-free ids (`chatIdFor`), one chat id check
  and the synchronous chat directory, which fails closed for an id it does not know
  ([chats](test/chats.test.ts), [schema](test/store-chat-schema.test.ts),
  [format gate](test/chat-id-format-gate.test.ts), whose allowlist now holds only adapter,
  legacy and unrelated sites).
- Chat records, seeding and the directory: every chat value stored before this step keeps
  naming its chat as that chat's Nocheh id; a chat first seen later gets a digest with no bot
  in it, and history the owner imports keeps its old ids. Each captured update records its
  chats, topics, people and memberships, newer update wins (update order within one bot,
  capture time across bots or after a week), and a Telegram upgrade keeps one chat with both
  ids. At app start the seeder fills chat records, insert only, then a background loop fills
  memberships. The app and the security service load the directory before serving and reload
  it on a new row, a newer guard epoch or a miss. `TELEGRAM_GROUP_IDS` still decides what is
  served, by any Telegram id a group has had, and `GET /internal/chats` gives the bot and
  Hermes the served list. The owner's conversations, people, topics and refresh read the
  records; send records keep the app's ids as text and name the Nocheh chat; owner records
  and reset snapshots carry the chats, only names the owner gave travel, and a chat arrives
  off ([records](test/store-chat-records.test.ts), [seeding](test/store-chat-seed.test.ts),
  [directory](test/store-owner-supervision.test.ts), [refresh](test/store-telegram-chats.test.ts),
  [topics](test/store-telegram-topics.test.ts), [strangers](test/store-strangers.test.ts),
  [sends](test/store-chat-sends.test.ts), [portability](test/store-owner-portability.test.ts),
  [reset](test/store-reset-setup.test.ts), [portable](services/hermes/test_portable_bundle.py),
  [reset tools](services/hermes/test_reset_configuration.py)).
- Reads and rules on chat rows: groups, topics, private chats, served chats, read sets,
  private answers, tool switches and a group's tasks come from the chat records, never from
  an id's shape, and a chat with no record is private and reads nothing. Archive reads expand
  a chat to every Telegram id it has had, so an upgraded group keeps its history and allowed
  people. Read sets are marked SQL parameters, a turn names its chat by its Nocheh id, and the
  owner's chat (`owner_chat`) is kept apart from the owner's account (`owner_id`). Private
  answers check chat kinds against the records and still accept an old-shaped value with no
  record, so a redeployed main keeps writing. Privacy store tests run on old-shaped (GP1 to
  GP4) and digest (NG1, NG2) chats ([spaces](test/spaces.test.ts),
  [tasks](test/store-tasks.test.ts), [private answers](test/store-private-answers.test.ts),
  [jobs](test/store-background-jobs.test.ts), [read sets](test/store-project-groups.test.ts),
  [provenance](test/store-provenance.test.ts),
  [conversation page](test/store-conversation-page.test.ts),
  [memory rebuild](test/store-memory-rebuild.test.ts)).
- Turns, sends and the two front doors: a turn pass carries its chat's app binding, checked by
  storage, nocheh-telegram and Hermes. Only the Telegram front door turns Nocheh chats into
  Telegram ids, so replies, cards, notices, owner notices and approved sends follow a group
  Telegram upgraded, and an unknown chat is never sent to. Destinations are chat ids; a link or
  Telegram id is read once into the chat it names. nocheh-telegram and Hermes read the served
  list from the app, not from `.env`, and look again before refusing a chat recorded a moment
  ago. Hermes profiles, sessions and carry keep their names, and a reset keeps preferences by
  Nocheh chat ([front door](test/telegram-frontdoor.test.ts), [pass checks](test/access.test.ts),
  [destinations](test/store-telegram-actions.test.ts),
  [runtime profiles](test/store-runtime-profiles.test.ts), [bot](services/telegram/test_service.py),
  [Hermes](services/hermes/test_scopes.py),
  [reset preferences](services/hermes/test_preference_transfer.py)).
- Dashboard, docs and the full tester: the dashboard reads what a chat is from
  `/v1/conversations` and never parses an id. Chats shows a Telegram ID label, with the
  earlier one after an upgrade, and finds a chat by name or any Telegram ID it has had (the
  server's search matches them too); rules and organizing permissions keep a chat still being
  looked up; an upgraded group's allowed people are saved under an id `TELEGRAM_GROUP_IDS`
  lists ([model](test/dashboard-chats-model.test.mjs), [search](test/conversation-search.test.ts),
  [pages](test/dashboard-pages.browser.mjs)). The full tester finds chats by their Telegram
  IDs and adds `new_id_group_works_end_to_end` and `supergroup_upgrade_keeps_history`;
  `project_groups_stay_apart` and the private-mark sweep run with the new-id group NG1 in P1
  ([scenarios](tools/acceptance/product_scenarios.py), [fixture](test/test_fixture_chats.py)).
- Integration: owner notices go to where the owner's private chat is in Telegram now; card,
  destination and profile names come from the chat records; the app server reads a turn pass
  for a chat recorded a moment ago again; end-to-end store tests cover the owner's search by
  any Telegram id ([search](test/store-conversation-search.test.ts)), an upgraded group and a
  new forum topic answered where they are in Telegram now
  ([dispatch](test/store-telegram-dispatch-chats.test.ts)) and Answer privately on digest chat
  ids ([button](test/store-private-button-chats.test.ts)).
- Review fixes: a private chat a reset or an owner-record import restored gets its person back
  at the next start or its next live message, so Answer privately works after a reset
  ([reset](test/store-reset-setup.test.ts), [records](test/store-chat-records.test.ts));
  runtime profile labels, destination names and a card's fallback name come from the owner's
  last refresh, as before, not from a title a later update showed
  ([runtime profiles](test/store-runtime-profiles.test.ts),
  [destinations](test/store-approval-buttons.test.ts), [cards](test/store-tasks.test.ts),
  [refresh](test/store-telegram-chats.test.ts)); preparing attachments and Telegram dispatch
  look again for a chat recorded a moment ago before skipping its message
  ([policy](test/assistant.test.ts)); the bot answers the owner's own turn only in the owner's
  private chat, never in a topic of it, as Hermes does ([bot](services/telegram/test_service.py));
  the owner's conversation context shows an upgraded group's allowed people merged over all its
  Telegram ids, as the gate applies them ([supervision](test/owner-supervision.test.ts)); a
  Slack thread is never a chat, so no Slack topic id is made ([chats](test/chats.test.ts)); a
  Telegram id with no record reads nothing in a store test with no fixture filling it in
  ([retrieval](test/store-retrieval.test.ts)). ADR-0252 now lists what a rollback to main
  loses and every small dashboard change.
- Full tester fixes: the first turn in a group Telegram has just upgraded is bound once the
  security service's own chat directory has looked again, not refused once and retried
  ([dispatch](test/store-telegram-dispatch-chats.test.ts)); an approved operation's follow-up
  names its chat, topic and app binding as a reply's turn does, so it answers again in the chat
  that asked ([continuations](test/store-action-continuations.test.ts)).
- Merged with main's card and forward fixes
  ([ADR-0250](docs/adr/0250-cards-and-forwards-say-whose-words-they-are.md)), on old-shaped and
  digest chats: a forwarded message's line says "You" only in the owner's private chat as the
  chat records know it, a forwarded owner command is refused there, and in a topic of a new-id
  group it gets the owner-only refusal and no turn, a forward among the recent group messages
  keeps its line
  ([dispatch](test/store-telegram-dispatch-chats.test.ts),
  [button](test/store-private-button.test.ts), [digest button](test/store-private-button-chats.test.ts)),
  and a job card in the owner's private chat names the group and topic it was asked in from the
  chat records ([jobs](test/store-background-jobs.test.ts)). A group's people list again shows
  the people its messages show, as main does, and not someone whose only record is leaving; the
  owner's people route keeps each person's standing and says whether the group's messages show
  them, under every Telegram id the group has had ([people](test/telegram-directory.test.ts),
  [records](test/store-chat-records.test.ts), [directory](test/test_telegram_operations.py),
  [pages](test/dashboard-pages.browser.mjs)). That route names each group by its Nocheh chat id,
  with every Telegram id it has had, and the dashboard's directory of people keeps that id: a
  group past the chat list's first page is listed once and opens as itself, and a
  `TELEGRAM_GROUP_IDS` entry naming a group by an earlier Telegram id finds that group.
- Merged with main's fixes that lose nothing
  ([ADR-0251](docs/adr/0251-fixes-that-lose-nothing.md)), on old-shaped and digest chats: a
  recalled note names its group and topic from the chat records, the group's name or its newest
  message under any Telegram id it has had, and a name only the owner's refresh gave counts while
  that refresh found the group, as main does ([recall](test/recall-places.test.ts),
  [store recall](test/store-recall-places.test.ts), [server](test/store-server.test.ts)); a live
  recording is judged in the chat the records find, so an allowed person is not cut in a group
  Telegram upgraded or in a new-id group, and a group the records do not know lets only the owner
  through ([sender](test/assistant.test.ts), [voice](test/store-voice-transcription.test.ts)); a
  member job spend notice and its Pause or Resume edit go to the owner's private chat where it is
  in Telegram now, name each group from the records, and are not sent while the records do not
  know that chat; only the owner's press there pauses
  ([spend](test/store-member-job-spend.test.ts)). Hermes's locked-down container still reads
  `GET /internal/chats` and writes nothing outside its two mounts.

  Checks on the integrated branch after merging main's fixes that lose nothing: the build; node
  unit and dashboard tests (566: 363 pass, 199 store tests skipped there, and the 4 workflow tests
  that also fail on main); all 95 store test files on old-shaped and digest chats (237 pass, 0
  fail); dashboard format; the dashboard browser tests (46: 44 pass, and the 2 settings-apply tests
  that also fail on main); Python Hermes (966, 4 skipped, with the 2 environment errors that also
  occur on main), Telegram (123) and tools (120, 2 skipped). The format gate's allowlist holds only
  adapter, legacy and unrelated sites.

  Before the merge, after the two full tester fixes, the whole full tester on the integrated
  branch (fake Telegram Bot API and model;
  real Telegram service, Hermes, Honcho and Inngest), in four rounds that each start with
  `group_members`, the private-chat check in the same round as the private-mark sweep: every
  scenario passes, those the two fixes above touch on a rerun after them, except `deleted_topic`,
  which fails the same way on main (the bot retries a one-off "thread not found" once by design,
  and the scenario injects only one). With `expand()` and `rawScopes()` changed to add every
  served group, `project_groups_stay_apart` fails, a group's task list showing another group's
  task; its search and answer gates still pass there, as a group's search reads each original only
  for its own chat, and `new_id_group_works_end_to_end`, which has no cross-group check, passes.
  Rollback on a fixture 2b-1 filled (a new-id group, an upgraded supergroup, their sends), with
  main's images on the same data: main's `group_members` and dashboard pages pass, and System ›
  Sent to apps lists every send record, those 2b-1 wrote included.

  After the merge with main, at 9ac8403, the whole full tester in one run on one fixture:
  `group_members`, then the tester's default order, which runs `group_members` again before the
  product scenarios because `granted_participant` replaces the allowed people (91 scenarios,
  dashboard pages and the drain check). 89 of 92 pass, `forwarded_messages_are_not_the_owners_words`
  and every privacy gate included. `deleted_topic` fails as on main. `inbox_never_asks_about_the_owner`
  and `memory_search_model_change_rebuilds_memory` time out only in that run: with every
  scenario's history on one fixture about 350 Hermes native note reviews queue, the person card
  came about 16 minutes after its messages (the wait is 10), and the Honcho memory rebuild was
  still replaying the archive when its 15 minutes ran out. A rerun of those two with
  `group_members` and the import passes (5 of 5). A second leak proof, a wrong `chat_ids` mapping
  (GP2's Telegram id recorded as an earlier id of GP1's chat, as a bad upgrade link would leave
  it, in the services image only): `project_groups_stay_apart` fails at
  `one_reply_in_exact_conversation`, the reply to GP2's message going to GP1, and on that fixture
  GP1's archive search returns GP2's mark, which `group_answer_uses_only_that_group` checks;
  `group_members` and `new_id_group_works_end_to_end` pass. After merging main's fix to the
  deleted topic check (#219), `deleted_topic` passes with `group_members` (3 of 3).

  After merging main's fixes that lose nothing, at cc46249, with the services, management,
  store-postgres and Hermes images rebuilt: one focused run on one fixture of the scenarios that
  merge or 2b-1 touches, in the tester's default order, `group_members` first and again before the
  product scenarios. It covers Hermes locked down, the private fact and recall, the PDF, voice, the
  long voice cut for someone not allowed, the photo read once, the large Files upload through
  Hermes's bound address, profiles, no refused writes, `deleted_topic`, the forward check, a note's
  recall naming its chat, the new-id group, the private-chat check, project groups, the supergroup
  upgrade, member job spend with its notice, pause and Resume, both approved operations' answers,
  the private-mark sweep and every dashboard page with Hermes's Chat, Sessions and Files pages.
  25 of 25 pass, the drain check included, with no product fix needed.
  Pending:
  - The full tester's waits for the person card (10 minutes) and the memory rebuild (15 minutes)
    are too short when every scenario runs on one fixture: raise them, or keep running it in
    rounds.
  - A live check after merge: that the first seeding on a real archive gives every stored chat
    value a row (no group, topic, task, rule or switch becomes unknown) and how long it took
    (the `ms` of the `chat_records_ready` log; about 23 s per 300,000 archived events in a
    local benchmark; the app's health check allows 120 s and `nocheh deploy` waits 180 s, after
    which the app keeps seeding and serves when done).
  - The rest of the rollback check, after redeploying main: reactions still work with numeric
    update ids (System › Sent to apps is checked above). A private answer offered under 2b-1
    then refuses (`only_asker`) until it expires within a day. Owner exports, reset snapshots
    and undrained send records made under 2b-1 do not read on main.
  - Owner question: a chat first seen under 2b-1 has a digest id, so after a rollback to main
    it is served by its Telegram id without its project, tool switches (an off switch reads
    on), rules, tasks, Answer privately or memories, until 2b-1 is deployed again; what main
    sets for it in between is then not applied. Recommended: keep the approved digest ids and
    accept this, as a rollback is for emergencies; the other choice keeps Telegram ids for new
    chats until 2b-2.
  - Live acceptance on the owner's install after merge, while Nocheh is idle (a turn in
    flight at deploy is refused once, then retried).
  Owner steps: small things you see change. Chats says "Telegram ID" (with the earlier one
  after Telegram upgrades a group) and "Unknown chat" for a chat Nocheh has no record of; a
  topic name you gave stays even
  after Telegram shows another, and removing yours brings Telegram's back; the chat picker no
  longer offers "Use the ID" for an id Nocheh has not seen, and searches say "name or Telegram
  ID"; a group's Topics card shows only for a forum or a group with topics already seen;
  asking Nocheh to
  post to a topic it has never seen is refused until a message there, or adding the topic in
  Chats › Topics by its link or number, makes it known (recommended: keep, it fails closed).
  A group Telegram upgraded before this step stays two chats, as it was; later upgrades keep
  one chat. Known limits: an upgrade whose new group's messages are captured a spool batch
  before both upgrade messages stays two chats; a package made after this step that names a
  group by its digest, imported where the first start already gave that group its old id,
  does not reach the group until adoption.

Security fixes: where memory comes from (owner, 2026-11-14: "all yes", approving the fixes of
the prompt-injection review with what each one loses; this is risk 5, "Other people's text
becomes your private memory"). One pull request of several commits
([ADR-0256](docs/adr/0256-nochehs-own-messages-carry-a-send-class.md),
[ADR-0257](docs/adr/0257-learned-memory-names-its-source.md)):
- Send classes: each message Nocheh sends carries a class, set where the send is decided and
  kept in its archived copy. Cards, card updates, refusals, notices and reminders are kept,
  searchable and context for the owner's reply, but not learned unless the owner turns
  learning on for one; replies, follow-ups, private answers, job reports, scheduled results and
  approved posts are learned. Nothing already in long-term memory is rebuilt
  ([classes](test/send-classes.test.ts), [workflows](test/learning-workflow.test.ts),
  [capture](test/store-generated-capture.test.ts), [Telegram](services/telegram/test_service.py),
  [sends](test/store-telegram-actions.test.ts), [reminders](test/store-tasks.test.ts)).
- People not allowed: a message from someone not allowed where they wrote, or a reaction to
  one, stays out of the owner's notes review and only there; group replies, group memory,
  interpretations and search keep it. A review drops such messages, rules learned from them
  and quotes of them from its context, and cuts such a message out of a pin of it; a later
  grant adds nothing back. A quote is judged by the message it answers even when the review
  holds nothing of it: another bot's message, or one Nocheh never got, by its author as the
  reply shows it, and one in another chat or topic stays only when the archive holds it and its
  sender is allowed there; a quote inside a pinned message is judged the same way, and cut
  when the archive never got the pinned message, which Telegram sends without its reply,
  counted as a quote that could not be traced (`quote_not_traced`), since no sender was
  refused. So is a
  quote inside a message another embeds (a poll or a checklist a service message shows), traced
  through that message as archived in the same chat: one quoting Nocheh's words is cut from
  everything learned, and so is one the archive can't trace (that message never archived,
  archived in a revision answering nothing, or archived only as Telegram Desktop exports),
  counted as a quote that could not be traced (`quote_not_traced`), whoever it quoted. One that
  keeps its reply to a message in another chat is judged there by that message, and cut and
  counted as not traced when the archive holds no revision of the embedded message to judge it
  by. A Telegram Desktop export's reply to another chat (`reply_to_peer_id`) gets no reply
  relation, since its id is that chat's, and the review never judges a quote by one an earlier
  export was given. A pin
  of Nocheh's own message is never counted as kept out: one it
  learns stays in the pin, and a card, notice or reminder is taken out of it, so a pin of a card
  with nothing else to review is not reviewed at all. Memory › Assistant
  notes counts what was kept out, and System › Background work shows the message's Memory notes
  step as Done with the reason under it, which its details show under "Note", as for every task
  that ended, not under "Waiting for"
  ([reviews](test/store-native-review.test.ts),
  [context](test/store-learning-engine.test.ts), [senders](test/assistant.test.ts),
  [workflows](test/store-workflows.test.ts)).
- Labels: every note carries a label built by code from Hermes's own record of who wrote it
  and what that run read, made when the note is read. "You" only for a review of nothing but
  the owner's own messages that cites them and reads no rule but those the owner wrote (a rule
  learned automatically, even from the owner's own messages, can restate others' words); a
  turn's note never. A quote of a message in another chat or topic is never the sender's own
  (in a forum topic Telegram also points the reply at the topic's first message), and a
  Telegram Desktop export's message is a forward when it carries any of its forward fields. A
  checklist others can add tasks to, and any checklist edited, pinned, quoted or forwarded, is
  never the sender's own typing: Telegram names no one per task, and the owner can stop sharing
  one after others added tasks; only in the owner's private chat with Nocheh, where no one else
  can add tasks, does the owner's own stay the owner's. A poll someone else added an option to, a
  deleted option (except one from the owner's own poll in the owner's private chat), a message
  embedding someone else's or one quoting a message, and a Desktop export's checklist or poll
  are read the same way. Each is labelled as a pin or quote of someone else's message, or as a
  message holding someone else's words (no pin claimed), and the owner's pin of such a message
  of their own as a message holding someone else's words that the owner pinned, and still
  learned. A
  rule is judged by the messages code recorded it was learned from, never by what the model
  cited, and rules resting on others' words label the note as theirs; only a review
  holding someone else's words reads them, as a review of Nocheh's own learned messages, alone or
  with the owner's own, leaves them out. A pin carries the words of the message it pinned, and
  the owner's quote or pin of Nocheh's own learned message counts as Nocheh's. A turn's reads
  count a search by meaning as other chats and an earlier read in its session only when the note
  copies from it. A forward of the sender's own message is never a read in the message the turn
  answers; earlier in the session only the owner's in their private chat is skipped, so any other
  own forward counts, the owner's own in a group or in a private answer carried from one included
  (it fails closed).
  The model reads fixed words beside the unchanged note, with a fixed sentence on what they
  mean, and `from=nocheh` is not the owner's own words; the owner reads editable words ("Note
  sources on the Notes page") under each note; each recalled note carries its own source. Each
  review carries a records line in fixed words. Every failure to record or look up a label, to
  read a turn's messages, or to read the forwards block, in Hermes or in storage, is counted per
  day into the owner's problem notice, which says what the owner sees while it fails; storage
  writes a step that worked only after that day's failure of its kind, so steady use writes nothing,
  and its failures are lines of their own, apart from Hermes's, so one side working never clears
  the other's
  ([facts](test/source-facts.test.ts), [labels](test/source-labels.test.ts),
  [route](test/store-note-sources.test.ts), [records](services/hermes/test_note_sources.py),
  [evidence](services/hermes/test_memory_evidence.py), [recall](test/recall-places.test.ts),
  [notices](services/hermes/test_monitoring.py), [notice lines](services/hermes/test_problem_notices.py),
  [turns](services/hermes/test_turn_process.py),
  [status](test/store-server.test.ts), [health](test/dashboard-system-health.test.mjs)).
- Long-term memory: one peer that is not a person writes the owner's forwards and files.
  Someone else's forward goes to the owner's own forwards session, with a fixed pointer left
  in the chat; file and audio text is a second record in the same chat session; the owner's
  forwards and files in a group stay in that group's session. Someone else's message the owner
  pins is kept as a forward is. A quote of any of Nocheh's own messages, by anyone, is learned
  as the sender's words without it, in learning too, where the owner's quote of a learned one
  stays direct; a pin of any of Nocheh's own messages, by anyone, an anonymous admin included,
  leaves only a pointer in the chat where it was pinned, and nothing learned reads a pinned card.
  Nocheh's own account's message the archive does not hold as Nocheh's learned one (its
  delivery not archived yet, or a forward of Nocheh's message), told by an equality check with
  the bot the update came to (`events.bot_id`, `isBotAccount`), is cut from a pin or quote the
  same way, also from a quote of a reply in another chat or inside a pinned message, and its
  pin leaves the same pointer. Only Nocheh's own words are cut: another bot's message is
  learned labelled as someone else's (the owner's pin of it kept with the forwards and files),
  and a message sent through an inline bot, which its sender wrote, is labelled as sent through
  an inline bot. The owner's quote of their own forward quotes whoever wrote it, never the
  owner's own words. A card the owner replies to stays context of the reply (ADR-0256). In
  learning the owner's pin of Nocheh's learned message, and the owner's pin or quote of a card
  or of Nocheh's message not archived yet, passes nothing on, so the owner's claims beside it
  can stay direct; a claim citing the pin or quote never is. A pin of only a card, or of only
  Nocheh's message not archived yet, asks no interpretation or notes review either. A pinned
  message's own reply (a poll or a contact it answers in another chat) is never learned with
  the pin. A message another embeds (the checklist a service message reports on, a giveaway's or
  a suggested post's message, the poll an option was added to), found by shape alone so a field
  Telegram adds later is found too, is kept and labelled, not cut: only Nocheh's own words in it
  are cut, and in the owner's notes review one from someone not allowed there, a poll option
  such a person added and a deleted option's text are cut out by place and counted, while
  interpretations and long-term memory keep them. Owner
  turns read the forwards block apart from the owner's, and
  recall asks it; when that ask fails, recall keeps the other answers and says so, and
  answers stay whole under their headers within 20,000 characters. A claim resting on a
  forward, a file, a pin or someone else's message is reported or inferred, never direct.
  Messages already learned keep their form, also after a rebuild retired their writes
  ([memory](test/store-native-memory.test.ts), [entities](test/store-entities.test.ts),
  [engine](test/memory-engine.test.ts)).
- Full tester: `not_allowed_group_text_stays_out_of_owner_notes`, `display_name_cannot_borrow`,
  `forward_kept_apart_and_labelled` and `own_file_stays_recallable`, and new checks in the
  not-allowed reply, forwarded message, member card, reminder, notes, job report, document,
  photo and voice scenarios. Since the tester's Honcho answers from the deterministic model,
  `own_file_stays_recallable` checks that recall asked the forwards participant, got its answer
  and that this participant holds the file's text. Both scenarios check that only that
  participant's conclusions about itself hold the private mark, and ask which block holds it
  by its number only, since a question holding the mark is the owner's own words, learned about
  the owner ([forward reads](test/test_forward_memory_reads.py)). Every check that can wait
  behind the owner's notes reviews (a review, a message's notes and memory steps settling, an
  import's review steps)
  waits up to 40 minutes, stops at once when the review it waits for was paused or stayed
  uncertain after Nocheh gave up observing it (8 looks, read from the code), and on a timeout
  names how many reviews still waited, or says that count is unknown. The
  tester's Honcho takes the real setup's query and input limits and asks its model for answers
  as the real setup does, `json_object` at every dialectic level, from the same settings code
  ([scenarios](tools/acceptance/product_scenarios.py), [brain](test/test_scripted_brain.py),
  [waits](test/test_product_review_waits.py),
  [rehearsal](tools/acceptance/rehearsals/installation-rehearsal.py),
  [tester Honcho](test/test_installation_rehearsal.py)).

  Nothing real lost: everything is still learned somewhere, and what leaves the owner's notes
  or the owner's long-term memory block stays in the archive, search and group memory, or in
  the forwards block. Checked: the type check and build; the unit tests (the 4 workflow tests
  that need Postgres fail, as on main); the store suite in the Docker fixture (all 97 files);
  the Telegram, Hermes and tester Python checks (Hermes's two environment-only errors, as
  before); the dashboard tests and format check; and Honcho v3.6.0 makes no embeddings call
  for the extra reads. After the review's fixes: the store files they touch, the unit tests,
  the whole Hermes suite, the Telegram checks and the dashboard checks again. After the second
  review's fixes (pins and quotes of Nocheh's own messages, the owner-and-Nocheh rule leave-out,
  counting a success only after a failure, the "Note" heading, a member's own forward in earlier
  rows, the tester's checks): the build; the unit tests (the same 4 fail); the dashboard tests
  and format check; the store files they touch (note sources, reviews, entities, long-term
  memory, status, forwards); the whole Hermes suite (its two environment-only errors); the
  tester's Python tests and the Honcho setup test. After the third review's fixes (Nocheh's cards
  out of every pin and quote, a pin of only a card not reviewed, the owner's pin or quote of
  Nocheh's message passing nothing on in learning, the stores' notice lines apart, one helper for
  the tests that read a Python file, every review wait, the tester's Honcho answers, where the
  owner's own forward is skipped): the build; the unit tests (the same 4 fail); the dashboard
  tests and format check; the notice, note-source and tester Python tests; the Honcho setup tests
  and the docs test. After the fourth review's fixes (a bot's words cut from a pin or quote whose
  message the archive does not hold as Nocheh's, a quote inside a pinned message, an anonymous
  admin's pin of Nocheh's message, the owner's pin or quote of a card passing nothing on, no
  interpretation for a pin of only a card, review waits that stop only at a review given up, the
  stores' notice line naming replies): the build; the unit tests (the same 4 fail); the dashboard
  tests and format check; the store files that read pins and quotes (reviews, long-term memory,
  entities, learning, note sources, relationships, retrieval, actions, workflows); the notice
  Python tests and every test/test_*.py. After the fifth review's fixes (only Nocheh's own
  account's words cut, told by `events.bot_id`, so another bot's and an inline bot's text is
  learned again as someone else's; the owner's quote of their own forward never the owner's
  words; a pin of only Nocheh's message not archived yet neither reviewed nor interpreted): the
  build; the unit tests (the same 4 fail); the dashboard tests and format check; the store files
  they touch (note sources, reviews, long-term memory, entities, learning), each new check also
  run without its fix and failing. After the sixth review's fixes (a quote in another chat or
  topic never the owner's, a Desktop export's forward by any of its fields, a review of only the
  owner's messages reading only the rules the owner wrote, a pinned message's own reply not
  learned, a quote of another bot's or of an unarchived or outside message judged in the
  owner's notes review): the build; the unit tests (the same 4 fail); the dashboard tests and
  format check; the reviews store file and those that read the same paths (long-term memory,
  note sources, relationships, the rule catalog); the sweep's probes; each new check also run
  without its fix and failing. After the seventh review's fixes (messages a message embeds left
  out of what is learned, by shape; a checklist that may hold others' tasks never the owner's;
  a quote inside a pinned message judged in the owner's notes review): the build; the unit tests
  (the same 4 fail); the dashboard tests and format check; the reviews store file and those that
  read the same paths (long-term memory, note sources, learning, entity suggestions); the
  sweep's four probes; each new check also run without its fix and failing. After the eighth
  review's fixes (a message another embeds kept and labelled instead of cut, judged by its author
  in the owner's notes review; a poll others added options to, or an option deleted, never the
  owner's; the owner's forward of a checklist shown again; a Desktop export's checklist or poll
  never the owner's; the owner's checklist in the private chat the owner's own): the build; the
  unit tests (the same 4 fail); the dashboard tests and format check; the reviews store file and
  those that read the same paths (long-term memory, note sources, learning, entity
  suggestions); the sweep's probes; each new check also run without its fix and failing.
  The ninth to eleventh reviews' fixes (a quote inside a message another embeds judged, and cut
  as `quote_not_traced` when nothing traces it; the owner's own deleted poll option in the
  private chat the owner's own; a pin of the owner's message holding others' words worded as
  such; a quote traced through every revision; a Desktop export's reply to another chat never
  linked to this chat's message with the same number) were each checked the same way, with a
  field-by-field sweep of every Telegram message field finding nothing labelled as the owner's
  that the owner did not type. Final checks on the last code: the build; the unit tests (the
  same 4 fail); the dashboard tests and format check; the whole store suite (the 4 files that
  fail on main fail, every other file passes); the Hermes (its two environment-only errors),
  Telegram and tester Python tests; the cloud tester's memory scenarios (group members, people
  not allowed, display names, forwards, files, forwarded commands, tasks and reminders, the
  owner's review, background jobs, native notes, the fixed reply, private chat out of groups,
  import with learning, the search model change, the private marks sweep, nothing left running
  and every dashboard page), all passing; the forward and file scenarios now ask which block
  holds a forward by the mark's number, since the owner's own question carrying the mark was
  learned as the owner's in a race. Pending: the private names scan at push; a live look at a
  labelled note, a forward and a skipped card on the owner's install after merge. Open owner
  question: whether the message of someone not allowed that the owner replies or reacts to
  should come along as labelled context for the note (built without it, as the rule says, until
  the owner answers). Left for later: labels on search hits (done by ADR-0261 step 1); a dashboard page for one message's
  learning setting; web-chat replies carry no class; no test covers Hermes counting a missing
  forwards block; a rule's recorded inputs are not checked against who is allowed there, only
  the messages it cites; an earlier read a turn restates in its own words is not counted;
  `canLearn` checking the chat is served before the owner's yes (step 4 does it for private chats
  that are not the owner's, [ADR-0262](docs/adr/0262-member-private-chat.md)); a pin or
  quote handled before Nocheh's own message is archived, or after its capture failed, is labelled
  as someone else's (it fails closed), and its words, Nocheh's own account's, are cut from
  everything learned, except where the stored bot is not an account (an import), where it is
  learned as someone else's; a forward of Nocheh's message sent on its own is learned as a
  forward from a person shown as Nocheh, someone else's, card or not; a task someone not allowed
  there added to a shared checklist reaches the owner's notes review when the checklist is shown
  again or carried by a service message someone allowed sent, labelled as someone else's words,
  since Telegram names no one per task; a poll option Telegram shows with no adder is read as the
  poll's own; a rule
  learned automatically from the owner's
  messages can restate others' words, and a review of the owner's and Nocheh's own messages
  reads it as Nocheh's; a quote of Nocheh's message is cut whole, so the notes review and
  interpretations no longer see which part was quoted; Hermes's own notes line adds up its own
  steps, so a lookup that works can mark a record failure working again; on deploy day today's
  store failures show once more as their own line; the owner's own forward in a group, or in a
  private answer carried from one, counts as a forward read in later turns of that session, so
  their notes read as having read a forward (it fails closed). Owner steps: none. Notes from
  before read "Source not recorded" until the next fresh notes; Nocheh's cards and reminders no
  longer show up in what it learned; Memory › Long-term › Re-run says that replacing long-term
  memory from saved messages learns them by today's rules.

Security fixes, part 2: fixes that lose nothing (owner, 2026-11-14: "all yes"). One pull
request with seven fixes, each built and reviewed on its own
([ADR-0251](docs/adr/0251-fixes-that-lose-nothing.md)):
- Hermes runs with a read-only root, a 1 GiB memory `/tmp`, no capabilities and no new
  privileges, and mounts only the folders it writes, never the dashboard's token or the rest
  of the spool. Mounted folders are made at 0700 first, also on restore. On-first-use
  installs stay on. A file read that fails for a full `/tmp` or a refused write is counted and
  gives a notice ([compose](services/hermes/test_service_catalog.py),
  [readers](services/hermes/test_document_text.py), [notices](services/hermes/test_problem_notices.py)).
- Backups keep a workspace's links as links, skip special files, leave out and list what a
  command made unreadable, and every backup or off-site copy that fails, is skipped or leaves
  something out gives a notice ([backups](services/hermes/test_operations.py),
  [schedule](services/hermes/test_backup_schedule.py), [off-site](services/hermes/test_offsite.py)).
- A photo is read once, at its largest size ([archive](test/archive.test.ts)). Every recording
  is transcribed whole, whoever sent it; the 15-minute cap for people not allowed was removed
  by [ADR-0264](docs/adr/0264-groups-are-read-whole-from-everyone.md)
  ([voice](services/hermes/test_voice_text.py), [preparation](test/store-voice-transcription.test.ts)).
- Member jobs are capped to the cent; a daily notice mark and a holding pause mark
  ([spend](test/store-member-job-spend.test.ts), [jobs](test/store-background-jobs.test.ts)).
- The sharing filter sees only the search words; sharing and Notion texts say what they do;
  recalled notes name their chat ([sharing](test/store-sharing.test.ts),
  [recall](test/recall-places.test.ts)).
- An AI finding never masks request structure, and a finding from a batch of several texts
  is shared only once a check of that text alone confirms it
  ([detection](test/store-prepared-context.test.ts), [copies](test/guarded.test.ts)).
- Hermes's pages get a Report-Only script policy, the database viewer a login, and sign-in
  pauses count per person ([dashboard](test/dashboard-boundary.test.ts),
  [viewer](services/hermes/test_database_viewer.py), [sign-in](test/mini-app.test.ts)).

  Unit, dashboard, store (525 in the fixture) and Hermes Python checks pass. The cloud tester's
  new and affected scenarios pass: the locked-down Hermes, a large upload, documents, photos,
  voice notes and the 15-minute cut, member job spend, recall labels, secrets, private marks and
  every dashboard page. Pending: a look on the owner's install after the update. Owner steps:
  run `./bin/nocheh db` once if the database viewer was running; the browser then asks for its
  login.

Security fixes, part 1: cards and forwarded messages (owner, 2026-11-14: "all yes", approving
the fixes of the prompt-injection review with what each one loses). One pull request, the
first of several; each later part waits for its own review
([ADR-0250](docs/adr/0250-cards-and-forwards-say-whose-words-they-are.md)):
- An operation's summary is labelled "AI says:" by code, also on a saved template. A web
  read's address shows open up to 300 characters; a longer one shows its start, how many more
  characters it carries, and folds; so does the address of another server's tool, above any
  fold. That tool's card says how many characters of input it sends to which site, and folds
  an input over 300 characters under a summary. Notion cards are unchanged
  ([cards](test/action-text.test.ts), [buttons](test/store-approval-buttons.test.ts)).
- Job cards show title, instruction and plan one character at a time, with a hidden
  character written out where it stands and Persian half-spaces kept; group, topic and job
  names on every card too. A job with a direction override or a stray tag character is
  refused. A job card in another chat than the one it was asked in says where it was asked,
  and the machine and plan lines say the plan guides the job but does not limit it
  ([jobs](test/store-background-jobs.test.ts), [machines](test/store-machines.test.ts),
  [texts](test/prompts.test.ts)).
- A forwarded or inline-bot owner command never runs and gets a fixed answer. A forwarded
  message's turn starts with Nocheh's own line on where it came from and that its text is
  information, not the sender's request, also among the recent group messages. Text cannot
  write a look-alike of Nocheh's own lines, even with invisible characters or wide letters
  ([forwards](test/forwarded.test.ts),
  [commands](test/store-telegram-actions.test.ts), [turn](test/store-telegram-dispatch.test.ts),
  [Hermes](services/hermes/test_turn_process.py)).

  Unit, store (in the fixture) and Hermes Python checks pass, and the cloud tester's card,
  forwarded message, group card, recent message, background job and machine job scenarios
  pass. Pending: a live look at a forwarded message and a web card on the owner's install. Owner steps: a
  forwarded `/approve` now gets "Forwarded commands are ignored"; type it or use the card.

Security fixes: sends and reminders (owner, 2026-11-14: "all yes", approving the fixes of the
prompt-injection review with what each one loses; this is risk 3, "Approved sends can go to any
chat", and risk 9, "Member reminders reach your private chat"). One pull request on the chat ids
branch ([ADR-0254](docs/adr/0254-sends-go-only-to-chats-nocheh-serves.md),
[ADR-0255](docs/adr/0255-reminders-say-who-set-them.md)):
- Sends: Nocheh sends only to the owner's private chat and its topics, the selected groups and
  their topics, and the private chats of people the owner allowed in those groups, a person's
  private chat always behind the owner's card. Any other chat, or one Nocheh has no record of,
  is refused alike with `destination_not_served` at the proposal and at system sends, closed
  unsent at the approval and before the run, and refused by the app's check the bot asks
  before each message; the model is told the owner can serve it on the Chats page. A send
  closed unsent says why on its card, in its button answer and in `/approve`. A scheduled
  result held back for its chat or a settings change, a schedule that cannot run in a chat
  that is not served, and a job report whose chat is no longer served each send the owner one
  notice ([destinations](test/served-destinations.test.ts),
  [sends](test/store-telegram-actions.test.ts), [schedules](test/store-scheduled-runs.test.ts),
  [jobs](test/store-background-jobs.test.ts), [tools](test/mcp.test.ts),
  [broker](test/store-security-broker.test.ts)).
- Cards: the kind of chat in fixed, editable words and only the name quoted, inside quotes and
  isolates code adds, with quote, bracket and angle look-alikes made plain; a person's chat
  names the group the owner allowed them in and links their profile; a name that reads like
  another's gets its project on the owner's cards, or its short ID, which the Chats page
  shows too; "(not served now)" after a group Nocheh no longer serves; the message shows its
  hidden characters. A saved text line that drops a value Nocheh fills in is refused
  ([labels](test/chat-labels.test.ts), [cards](test/store-approval-buttons.test.ts),
  [card text](test/action-text.test.ts), [texts](test/prompts.test.ts),
  [Chats page](test/dashboard-chats-model.test.mjs)).
- Reminders: each reminder records who set it and where. One set, or on a task written or
  closed, anywhere but by the owner in the private chat or the dashboard starts with fixed
  lines naming who and where, before anything a person wrote, and a person's notes are marked
  line by line. A person's list never removes the owner's reminders, and each editor keeps up
  to 10 of their own. People's reminders due together in one group come as one message, at
  most one per group every 10 minutes, none dropped; the owner's come at their time. Cuts keep
  whole characters, so notes that end inside an emoji no longer stop every later reminder; one
  Telegram refuses shows as Not sent and in System › Health. The drawer shows who set each
  reminder ([reminder texts](test/task-reminder-text.test.ts), [tasks](test/store-tasks.test.ts),
  [export](test/store-owner-portability.test.ts), [Health](test/store-chat-sends.test.ts),
  [pages](test/dashboard-pages.browser.mjs)).
- Full tester: `send_to_stranger_refused`, `send_to_unselected_group_refused`,
  `send_to_allowed_person_private`, `member_reminder_says_who_set_it` and
  `reminder_with_split_emoji_arrives` ([scenarios](tools/acceptance/product_scenarios.py)).

  Nothing lost: every send that works today goes to a chat Nocheh serves, the owner's own
  reminders keep their time and text, and nothing is capped or dropped. Checked: the type
  check; the unit tests (281 pass; the 4 workflow tests that need Postgres fail, as on main);
  the dashboard browser tests (50 of 50); the store suite in the Docker fixture (619 pass; the
  4 files that fail on main fail the same way); and the cloud tester's new and affected
  scenarios. Pending: a live look at a send card and a merged reminder on the owner's install
  after merge. Left as they were, for later: a member's job still running when its group is
  deselected ends with `job_not_permitted` and no notice; `/approve` reads an action before
  deciding it, so a proposal changed in between answers as already decided; and the bot, while
  it starts, answers "not connected" before it looks for the receipt of a message it already
  sent (reminders now allow for that; the bot could look first). Not built, as approved: a cap
  on pending reminders per group, a daily reminder cap, and a copy of the send check in the
  bot. Two behaviour changes are built as the review recommended, for the owner's review: the
  owner's reminders on a task a person finished, archived or trashed are sent, saying who
  closed it (the owner's own closing still skips them); and a message from the owner in a group
  that removes reminders set elsewhere sends the owner one notice. Owner steps: a message to a
  chat Nocheh does not serve is refused; select the group, or allow the person in a selected
  group, on the Chats page. Send cards read "group “…”", "› topic “…”" and "private chat with
  “…” (a person you allowed in group “…”)". Reminders people set arrive with a "👤 Set by" line,
  merged per group; their wording is in Settings › Assistant under "Reminder lines: who set it
  and where".

Members step 2: projects and the private button (owner, 2026-11-12: "I just review the
tables and seems what I want if there is a important point or need my answer ask, else start
build.", approving the Members design; 2026-11-13: chose "Keep them, yours only" when asked
whether the owner's own sharing tools stay). One pull request in four parts:
- Projects replace the share box ([ADR-0247](docs/adr/0247-projects-replace-the-share-box.md)):
  a group answer uses only that group, for everyone. The project share box, its modes, "Don't
  share into this chat" and "Set by project" are gone, and project rules are deleted at start,
  not converted. The owner's own sharing rules and fact grants stay, yours only, and the rule
  dialog names the group that will see the result. A topic always follows its group's
  project, and automatic organizing only creates projects: every move waits in the Inbox.
  Wherever a group joins a project, the dashboard names the project's other groups first,
  with the private-answer note, then says the group will see and change the tasks set on the
  whole project, never another group's own tasks. Turning Nocheh on in a group asks which
  project it joins, or none, and in a group already in a project names its other groups first
  ([projects](test/store-projects.test.ts), [sharing](test/store-sharing.test.ts),
  [organization](test/store-knowledge-management.test.ts),
  [reset](services/hermes/test_reset_configuration.py),
  [dashboard](test/dashboard-pages.browser.mjs)).
- Tasks follow data access ([ADR-0248](docs/adr/0248-tasks-follow-data-access.md); owner: "task
  access and edit should behave like data access for project and groups. user Bob can
  manage(crud) other tasks that are for project1 or all joined groups."): in a project, a group
  or topic sees and manages only its own group's tasks (its topics' too when they share what
  they know) and the tasks set on the project itself, never another group's task, count, tag,
  link, parent or history. A task added there belongs to that chat unless it is set on the
  whole project; a subtask has its parent's group. The owner's card, the dashboard and the
  mini app name exactly who will see a task before a move or a group change. A group's tasks
  move with it to another project, through the owner's assignment, an approved organization
  and its undo; leaving every project leaves them on the old list for the owner only. A
  group's own move, archive or trash takes only the tasks under it that the group sees;
  another group's task under them stays where it is, no longer under it
  ([store](test/store-tasks.test.ts), [moves](test/store-knowledge-management.test.ts),
  [card lines](test/prompts.test.ts), [audience route](test/mini-app.test.ts),
  [dashboard](test/dashboard-pages.browser.mjs)). Tasks that groups added before this keep
  their group and are now seen only by it.
- Answer privately, the read side ([ADR-0249](docs/adr/0249-answer-privately.md)): a private
  answer reads the groups frozen in its record when the button is tapped (the asking group
  and the project's other served groups). A later change in the project only narrows or
  closes it. It reads by search, page and plain long-term memory search only, plus the
  frozen groups' tasks and their project's, gets what the owner's rules and grants let into
  the asking group, reaches read routes and read tools only, opens no group's original file,
  runs in its own profile, removed once unused for two hours, and is delivered only into the
  asker's private chat. Stale rows
  expire hourly, and the owner lists the record at `GET /v1/private-answers`
  ([record](test/store-private-answers.test.ts), [routes and tools](test/private-answers.test.ts),
  [memory](test/store-provenance.test.ts), [profile](services/hermes/test_scopes.py)).
- Answer privately, the button ([ADR-0249](docs/adr/0249-answer-privately.md)): under the
  owner's own answer in a group or topic whose project has another served group, a 🔒 Answer
  privately button. Only the owner's tap works; anyone else's gets a short popup and nothing
  runs. `/start <id>` in the private chat answers read-only from the groups frozen at the tap,
  with the project's role, else the groups default. An answer that never arrives closes its
  record, and one closed mid-answer sends the changed or expired text once. Texts are
  editable in Settings › Assistant, and a project's page lists its buttons
  ([button](test/store-private-button.test.ts), [bot](services/telegram/test_service.py),
  [dashboard](test/dashboard-pages.browser.mjs)). The full tester's `project_groups_stay_apart`
  carries the step's gates: the group answer uses only its group, a group's task view never
  shows another group's task, and the button, the tap and the private answer
  ([scenario](tools/acceptance/product_scenarios.py)).
- Review follow-ups, decided by the owner's standing rule to take the recommended answer on
  small product polish: removing a group from a project, or choosing "No project", asks
  first and says its tasks, its topics' too, stay on that project's list, where only you see
  them, and moving a group to another project says they move with it
  ([dashboard](test/dashboard-pages.browser.mjs)); turning automatic organizing on is what
  lets it create projects, and the "May create new projects" switch, which did nothing when
  off, is gone (its column dropped at start, a delegation saved with it kept, an older export
  still restores) ([organizing](test/store-knowledge-management.test.ts),
  [exports](test/knowledge-portability.test.ts)); Memory › Notes names a private answer's
  profile by where it was asked, as its first line names it, and the day it ran
  ([button](test/store-private-button.test.ts), [listing](services/hermes/test_management.py),
  [receipt](services/hermes/test_turn_process.py)). Recorded decision: a topic's tasks left
  on another project's list at the upgrade stay there, where only you see them (fails
  closed).

  Build, unit, store, dashboard, browser and Python checks pass, apart from failures that also
  fail on main, and so do the step's 29 full-tester scenarios on the fake Telegram (the ones
  on projects, tasks, sharing and approval buttons; `group_members`,
  `project_groups_stay_apart`, `private_chat_stays_out_of_groups`, the private-mark sweep and
  `dashboard_pages` again after the review follow-ups). `project_groups_stay_apart` fails on a
  build that lets a group turn read every group of its project: at
  `group_answer_uses_only_that_group` when its search does, and at
  `group_task_view_never_shows_another_groups_task` when its task list does. Pending:
  - the whole full tester as a release run;
  - live checks only a real phone can answer: whether each Telegram client (iOS, Android,
    Desktop, Web) sends `/start <id>` by itself when the private chat with the bot already
    exists, whether Telegram accepts the tap's `t.me/<bot>?start=<id>` link in
    answerCallbackQuery, and how fast the tap's popup and the private answer arrive;
  - live acceptance with two groups in one project on the owner's install;
  - before merging, a read-only check on the owner's install for any project with the share
    box on (`SELECT count(*) FROM projects WHERE sharing_enabled`);
  - a fake-Telegram end-to-end test of the button (`services/telegram/test_simulation.py`),
    not written.
  Owner steps: a project that had the box on stops sharing at the next start, and its project
  rules, their previews and texts not yet said are deleted. Every move of a group into or out
  of a project now waits for your review, and a topic that had its own project follows its
  group, also onto that group's task board; its tasks on another project's list stay there,
  where only you see them. An owner export from before this change restores without the
  share box: its project rules are left out and a topic's own project becomes its group's.
  An automatic-organizing permission that is on may now create projects even if its old "May
  create new projects" switch was off; turn it off in Memory › Projects if that is not wanted.

Members step 1: keep the owner's private side out of groups (owner, 2026-11-12: "I just
review the tables and seems what I want if there is a important point or need my answer ask,
else start build.", approving the Members design). One pull request in three parts:
- Private chats stay out of group sharing: only groups and their topics share, are shared
  with or join a project. Owner rules, project assignments, organization, agent proposals
  and reset snapshots refuse a private chat, and sharing skips one that an older row still
  names (the Sharing page says "Reads a private chat. Nocheh skips it."). Suggestions never
  come from or go into a private chat. One-time approval posts the wording once, now;
  automatic follow-up starts off, and a lasting share posts only when the owner ticks it.
  Grants go only to groups and topics, and a fact from the owner's chat is shared only after
  a confirm that names that chat. Every card and editor says where a fact came from and who
  will see it ([ADR-0242](docs/adr/0242-private-chats-stay-out-of-group-sharing.md),
  [projects](test/store-projects.test.ts), [memory access](test/store-memory-access.test.ts),
  [follow-ups](test/store-memory-followup.test.ts),
  [audience](test/store-entity-owner-corrections.test.ts),
  [reset](services/hermes/test_reset_configuration.py)). An existing install keeps its saved
  `auto_followup=true` until the owner turns "Answer right after I approve" off. Grants
  already made on private-source facts pause until the owner shares them again with the
  confirm. Older rules and organizing that name a private chat can still be turned off, and
  older proposals still open to be rejected. A reset stops before erasure while a rule or
  project still names a private chat ("Remove it" on the chat's page, or edit the rule).
  Pending: a check on the owner's live install.
- Project task boards (items 8 and 4b; owner: "task access and edit should behave like data
  access for project and groups"): a project's chat sees a task only as it is on that
  project's board, from when it joined, with only the columns the owner shares, and its edits
  keep what it cannot see; from the owner's private chat, a change those chats would see waits
  for a card that names them, and a move into a list from the dashboard or mini app names them
  first. Only the owner moves a chat into a project with tasks: automatic organization waits
  for review, and the review, "Add a group" and a group's project choice say what the group
  will see and change on the list (since step 2, the tasks set on the whole project) ([ADR-0243](docs/adr/0243-project-boards-get-the-private-side-only-through-a-card.md),
  [store](test/store-tasks.test.ts), [organization](test/store-knowledge-management.test.ts),
  [columns](test/task-settings.test.ts), [dashboard](test/dashboard-pages.browser.mjs)). As the owner confirmed on 2026-11-13
  ("Yes, small changes skip it"), a private-chat change to a listed task that only sets status,
  priority, start and due days and times, archive or trash, or takes it off every list,
  applies without a card; repeat and reminders wait for the card (fail closed), and the chat
  tool sets no order. Pending: live acceptance with a real project group, and task cards in
  the dashboard Inbox (decided in Telegram only). The item 11 full-tester canary builds on
  this.
- Owner defaults, group posts and machine reports stay private
  ([ADR-0244](docs/adr/0244-owner-defaults-posts-and-machine-reports-stay-private.md)):
  with "Do what I ask", a post the owner asks for in the private chat for any group or
  topic still waits for its card there ([check](test/store-owner-autonomy.test.ts),
  [cards](test/store-approval-buttons.test.ts)); the private chat and groups have their
  own default role and skills, and the one for groups starts empty
  ([check](services/hermes/test_persona.py)); a machine job reports to the private chat
  and the group that asked gets one line ([check](test/store-machine-group-report.test.ts));
  the owner ID is never a person in a group and, once saved, changes only with
  `config set` ([check](services/hermes/test_configuration.py)). Unit, store, dashboard
  and browser checks pass, and so do the step's full-tester scenarios
  (`owner_freedom_keeps_group_cards` included) and its canary gate, which finds no private
  mark in a group's model requests, answers or Telegram messages and fails on a build that
  lets a group read the owner's jobs. Pending: the whole full tester as a release run.
  Owner step: groups lose the role and skills of the old shared default until you fill in
  "Role and skills in groups" in Settings › Assistant.

Production move (owner, 2026-10-28): Nocheh moves to an always-on server as a
clean install once the MVP checks pass (stuck notes-review fix, full tester on
main, one clean day of use); dev-mode rules end at the move. Daily automatic
backups come first ([ADR-0187](docs/adr/0187-daily-automatic-backups.md));
pending: a live scheduled backup on a running installation.
Off-site copies (owner, 2026-11-10: "start build"): encrypted copies of each automatic
backup go to the owner's own S3-compatible storage
([ADR-0229](docs/adr/0229-encrypted-off-site-backup-copies.md),
[tests](services/hermes/test_offsite.py)); pending: a first live copy, a passed "Test the
off-site copy", and a fetch and restore on another machine. Setup connects from one
pasted Cloudflare token or Backblaze key (owner, 2026-11-11: "it should configable and can
use cloudflare connect/login or better way"; chose one Cloudflare token plus a storage list;
[ADR-0236](docs/adr/0236-off-site-storage-from-one-pasted-credential.md),
[tests](services/hermes/test_offsite_connect.py)); pending: a first live connect against a
real Cloudflare account. The portable export now
carries the owner's tasks, sharing rules, settings and Hermes scheduled jobs
([ADR-0230](docs/adr/0230-portable-export-carries-owner-work.md),
[check](test/store-owner-portability.test.ts)); pending: a full export and import between
two running installations.

Several workspaces on one machine (owner, 2026-11-12: "start build", step 0 of the
members design): each workspace, `personal` and one per company, is its own installation
in its own folder with its own data, bot, dashboard and backups. Its name, set at setup
or changed with `workspace rename` (owner, 2026-11-13: "my current will be name test/dev"), decides its Compose project, networks, volumes, images, ports, off-site folder and
dashboard sign-in; `personal` keeps the old `nocheh` names. Setup refuses another
workspace's name, ports, bot, mini app address or tunnel. `workspace new`, `workspaces`
and `update [NAME|--all]` manage them, and the setup guide shows Docker's address-pool fix
([ADR-0245](docs/adr/0245-several-workspaces-on-one-machine.md),
[tests](services/hermes/test_workspaces.py)). Pending: two workspaces running side by
side on one machine, each with its own bot, and an `update --all` across them.

Problem notices (owner, 2026-10-28: "I want notice about each failed and issue to
can fix it in MVP"): the dashboard checks every two minutes and sends the owner's
private Telegram chat new or worse problems, including model refusals and texts
the secret check hid; Health and Usage show refusals. Live since 2026-10-28.
Notices carry Open (mini app Health page, else the dashboard address) and Retry
failed buttons (owner, 2026-10-28: "better to have action btn for errors to
dashboard or directly action, also better to open in mini app"). Failed model
calls keep a reason code, and notices and Health say why they failed (owner,
2026-10-29: "all yes" to keeping failure reasons). They also keep the provider's
exact error as codes, such as overloaded with HTTP 529, and say it (owner,
2026-11-08: "yes fix it" to keeping the exact error for clearer notices;
[record](services/hermes/test_usage.py), [notice](services/hermes/test_problem_notices.py)).
A run Hermes stopped itself (`loop_error`) is named by its stop and not called a
provider error; the first live ones, three memory-notes runs on 2026-11-08, kept no more
detail than `loop_error`.
On 2026-11-09 the owner saved a memory while a reply and a notes review were running: the
secret check refused their next model calls, and the notice called both a provider
rejection (`provider_error:format_error`), while learning lost a batch to the same epoch
change. A model call refused because the safety epoch moved on is now a stop that runs
again, not a failure; Nocheh's other refusals keep their code; memory preparation retries
an epoch change ([ADR-0220](docs/adr/0220-a-new-safety-epoch-mid-call-is-retried-not-a-failure.md);
[turn](services/hermes/test_turn_failure_codes.py), [codes](services/hermes/test_usage.py),
[learning](services/honcho/test_meter.py)). Pending: a check on a running install after merge.
When a problem clears, its notice is edited in place: the line stays as sent and a short
✅ line under it says when it cleared, such as "Fixed at 12:06 UTC". The notice loses
its buttons once all its problems cleared, and takes the ✅ line back if the problem returns
within the quiet hour (owner, 2026-11-08: "show it resolved in
chat by update msg or reaction or reply", then "show check in new row with a short text";
[follow-up](services/hermes/test_problem_notices.py),
[edit](services/hermes/test_approval_cards.py)). Pending: a live button press on a running
installation, and a live notice that names a provider's exact error and is then marked ✅.

Get started (owner, 2026-11-01: "yes" to a small checklist on Home, a "Find my
Telegram ID" button and a warning when the OpenAI key is missing, before the server
install): Home lists the open setup steps from the saved settings, and
Settings › Telegram finds the owner's ID by running `discover-telegram` inside the bot service
([steps](test/dashboard-get-started.test.mjs),
[discovery](services/hermes/test_telegram_directory.py),
[browser](test/dashboard-pages.browser.mjs)). Pending: a real Find my ID press on the
clean server install.

Chat in the sidebar (owner, 2026-11-10: "how can start chat????", then "start build."
on a build plan whose step 4 adds a Chat item to the sidebar): Chat, second in the
sidebar, opens the assistant console's chat at `/hermes/chat` directly; its profile
picker chooses the private chat or a group ([sidebar](dashboard/app.tsx),
[browser](test/dashboard-pages.browser.mjs)). Pending: the owner's look on the running
installation.

Machine control (owner, 2026-11-10: asked to let Nocheh set up projects in their VM,
then chose no VM snapshots): Settings › Machines keeps the owner's machines (name,
address, port, login); the new `nocheh-machines` service makes and keeps each machine's
SSH key and shows only its public key, and Test trusts the host key on its first
success. The owner's own message in the private chat or an active project's group can
ask for a machine job with a short plan; its one plan card always goes to the private
chat, and after Approve the job's Hermes terminal and file tools run on the machine
through Nocheh for at most 50 minutes. Every command is logged in System › Machine log;
a command ends when its shell ends, and past its time limit on the machine too when the
machine has `timeout`; Stop, limits, a failed run and the off switches end the
programs the job started there (a failed cleanup shows as `machine_cleanup_failed`); a job that ends normally leaves its programs running and
names them. A machine is Ready only while its last Test passed, and only then can a job
ask for it. Every job card that would not fit Telegram is now refused with
`job_card_too_long` instead of never arriving. The review round of 2026-11-11 added
Edit for a machine's name, address, port and login (a new address, port or login asks
first, forgets the host key, stops its jobs and needs a new Test); the address field
flags `localhost` and points to `host.docker.internal`; the log shows the fingerprint
of what ran; Background work shows a job's cleanup while it runs and when it failed;
Remove, Trust a new host key and a move first end every pending cleanup of that
machine, one at a time; the 8 MiB output cap counts frame headers; `~` in the file
tools is the machine login's home; Hermes's `sudo -S` floor stays; a report that
can't be delivered after a normal finish leaves the programs running; and
`machine_key_missing` on a command marks the machine not ready
([ADR-0231](docs/adr/0231-owner-approved-jobs-work-on-the-owners-machines-over-ssh.md),
[stores](test/store-machines.test.ts), [backend](services/hermes/test_machine_box.py),
[service](services/hermes/test_machine_server.py),
[dashboard](test/dashboard-machines.test.mjs)). Unit, store and dashboard checks pass,
and the full tester scenarios `machine_job_runs_after_one_approval` and
`machine_job_refused_for_members_and_stopped` passed against a made-up SSH machine
([scenarios](tools/acceptance/product_scenarios.py)). Pending: a real job on the
owner's VM with a real model.

Machine jobs on the owner's own login (owner, 2026-11-11: "I want access to main user",
then "ok so still want use main"): every command of a job carries `NOCHEH_STARTED=<job
id>` in its environment and holds the job's marker file `~/.nocheh/jobs/<job id>` open as
fd 7 (no marker, no command), and the cleanup ends only the login's processes with that
marker, those left behind with that tag, and those they started (from `/proc`, or on
macOS `lsof`, `ps` and `ps -E`), after it proves it finds a probe `sleep` by its marker,
and is done after two empty rounds; the wrapper also takes Homebrew's `gtimeout`
([ADR-0237](docs/adr/0237-stop-ends-only-the-programs-a-machine-job-started.md),
[service](services/hermes/test_machine_server.py), [stores](test/store-machines.test.ts),
[scenarios](tools/acceptance/product_scenarios.py)). Pending: the cleanup on a real
macOS machine.
Owner steps: say which VM app you will use, so its network can be checked; after the
pull, run `./bin/nocheh up` (or `make dev-build`, since the management image now carries
the SSH client), which makes `NOCHEH_MACHINE_TOKEN` and starts `nocheh-machines`; pick a
login on the VM that has bash, also your own, since Stop ends only what a job started;
add the VM in Settings › Machines, put the public key in that login's `~/.ssh/authorized_keys`, and press Test to check that Nocheh
reaches it. A VM on the same computer is `host.docker.internal`, not `localhost`; a
VM on a network only its host can reach may need a port forward or a bridged network.
Open by design: the log's command text is what the run reports, and the script's hash
is what ran; unlike the sealed box, the VM has its own internet while the job keeps
the archive tools; machine keys are not backed up, so after a restore each machine
fails with `machine_key_missing` until it is removed and added again.

Data tools over MCP (owner, 2026-11-10: "start build." on the build plan whose step 5
offers Nocheh's data tools over MCP and moves the tool switches into Nocheh): the
broker and `nocheh-app` serve the 18 data tools at `/mcp`, each calling its existing
route with the turn's pass; Hermes connects in each turn and sees them as
`mcp__nocheh__…`, and a turn without all of them stops with `data_tools_unavailable`;
a turn's pass names its brain, kept with each checked effect; commands, web pages and
outside tools are switched per chat or topic on its page in Chats, with "Tools in every
chat" in Settings › Assistant, and Nocheh checks the switch on every proposal and again
before a run ([ADR-0233](docs/adr/0233-data-tools-over-mcp.md), [tools](test/mcp.test.ts),
[switches](test/store-chat-tools.test.ts), [Hermes](services/hermes/test_data_tools.py),
[failure](services/hermes/test_turn_failure_codes.py)); the full tester passed. Pending: a
live reply on the owner's install after the pull. Owner step on an install that
ever saved a Commands, Web pages or Outside tools switch: a value for one chat is
ignored and is set again in Chats; a value for every chat must be removed from Hermes's
shared settings, or turns stop with `unsupported_preference`.

One waiting card per person or project (owner, 2026-11-08: "all <project name> arent same?
isnt auto or manual merge them to one waiting item"): a new name for a person or
project already waiting joins that card when learning names it as `same_as` or the
names match apart from case, an `@` and a trailing `(…)`; the owner can fold a card
into another, take a name back out, or answer it as someone or something already
known; one Remember keeps every name for one entity, and learning finds a
confirmed project by any of its names
([ADR-0219](docs/adr/0219-repeat-names-wait-on-one-card.md),
[store](test/store-entity-suggestions.test.ts)). Confirming a project card no longer
makes a second entity that broke later learning about that project. Pending: the
owner's yes on the approach, folding the three existing cards for one project on
the development install, and a live learning turn that joins a waiting card.

Approval cards lead with the assistant's summary (owner, 2026-11-09: "ai say want to
do this short and get my approve and done, thats what I want is simple flow"): the
shell, browser, MCP and Notion tools take a one-line `summary` beside the exact
arguments; the card shows it under the operation's name and folds the exact fields
into one quote that opens on a tap, a command staying open in code; it is
secret-checked like the arguments and never changes what runs
([ADR-0224](docs/adr/0224-operation-cards-lead-with-the-askers-summary.md),
[words](test/action-text.test.ts), [store](test/store-controlled-actions.test.ts),
[cards](test/store-approval-buttons.test.ts), [list cards](test/store-background-job-changes.test.ts),
[tools](test/mcp.test.ts), [gateway](services/hermes/test_approval_cards.py),
full tester scenario `tool_card_reads_in_words`). Pending: the owner's yes on the
mock, and a real Notion card with a summary on the owner's live install after the
machine pull.

Private chat and group memory (2026-11-12, from the members design review: check whether
Honcho can bring what the owner says privately into a group, fix a real leak, and add a
canary test): Honcho v3.6.0 keeps each conclusion in the session it was learned from, and
group reads stay in the group's sessions; the one gap, Honcho's memory chat running a tool
it did not offer (`get_recent_observations` reads every session), is closed in Nocheh's
Honcho gateway ([ADR-0241](docs/adr/0241-honcho-runs-only-the-tools-it-offered.md),
[gateway](services/honcho/test_meter.py), [canary](tools/acceptance/product_scenarios.py)
`private_chat_stays_out_of_groups`). Pending: the owner's merge, then a pull on the operating
install (the gateway reloads with the dev stack's Honcho code).

Member safety (owner, 2026-11-09: asked whether a coworker they let use Nocheh can use
their Notion or reach other groups, then "yes" to five safety fixes): a Notion read whose
input names an address outside the owner's Notion asks like a change, in the private chat
and in jobs; a job keeps the Notion reads its card offered, narrowed at Approve; the
executor checks a Notion call's origin again right before it runs; a card that offers a
chat rule for a group or topic names the topic and says the rule covers everyone allowed
there; Honcho peer cards are off and Nocheh reads none
([ADR-0225](docs/adr/0225-member-safety-rules.md), [addresses](test/store-notion.test.ts),
[jobs](test/store-background-job-notion.test.ts), [executor](test/store-controlled-execution.test.ts),
[cards](test/store-action-rules.test.ts), [setup](services/honcho/test_setup.py),
[context](test/store-native-memory.test.ts)). Pending: the owner's yes on the new SPECS
lines; after the machine pull, a live Notion read of an outside page that asks and a group
card with the note. Owner steps: pull main in the operating checkout, run
`./bin/nocheh init`, `make dev-stop` and `make dev`, then check that `PEER_CARD_ENABLED` is
`false` in the honcho-api container (`make dev-status` names it); if Settings ›
Assistant › Built-in instructions › Approval buttons and results was ever saved, update its `allowed_here` and
`allowed_always` lines or reset it to the built-in text, since saved lines keep the old
wording.

Hermes dashboard names (owner, 2026-11-09: "what are thesse?", "naming is not well",
"ints not clear what is it", then "yes" to the fix): the native profile selector lists
`private-chat` once with no other-profile warning and each group as `group-<name>-<code>`,
with the full title as Hermes display name; Telegram sessions are titled with their
chat's name and memory reviews are hidden. The owner's installation showed a chat
opened in the dashboard before its next Telegram message starting its new guard epoch
with no conversation and its old copies never removed; carrying and removal now treat
both kinds of preparation as the same chat
([ADR-0227](docs/adr/0227-hermes-lists-chats-by-their-names.md),
[carry](services/hermes/test_profile_history.py), [titles](services/hermes/test_session_titles.py),
[names](test/store-runtime-profiles.test.ts), [dashboard](services/hermes/test_runtime_profiles.py)).
Pending: after the merge, restore the affected group's carried conversation on the
owner's installation and remove its empty October profile folders; existing review
rows disappear with their copy at the next guard epoch.

Secret check connection failures (2026-11-08): the owner's installation counted
secret-check calls that failed with no provider status, 12 on one model and, after a
switch, 26 on the next, with no refusals and no hidden texts; in the same window a
memory-search call to another provider stalled and failed. They were dropped
or stalled connections, not the model. Each check opened a new HTTPS connection;
checks now reuse the process's open connections to the provider
([check](services/hermes/test_subscription_detector.py)). Pending: a failed secret
check on a running installation that names its cause.

Secret check on Haiku 5.5 (owner, 2026-11-13: "pick Haiku model for secret check", "pick
as default"): a secret check on Anthropic that names no model uses `claude-haiku-5-5`, and
Settings › Models shows it as "Default (claude-haiku-5-5)"; on other providers it follows
the main model ([ADR-0246](docs/adr/0246-the-secret-check-on-anthropic-defaults-to-haiku-5-5.md),
[check](services/hermes/test_provider_routes.py)). Through the production call path on
Anthropic's API, on 29 synthetic cases, five rounds each, it passed 145 of 145 like
`claude-sonnet-5`, with no missed secret, extra value or refusal, a 1.2-second median
against 1.56 seconds and about a twentieth of the cost. The owner's installation has
chosen it since 2026-11-08.

Stuck notes review (2026-11-08): on the owner's installation one Hermes native notes
review failed once without changing notes, came due again two minutes later under a
newer epoch, and its workflow closed as superseded; nothing asked for it again, so it
stayed waiting while the other reviews drained. Failed reviews now renew under a newer
epoch like never-started ones and keep their attempt count, Hermes keeps a failed marker
that outlives the old epoch's profile, a source's step reopens a waiting review's closed
workflow, and an epoch that lands mid-check makes the workflow wait and renew
([ADR-0216](docs/adr/0216-failed-reviews-keep-their-place-across-epochs.md),
[check](test/store-native-review.test.ts), [Hermes](services/hermes/test_review_handoff.py)).
Once live, the source's step deleted that review instead, because another fragment of
the same long source had already run; waiting fragments of a reviewed source now keep
their place while their own text is unchanged
([ADR-0217](docs/adr/0217-waiting-fragments-keep-their-place.md)). The deleted fragment
is not queued again.

Notes reviews on full notes (2026-11-12): once a chat's Hermes native notes were nearly
full, a notes review that needed room saved nothing. Hermes held its remove-and-add for a
person's approval in the profile's `pending/` folder, which an isolated turn does not
keep, and the review still ended done. Reviews now run as requested ones that may change
or remove notes, and Hermes's approval switch for note writes stays off; reply turns were
not affected
([ADR-0239](docs/adr/0239-notes-reviews-make-room-in-full-notes.md),
[check](services/hermes/test_native_memory.py)). Pending: a review on full notes on a
running installation that saves its note.

Notes reviews stuck after a restart (2026-11-16): a full tester run left 26 Hermes
native notes reviews closed as uncertain for good. Each had waited for a busy profile,
its next start request failed while Hermes or the app restarted, and Hermes then
reported it `not_found`, which the app counted as unconfirmed until the review closed.
A review Hermes reports `not_found` now waits again as new work, up to its four
attempts; Hermes launches a start only within 45 seconds of receiving it, the owner's
resume always opens a new workflow, and `memory pause`/`memory resume` take
`--revision` ([ADR-0258](docs/adr/0258-a-notes-review-whose-start-was-lost-waits-again.md),
[check](test/store-native-review.test.ts), [Hermes](services/hermes/test_review_handoff.py)).
The owner chose to leave the four parts already closed this way unreviewed, so nothing is
pending.

Message search missing messages after a rebuild (2026-11-17): rebuilding long-term memory
on a running installation left 46 of 909 Honcho message embeddings pending. Their first
embedding had been shed or failed, and Honcho's vector reconciler, the only retry, names no
workspace, so the Honcho boundary refused every call it made. The deriver now runs the
reconciler's sync steps once per workspace with it bound, in parts within the gateway's
per-request bounds (100 rows, 128 KiB of text, less room for preparation); a call with none
still fails closed
([ADR-0261](docs/adr/0261-honcho-retries-each-workspace-bound.md),
[check](services/honcho/test_boundary.py)). Checked against the pinned Honcho API and deriver
with PostgreSQL and pgvector and the gateway's own request bounds: before, every pending row
stayed pending with `honcho_workspace_required`; binding alone left six long messages (157 KB)
refused as one request; with parts, every row was embedded with its own workspace named, a
refused workspace failed only its own rows, and rows reset from `failed` were embedded on the
next run. Pending: on the running
installation, set the rows that reached `failed` back to `pending` and confirm none stay
pending.

Notion inside background jobs (owner, 2026-11-01: chose "All three, in order" to
build steps 2 to 4 so Nocheh works like a Claude Code session, to check a Notion
task table against a group chat): long tool results are read in parts
([check](test/mcp.test.ts)). Waiting and approved tool
actions, such as Notion calls, survive reactions in any chat and automatic learning
revisions (owner, 2026-11-03: "Keep them valid"), then run when approved, and a later turn or
job step of the asking chat reads its own action; any other epoch change still
stops them, and the reader then sees only the state
([ADR-0200](docs/adr/0200-waiting-approvals-survive-reaction-epochs.md),
[check](test/store-quiet-epochs.test.ts)). A job's report is sent after
reactions too, and after learning revisions by the same quiet-epoch rule (its own check
covers reactions only); any other change after its run sends no further part of the
report and ends the job as failed (`job_report_outdated`), and Stop sends no
further part either ([ADR-0201](docs/adr/0201-job-reports-survive-reaction-epochs.md),
[check](test/store-background-job-epochs.test.ts)). An approved tool action's card
now says whether it finished, failed or did not run, with a reason from fixed codes
in the owner's texts; a tool's own error counts as failed; a card that a job asked
for names the job, and the job's agent does not wait for it; a later turn or step
lists its operations when it no longer holds their IDs
([ADR-0202](docs/adr/0202-approved-actions-report-how-they-ended.md),
[cards](test/store-approval-buttons.test.ts), [list](test/store-quiet-epochs.test.ts)).
The executor checks the tool settings of the action's chat, so an action that
carried, or one a job asked for, runs once approved
([check](services/hermes/test_runtime_profiles.py), [fake Telegram](tools/acceptance/product_scenarios.py):
`approval_waits_across_a_change_and_runs`, `job_operation_runs_after_approval`).
Still open: a shell approval that waits past its profile's 15 idle minutes fails
without running, and another pending publication between claim and start ends an
action as ambiguous.
A step of a job the owner asked for and approved in their private chat reads
Notion without asking only when its card offered reads at Approve and the setting
still allows them ([ADR-0225](docs/adr/0225-member-safety-rules.md)); its changes always ask, even under "Nothing
asks me"; group and member jobs never reach Notion; scheduled tasks ask for every
call; the job's card says what it may read without asking; Stop stops a read that
has not started ([ADR-0203](docs/adr/0203-owner-approved-jobs-read-notion.md),
[check](test/store-background-job-notion.test.ts)).
A running job's waiting operations get no card; after its report they come on as
few cards as fit, each showing every change exactly and decided as a whole by the
owner, and each card says how its changes ended; Stop rejects them
([ADR-0204](docs/adr/0204-a-jobs-changes-come-on-list-cards.md),
[check](test/store-background-job-changes.test.ts)).
Step 3, the sealed box: a job the owner asks for in their private chat can get
a sealed box while "Sealed box for jobs" in Settings › Assistant is on (the
default); its card says so, and the box is part of its fingerprint. Its run uses
Hermes's own terminal, file and Python tools in a container with no network,
keys or Docker socket, and a read-only copy of the job's chat that passed the
secret check. The box is kept while only reactions or automatic learning change
and the last run ended normally, and removed within 15 seconds once the job stops, the switch goes off or
its time is up; a launcher touches only its own installation's boxes. A box
command never outlives its run. A `/chat` that runs out of room stops for good and
its manifest says `full`. A failed box job says `job_box_unavailable`, and a box
request in the legacy runtime is refused. Those runs lose the approved shell, the
browser, Hermes memory and subagents, and the tools are blocked in every other
turn. Notion reads are an exact list of read tools, and
a read by an address outside the owner's Notion counts as a change, in a live turn or a job
([ADR-0225](docs/adr/0225-member-safety-rules.md)). Link previews are off for
every message the bot sends or edits
([ADR-0205](docs/adr/0205-owner-approved-jobs-work-in-a-sealed-box.md),
[stores](test/store-job-box.test.ts), [launcher](services/hermes/test_box_launcher.py),
[box server](services/hermes/test_box_server.py), [backend and hook](services/hermes/test_job_box.py),
[previews](services/hermes/test_link_previews.py)). The end-to-end check is the
full tester scenario `background_job_uses_sealed_box`
([tester scenario](tools/acceptance/product_scenarios.py)). On the fake Telegram,
with made-up group messages and a scripted model, a job's terminal, read_file and
execute_code calls ran in its box, the result file never appeared in the turn, the
report reached the owner, and the box was gone when the job was done. It passed on
a fresh fixture, and failed as expected when the launcher had no box token. Not
yet run with a real model.
Step 4, GitHub copies: the owner presses Connect GitHub once in Settings › Connections ›
GitHub, which makes Nocheh's own read-only GitHub App, picks repositories on GitHub and
copies one there. A box job the owner asks for in
their private chat can read one copy. Its card names the repository, branch, commit
and size, and every run of the job, relaunches too, finds that commit read-only in
`/repo/code` in its box, with git and rg. Only a fresh fetcher container's fetch step
holds a key, one that lasts an hour and reads only that repository; no key reaches the box, the launcher, Hermes, a turn, the database
or a log. Remove and Disconnect answer at once: they withdraw waiting cards, stop
jobs that have not started and remove running jobs' boxes. Nocheh checks for new
commits every hour, and a refused app raises one problem notice
([ADR-0209](docs/adr/0209-owner-approved-jobs-read-a-github-copy-in-their-box.md),
[ADR-0210](docs/adr/0210-github-access-goes-through-nochehs-own-github-app.md),
[stores](test/store-job-repo.test.ts), [sign-in and copies](services/hermes/test_github_connection.py),
[fetcher](services/hermes/test_repo_fetch.py), [writer](services/hermes/test_box_repo.py),
[launcher](services/hermes/test_box_launcher.py)). The end-to-end check is the full
tester scenario `background_job_reads_a_repo_copy`
([tester scenario](tools/acceptance/product_scenarios.py),
[fake GitHub](tools/acceptance/github_mock.py)). On a fake GitHub with a made-up
repository, the Settings routes made and installed the app and copied it, a job read the history with
git, searched and read files in its box, and a key committed in the repository came
back masked (Hermes's own redaction masked it first, keeping 6 and 4 characters). Neither
the app's key nor a short repo key was found in the box, the launcher, the job and copy
rows, a dashboard answer or any request but GitHub's, and a relaunch got a new box at the same commit. Remove, Copy again, a refused app and
Disconnect each did what the card says. It passed together with
`background_job_uses_sealed_box` on a fresh fixture. Not yet run against real GitHub or
with a real model. Open owner questions D1 to D4 are in ADR-0209; Nocheh is built as
recommended until they are answered.
Open owner questions: does the owner accept, in their own words, the new SPECS
lines that a reaction change or a learning revision does not stop a waiting or approved proposal, that a
card says how an approved operation ended and which job or schedule asked, that
jobs the owner approved use Notion, that a job's changes come on list cards, and
that a job the owner approved can work in a sealed box? They are not yet accepted.
Telegram message
requests keep the exact-epoch rule, so a reaction or a learning revision in the seconds between
staging a report part and sending it still cancels that part and fails the job.
An owner cancel from Workflows does not edit the card yet.
The box rests on Hermes internals, so each Hermes upgrade must run the box checks
again: the backend and hook tests (the hook blocks the box tools elsewhere, and
oversized results keep their preview) and the `background_job_uses_sealed_box`
scenario (terminal, read_file and execute_code run in the box). Still open by
design: no gVisor or user namespace remapping on the default host, one uid for the
box server and its commands, and the secret check of box output is not counted in
the job's cost. Follow-up, not built now: retention for `runtime_prepared_values`,
an older gap (see Storage growth below). Nothing deletes its rows, and each secret
check loads every row of its audience and epoch; box pages are not added to it.
Pending: a live check: ask for a Notion change, react in a group, then approve;
a job whose report comes after a reaction in a group; a Notion call that fails
and one that finishes, each showing it on its card; a job in the owner's
private chat that reads a real Notion table; a box job that checks a real Notion
table against a group chat; and turning the box switch off while a box job runs.
A job as one Hermes run (owner, 2026-11-04, four choices): a job runs at most 50
minutes in one go, and bigger work becomes several jobs that the agent splits itself;
at 80% of its cost or time limit the agent is warned so it writes its report, and at
the limit Nocheh stops it and sends a short note of what is done and left, from its
last to-do list and with no model call; a running job's card has a Stop button.
Choice 2 (owner, 2026-11-04): reactions and automatic learning keep updating while a
job runs, and its run carries across them; other changes still wait for the run or
end it, and a relaunch after only quiet epochs keeps its history
([ADR-0208](docs/adr/0208-running-jobs-carry-across-quiet-epochs.md),
[stores](test/store-background-job-carry.test.ts), fake Telegram:
`background_job_reaction_during_run` and `background_job_restart`, whose case (b) now
resumes and whose case (c) restarts after a hide). Pending for choice 2: run both
scenarios on the fake Telegram, and measure on the owner's installation, with a long
job in a busy group, the secret-check cost of re-checking a carried run's resent
history in each new epoch (ADR-0208). Built in source: one
sealed run per job with per-call cost counting, both notices, the limit note, at most
two relaunches with a resume or restart message, and Stop on the card
([ADR-0207](docs/adr/0207-a-background-job-is-one-hermes-run.md),
[stores](test/store-background-job-runs.test.ts), [turn](services/hermes/test_job_progress.py),
[fake Telegram](tools/acceptance/product_scenarios.py): `background_job_long_run`,
`background_job_cost_cap`, `background_job_time_limit`, `background_job_stop_button`,
`background_job_restart`). Neither ADR-0207's nor ADR-0208's scenarios have been run
on the fake Telegram or with a real model yet.
Prompt caching (owner, 2026-11-01: "I want to make sure that we comply with this in
Nocheh", after Anthropic reported a low cache hit rate on the account's key; merge only
if replies stay the same and it is not less efficient): no Anthropic call was cached,
because every provider was reached through its OpenAI-compatible API. Replies and
memory-notes reviews on the Anthropic preset now use Anthropic's Messages API through
the broker with Hermes's own cache breakpoints. They keep the same model, tools,
thinking, review budget and step-limit summary; the memory evidence stays before the
conversation; a profile remembers each session's prompt; and Usage shows the cached share
of input
([ADR-0199](docs/adr/0199-anthropic-replies-use-the-messages-api-for-prompt-caching.md),
[broker](test/security-broker.test.ts), [boundary](test/security-contract.test.ts),
[evidence](services/hermes/test_memory_evidence.py)). The secret check, privacy filter,
image reads and Honcho's deriver are too short or one-off to cache. Live since
2026-11-03 with no failed or refused calls: memory-notes reviews cost 26-38% less per
call, and a two-call reply about 26% less than the same calls uncached (measured with the
evidence as the request's last block). In that layout reviews took a second model call,
a tool step, in 34% of runs instead of 83%, with no note changes in either period, so
the evidence moved back before the conversation, where it was. After the move, live
reviews took a tool step in 65% of runs on Hermes 0.22.5 and 51% on Hermes 0.23, with the
same kind of sources. A side-by-side replay on 2026-11-12 (owner chose "Run the
side-by-side test") of 60 stored review inputs, twice per route on Hermes 0.23 from empty
notes ([review replay](tools/development/review_replay/README.md)), found no clear
difference from the route: a tool step in 42% of runs on the old chat route, 35% on the
Messages API (6.7 points fewer, 90% interval 15 fewer to 1 more) and 45% on the Messages
API with thinking only between tool calls, at about a third of the old route's cost per
review in the replay. The route stays as it is. A second replay the same day, of 21
inputs once per route from nearly full notes (2,172 of 2,200 characters), also showed no
route effect: whether a review changed the notes agreed for 19 of 21 sources, and
reviews were cut off before answering 3 times on the old route and once on the Messages
API. The cut-offs came from the review's 24,000-token input budget, which leaves room for
three calls; at 48,000 none were cut off, the same reviews changed the notes and the cost
was not higher, so the budget is now 48,000
([ADR-0240](docs/adr/0240-notes-reviews-get-room-to-retry-on-full-notes.md)). Half or
more of the note batches on full notes were refused on every route (8 of 12 on the old
route, 5 of 10 on the Messages API), mostly for a missing field; whether that loses notes
is not known. Next: Honcho's reasoning
calls through its own Messages API support.

Owner login (owner, 2026-10-28: "better to set a password for it, can set and
change from main dash", "an auth"; 2026-10-29: "all yes" to the same login for
the dashboard): one Nocheh password for the dashboard and the mini app, created
on the first dashboard visit, with sessions that survive restarts
([ADR-0189](docs/adr/0189-mini-app-password.md),
[ADR-0190](docs/adr/0190-one-owner-login.md), [check](test/mini-app.test.ts),
[HTTP check](test/management.test.ts)). Pending: create the password on the
running installation, and a live sign-in from the owner's phone.

Chat-review build, part 1 of 4 (owner, 2026-10-29: "I all thing is ready start
build."): imports check a page of messages per secret-check call, send and parse
the export once, accept a 128 MB messages file, show preparation progress, and
become ready with one Telegram notice
([ADR-0191](docs/adr/0191-imports-share-secret-checks-and-become-ready.md),
[checks](test/store-preparation.test.ts), [ready](test/store-imports.test.ts)).
The Import page shows cost estimates before Start (owner, 2026-10-29: "estimate
is ok", "base on imported data and count calc the estimate"): the secret check
from the export's text size and message count, and learning as one memory-notes
review per message plus Honcho memory calls,
from this installation's last 30 days of learning or typical token counts
([estimate](tools/operations/archive/learning_estimate.py),
[check](services/hermes/test_learning_estimate.py)).
Part 2, files: documents are read by Hermes's own reader from Nocheh's
preparation step ([ADR-0192](docs/adr/0192-files-are-read-by-the-runtime-document-reader.md),
[reader](services/hermes/test_document_text.py), [engine](test/document-extraction.test.ts));
checked with made-up Word and PDF files in the Hermes image.
Part 2, voice (owner, 2026-10-29: "we need have voice trancrition for all
voices", OpenAI with the existing key): every recording, live or imported, is
transcribed by Hermes's own transcriber with the Voice notes route of
Settings › Models, and notes saved without a key are transcribed once one is
added ([ADR-0193](docs/adr/0193-voice-notes-are-transcribed-by-the-runtime-transcriber.md),
[transcriber](services/hermes/test_voice_text.py), [engine and backfill](test/store-voice-transcription.test.ts));
checked with a made-up recording and a stand-in provider in the Hermes image.
Part 2, images: photos and image files are read once by Hermes's own vision tool
with the Images part of Settings › Models and the editable "Reading images"
instruction ([ADR-0194](docs/adr/0194-images-are-read-by-the-runtime-vision-tool.md),
[reader](services/hermes/test_image_text.py), [engine](test/document-extraction.test.ts));
checked with made-up images and a stand-in provider in the Hermes image.
Pending: a large made-up import on a running installation, a real voice note
and photo on the development machine, then reading a chat in order with
project-level role and skills (part 3), background jobs as one Hermes run
(part 4, [ADR-0207](docs/adr/0207-a-background-job-is-one-hermes-run.md)).

Honcho memory on by default (owner, 2026-10-23: "turn it on default.", then
chose to drop the live safety check): with the Honcho service enabled, the store
attaches Honcho memory once at startup without a live acceptance report and
without earlier history. An owner's later attach or detach stands. After the
fresh-database rebuild on the development machine this replaces the manual attach, which the
missing live acceptance report had blocked.

Last reconciled 2026-10-09. [SPECS.md](SPECS.md) defines the product;
[AGENTS.md](AGENTS.md) defines working instructions. [Task history](docs/task-history.md)
retains completed increments and earlier observations. The
[MVP acceptance register](docs/mvp-acceptance-status.md) records live gates and
reasons for carrying historical evidence forward.

Owner architecture review (2026-10-09), plan only, no code changed: memory is
swappable with Honcho as the current long-term memory; Inngest orchestrates the
full Nocheh workflow with Hermes and Honcho as parts of it, without changing
Hermes' internal workflow; slowness is diagnosed per stage with workflow,
third-party and LLM time separated; uncontrolled storage growth is re-examined
in every component; one reasoning provider and model is enough for the MVP.
These are recorded in [SPECS.md](SPECS.md). The failing recall gate is in Honcho
memory: Nocheh's per-generation workspaces were revoked by unrelated guard-epoch
advances, a non-standard usage the owner rejected. The owner accepted
[ADR-0109](docs/adr/0109-standard-honcho-entity-model.md) on 2026-10-09 and
authorized steps H1 to H4 of its [plan](docs/honcho-standard-memory-plan.md).
They are implemented in source on a branch
([decision](docs/adr/0115-honcho-session-revisions.md),
[Honcho memory checks](test/store-native-memory.test.ts),
[workflow checks](test/store-workflows.test.ts)): one Honcho workspace per
installation, versioned sessions per conversation, entity evidence and learned
interpretation, targeted session rebuilds instead of per-epoch re-ingestion,
live session context read on arrival and prefetched when Honcho finishes work,
and session allowlists for group and topic recall. On 2026-10-10 the owner's
development-machine installation ran the fresh start (H5) and live acceptance
(H6) on the Claude provider; see item 7. [Stage timing, storage growth and Inngest findings](docs/operations-review-plan.md)
list the gaps with code references.

Swappable brain (owner, 2026-11-11: "yes start Telegram and brain socket"): the brain
now sits behind one brain socket, and Hermes is the only brain plugged in. Every turn,
and the brain's own settings, role and skills, notes and scheduled tasks, go through it;
the brain never sends to a platform. The brain route moved to `/v1/brain/manage`, and Health
shows the brain and what it can do ([decision](docs/adr/0234-brain-socket.md),
[socket](src/brain/brain.ts), [checks](test/brain.test.ts),
[Hermes turn routes](services/hermes/test_brain_turns.py)). Pending: a second brain when the
owner wants one.

Nocheh's own Telegram bot (owner, 2026-11-11, same go-ahead): the new `nocheh-telegram`
service is the only holder of the bot token. It polls Telegram, shows typing and reactions,
and sends replies, approval cards, refusals and notices; Nocheh decides group addressing
and sends the reply the brain returns, and Hermes is brain only
([decision](docs/adr/0235-nocheh-owns-the-telegram-bot.md),
[service](services/telegram/test_service.py), [simulation](services/telegram/test_simulation.py),
[core](test/store-telegram-dispatch.test.ts), [addressing](test/telegram-frontdoor.test.ts)).
Pending: the dashboard's own Bot API calls (Find my ID pre-check, group directory, mini app
menu button) still read the token and move into the bot later.

Send records (owner, 2026-11-11: "I think we should record every agent that send to apps
like telegram, slack, etc", then "yes" to recording every send, reactions included, with
typing skipped): `nocheh-telegram` leaves one content-free record per Bot API request that
leaves or that its own check holds back, in `spool/sends`; `nocheh-app`
drains them into `control.chat_sends`, `/v1/status` carries the last day's problems, the
owner reads the list at `/v1/chat-sends`, the "Keep delivery logs" days expire them, and
problem notices gain the kind `sends`
([decision](docs/adr/0238-record-every-send-to-a-chat-app.md),
[bot](services/telegram/test_sends.py), [store](test/store-chat-sends.test.ts)).
Built on one branch (bot, store, notices, dashboard, docs), not yet on main. A try that a
later one recovered within 15 minutes, an unchanged edit, an expired button answer and a
reaction the chat does not allow are listed but not problems. "typing…" is never recorded,
not even when it fails (owner, 2026-11-12: "Never record typing"). Pending: the owner's merge, then a
live check on a running installation that a real 👀 reaction and a reply appear in
System › Sent to apps as sent, and that the next failed send shows on Health and in a notice.
Follow-ups: the dashboard's own `setChatMenuButton` (mini app menu button) is a send with
no record until it moves into the bot with the other dashboard Bot API calls above (those
are reads, which stay unrecorded).

Swappable memory (owner, 2026-11-10: "the main things in nocheh should be data
and hermes and honcho should be replace able with other things like claude code
or mem0"): long-term memory now sits behind one memory socket, and Honcho is the
only engine plugged in. Nocheh keeps receipts, sessions, sharing rules and
deletions; routes moved to `/v1/memory/longterm/*`, the admin command to
`memory longterm`, and the dashboard shows the engine
([decision](docs/adr/0232-memory-engine-socket.md),
[socket](src/memory/engine.ts), [Honcho engine checks](test/memory-engine.test.ts)).
The development stack reloads the changed routes on its own after a pull; a stack
not in development mode needs a full restart, so the Honcho gateway and Hermes use
the new routes. Pending: a second engine, such as mem0, when the owner wants one.

Honcho image build (2026-11-11): `./bin/nocheh build` failed on an installation whose
Honcho state folder sits outside the checkout. Docker Compose v5 builds through Bake,
which asks for an extra `--allow=fs.read=` permission for a Dockerfile outside the build
context and the working folder. The generated build file is now
`data/compat/upstreams/honcho/nocheh.Dockerfile`, inside the context, and Honcho state
no longer holds it ([setup check](services/honcho/test_setup.py),
[Compose check](services/hermes/test_honcho_runtime.py)). A cloud Compose build of the
Honcho image passed with the state folder outside the checkout. One-time step on an
installation built before: delete `honcho.Dockerfile` from its Honcho state folder, or
the reset preflight reports it as `unclassified_state_path`.

Long recalls (2026-11-10): a long-term recall slower than five minutes failed as
"memory unavailable". Node's fetch stops waiting for an answer after 300 s,
whatever deadline it gets, and Hermes stops any tool after 420 s. The Honcho
client and the broker's archive relay now use [longFetch](src/long-fetch.ts),
where only the caller's deadline (480 s and 600 s) ends a call, and the recall
tool asks Hermes for 660 s ([checks](test/long-fetch.test.ts); the
310-second check runs with `NOCHEH_LONG_WAIT_TEST=1`). Only background jobs wait
that long: replies stop at 230 s.

Retired sources now leave Hermes' own stored history. The real-Claude simulator
run found an owner-private answer repeating a fact 30 seconds after every source
of it was retired: Honcho memory and archive search had dropped it, but Hermes
replayed its native session history. Before each turn the Hermes service now
rewrites that profile's stored rows for retired messages, their turn's tool work,
answers that were themselves retired, tool results citing a retired source and
later compaction summaries; owner native recall skips the same rows read-only.
Each withheld row keeps its place as a placeholder saying it was retired and
naming the retired message or reply by its Archive source ID; restoring does not
rebuild the row
([decision](docs/adr/0123-retired-sources-leave-native-history.md),
[placeholders](docs/adr/0132-retired-history-placeholders.md),
[native history checks](services/hermes/test_retired_history.py),
[storage checks](test/store-source-retirement.test.ts)). The pinned-Hermes replay
and search check runs only in the Hermes image. Pending: the owner-machine rerun of
the simulator's retired-fact case. Hermes native notes (`MEMORY.md`,
`USER.md` and their backups) now lose entries that cite a retired source or that
a withheld turn's memory call wrote, checked before every turn
([decision](docs/adr/0129-retired-sources-leave-native-notes.md),
[checks](services/hermes/test_retired_history.py)); an uncited paraphrase stays.

Hermes native notes reach every turn. With the memory evidence on, Hermes read the
notes only when it built a session's prompt, so the later turns of a session carried
none. Each turn now reads them itself, and the stored prompt stays the same
([checks](services/hermes/test_memory_evidence.py)). The checks passed in the Hermes
image on the owner's machine, and replies went through after the pull. The full tester
saves a note and checks that the chat's next two messages still carry it
([scenario](tools/acceptance/product_scenarios.py), [fixture model](test/test_scripted_brain.py)).

Agent-led knowledge management is implemented and verified locally. Organization
delegation starts disabled, has exact conversation scopes, respects owner
corrections, and applies saved proposals atomically after foreground work finishes.
Receipts, explicit resumption, revision-checked undo, and inactive portable history
are preserved. Typed runtime tools and the existing consented learning result feed
the organization workflow, including learning publication recovery.
[Decision](docs/adr/0091-bounded-agent-knowledge-organization.md),
[authority/application checks](test/store-knowledge-management.test.ts),
[owner read checks](test/store-owner-supervision.test.ts),
[inactive restore checks](test/knowledge-portability.test.ts),
[runtime checks](test/mcp.test.ts),
[learning checks](test/store-learning-engine.test.ts).

Activity Decisions provides complete server totals and exact-item links across
approval families. Projects exposes delegation and preserved organization history;
Projects and Sharing use the stored named-conversation selector. Context separates
addressing, knowledge access, and external actions from organization. Overview
distinguishes connection, synchronization, and usable memory. TypeScript and
dashboard builds, affected Node 24/PostgreSQL suites, 85 native checks, and all
33 dashboard checks pass. Synthetic desktop, phone, keyboard, deep-link, stale
proposal dismissal, and retained-draft interactions are verified. The explicit
Docker security boundary passes in the simulation session's separate host fixture.
No deployment, operating
delegation, or live-memory-readiness claim is made; existing recall failures
remain open.
[Dashboard checks](test/dashboard-supervision.test.mjs),
[synthetic preview](test/dashboard-supervision-preview.mjs).

Nocheh is pre-release. The operating local installation has 17/17 healthy
services after the limited database and Inngest recovery and Hermes image-tag
restoration documented below. This service-health checkpoint does not establish
personal-use readiness or release acceptance. The earlier unexplained Inngest
exit remains recorded. The pinned native candidate includes empty-completion rejection; the
last verified TypeScript services include event-bound provider timings, dependency
patches, and protected workflow receipt reconciliation. The prior source checkout
and its three local edits remain preserved.

The active `nocheh_postgres_data` volume measured 36.9 GB on 2026-10-08; the
Inngest database is 35 GB (`spans` 27 GB, `history` 4.8 GB, `traces` 3.3 GB).
Honcho and native memory review produced 99.5% of 13.4 million spans, mostly
background runs repeatedly polling one busy admission slot. Background families
now wait in one shared Inngest concurrency key; a synthetic probe against the
pinned Inngest cut spans for the same contended workload from 888 to 153 with
zero wait polls and unchanged reply latency. This source is not yet active in
the operating installation. Because these rows were test telemetry, the owner
directed their full deletion: `spans`, `history` and `traces` were truncated
with the database isolated, leaving Inngest at 70 MB and the volume at 1.6 GB.
Nocheh stores, receipts and the workflow registry were untouched.
Telemetry retention is now a configurable setting,
`NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS`, checked daily; by owner decision it
keeps everything by default (`0`) until the owner sets a number of days
([default decision](docs/adr/0144-keep-history-by-default.md)); an
installation whose `.env` already sets a number keeps it.
[Decision](docs/adr/0106-configurable-workflow-history-retention.md),
[daily interval](docs/adr/0107-daily-workflow-history-retention.md),
[retention checks](test/workflow-retention.test.ts),
[shutdown check](test/test_store_postgres_entrypoint.py).
[Decision](docs/adr/0105-shared-background-engine-queue.md),
[registration check](test/workflow-foundation.test.ts),
[probe](test/workflow-background-probe.ts).

Honcho is attached and verified as primary memory; historical ingestion is off.
Earlier four-generation readiness was a dated observation. Current generations
are rebuilding after automatic learned-rule replacements advanced the guard epoch.
Saved repeated interpretation inputs had unchanged source observations and
changed learned rules. The verified repair deduplicates automatic rule guidance
by its original prepared dependencies while retaining owner revision changes and
full model context. [Decision](docs/adr/0082-evidence-based-learning-deduplication.md).
Owner edits to guarded automatic guidance also enter that identity; five focused
learning/learned-memory checks pass. Operating reconciliation remains under
observation. The new same-topic recall answer failed despite correct topic routing.
The affected replacement generation has since reached readiness and produced a
usable matching snapshot, but another background interpretation later replaced
existing learned versions and revoked that generation. The focused conversational
recheck delivered one reply on attempt four after about twenty minutes; it did
not identify the removal. A later discovery-path check also failed after about
six minutes: it found a reaction handle but did not read its observation. Reply
assessment was performed through the CLI. Current inspection finds all four
generations building; the later sample has thirty-one current ingestion receipts
without a first attempt. Older pending receipts are separate historical state.

Guarded reaction observations and bounded target excerpts are active in discovery.
The compiled app bytes match the verified source, and an actual isolated native
turn used the verified packaged helper. Conversational recall remains failed.
The bounded background handoff is active. Long native-note reviews still occupied
its only background slot ahead of primary ingestion. A verified candidate now
gives due, unattempted current ingestion priority before starting new native
reviews. Operating compiled bytes now match that candidate, and three more
ingestion receipts completed. Current memory readiness remains pending.

Restarting the cached development database image reinstated an older, slow
workflow view. The tested view was reapplied under its owner role and catalog
verified; workflow health then completed in 0.8 seconds with nine connected
worker families. A rebuilt database image preserves the corrected schema and
installation generation across an isolated fresh start and restart. The
operating database was recreated from the tested image with its named volume
preserved and recovered after 81 seconds of WAL replay. Development has
automatic service restarts disabled and is not the unattended release
configuration.

The existing embedding spending cap and subscription request safety limit remain
in force. Nocheh runs no provider proxy or provider login of its own
([ADR-0142](docs/adr/0142-external-providers-only.md)).

Group chats now answer only when a message addresses Nocheh: a reply to one of
its messages, its @username or a tap on its name, or its display name or a
name from Settings opening the message. Other group messages are archived
without a turn. Settings › Telegram access has the “Group replies” choice
(only when addressed by default, or every message) and an editable name list
that starts as “Nocheh” and “نوچه”
([decision](docs/adr/0133-group-replies-when-addressed.md),
[editable names](docs/adr/0134-editable-bot-names.md),
[dispatch checks](test/store-telegram-dispatch.test.ts),
[trigger checks](test/telegram-frontdoor.test.ts)). The
`group_answers_only_when_addressed` simulator scenario runs only on the owner's
development machine and has not been run. Addressing by a name at the start passed live on
October 12 (four group messages, one reply each). Pending: a live unaddressed
group message that gets no reply, and a reply or @mention that gets one.

All topics of a group now share one memory by default. A live question in a
group's second topic did not know what the owner had said in another topic,
because every recall path matched the turn's topic exactly. Archive reads and
search, Honcho recall, owner corrections, persistent grants and sharing now
reach the group's General chat and every topic; the private chat and other
groups stay out. Settings › Telegram access › “Topic memory” can keep topics
separate (“Each topic”)
([decision](docs/adr/0135-group-topics-share-memory.md),
[retrieval checks](test/store-retrieval.test.ts),
[grant checks](test/store-memory-access.test.ts),
[sharing checks](test/store-sharing.test.ts),
[helper checks](test/spaces.test.ts)). Hermes native notes stay per
conversation. Live check passed on the owner's development installation on
October 12: questions in other topics and in General recalled what was said in
one topic, with no private-chat fact, after restarts on three successive builds
([live summary](docs/mvp-acceptance-status.md)).

Dashboard rebuild (October 13, owner: "the work flow and ui update after save is
bad, save btn is not in good place and lots of other ui/ux issue ... need to check
app fully and do a refactor to make dashboard simple and usable"): the owner
dashboard is rebuilt from scratch around eight pages (Home, Inbox, Chats,
Messages, Memory, Usage, System, Settings), shared components in `dashboard/ui`
and one Save in the page header, at the top of the screen, that saves and applies
every settings edit in one step and shows the outcome
([decision](docs/adr/0145-rebuilt-owner-dashboard.md),
[Save placement](docs/adr/0146-save-in-page-header.md),
[save bar](dashboard/ui/save-bar.tsx), [settings store](dashboard/lib/settings.ts),
[routes](dashboard/lib/routes.ts), [browser checks](test/dashboard-pages.browser.mjs)).
Model providers are added in a dialog that lists the provider's models before
adding it. The 3D evidence graph and the editable memory map are gone from the
dashboard; people, facts and projects are lists with side panels. The server
gaps found while building it are closed, and System lists internal keys by
service and use ([history](docs/task-history.md)). A manual share from Memory ›
People stays persistent or dated: one-time access belongs to approving a
pending request, where it already exists. Pending: a look at the new fields on
the running installation.

Provider addresses without `/v1` (October 30, owner: "why need /v1 endpoint?";
"make it work for all things without the endpoint"): a custom provider's address
works with or without its API version. The connection check tries an address
without a version as typed, then with `/v1`, and Settings › Models saves the
address that answers and shows it; saved addresses are used as saved
([routes](tools/operations/provider/routes.py),
[checks](services/hermes/test_provider_routes.py),
[browser checks](test/dashboard-pages.browser.mjs)).

Logo (October 27, owner: "I want use something like it as project logo but need
improve it and compatible with our app design or make app design same it"): the
owner's pixel brain is redrawn on crisp grids and shown in the dashboard
navigation, phone header, mini app, favicon and README, and the dashboard colours
follow it: lavender accent, navy dark mode, mint for success
([decision](docs/adr/0180-pixel-brain-logo-and-logo-colours.md),
[logo](dashboard/ui/logo.tsx), [assets](docs/assets/logo)). The Telegram bot
picture (`docs/assets/logo/nocheh-avatar-512.png`) is set by the owner in
BotFather; it is not set yet.

Role and skills per chat (October 16 and 17, owner: "want to ability to set role
or skill for projects or GPs ... for a group or user use role and skills and for
other one use other role and skill"; "if can have role and skill for own Hermes
profile use it instead of imple in nocheh"): each selected group and the owner's
private chat now has its own role (Hermes `SOUL.md`) and skills (Hermes
`skills/`) in its Hermes profile, with defaults for every chat. The owner edits
them on the chat's page in Chats and the defaults in Settings › Assistant; turns
read them and cannot write them, and topics use their group's
([decision](docs/adr/0151-chat-role-and-skills-in-hermes-profiles.md),
[profile checks](services/hermes/test_persona.py),
[tool checks](services/hermes/test_scopes.py),
[brain checks](test/brain.test.ts),
[browser checks](test/dashboard-pages.browser.mjs)). The storage service had no
brain management route, so per-chat assistant limits, Memory › Assistant notes
and the CLI's profile commands could not reach Hermes; `/v1/brain/manage` now
serves them too. Projects have no role and skills of their own for now (owner, October 17:
"follow your recommend"). The first live group check (October 19) failed: the
reply ignored the role and never used the skill, because Hermes looked for
`SOUL.md` and `skills/` beside the session database in `native-state/` and
reused each continuing session's first system prompt. Turns now bind the
profile as the Hermes home and rebuild a session's prompt once after its role
or skills change ([checks](services/hermes/test_persona.py)); the repeated live
group check passed the same day
([register](docs/mvp-acceptance-status.md)). Pending: carrying roles and skills
across an original-only reset.

Built-in instructions (October 17, owner: "every hard coded text should
editable form dashboard"): the reply rules, remembered-facts and limited-memory
notes, Hermes notes review, secret check, group sharing filter and learning
instruction are editable in Settings › Assistant with a reset to the built-in
text; the owner's replacements travel with each runtime call
([decision](docs/adr/0152-owner-editable-built-in-instructions.md),
[Hermes checks](services/hermes/test_prompts.py),
[Node checks](test/prompts.test.ts), [storage checks](test/store-server.test.ts),
[browser checks](test/dashboard-pages.browser.mjs)). Pending: a live check that
an edited group rule changes a group reply; carrying the replacements across an
original-only reset.

Reply outage after the built-in instructions update (October 17–18): the owner's
development installation answered no new message from the October 17 pull of
that update until a rebuild. Live reload ran the new code, but store
provisioning runs only when PostgreSQL starts, from its image's own build, so
the instructions table was missing and every secret check, reply and memory
call failed at once. The detector live check calls Hermes directly and passed.
In development, PostgreSQL now reruns store provisioning from each finished
app build ([entrypoint](deploy/store-postgres-entrypoint.sh),
[check](test/test_store_postgres_entrypoint.py), [procedure](docs/deploy.md)).
On October 18 the owner's installation was rebuilt; the held secret checks
finished and the held messages were retried. The re-asked reaction recall
question then passed on its first attempt
([register](docs/mvp-acceptance-status.md)).

Honcho memory provider rejection (October 18): every Honcho model call through
the memory provider returned 403 since at least October 18, while replies and
the secret check used the same provider. The provider's browser check rejects
Python's default client name, which the Honcho meter sent; it now names itself
([meter](services/honcho/meter.py), [check](services/honcho/test_meter.py)).
After the fix the held Honcho memory jobs completed on the owner's installation.
Workflow failures kept only a generic reason, so the engine now logs each
failure's error kind, code and top frames ([engine](src/workflows/engine.ts)).
That showed the test's reaction-removal update failing its Honcho source step
with `memory_session_conflict`. Its audience followed the topic of the message
it reacted to, but its Honcho session key fell back to the chat-wide General
session, because Telegram sends reaction updates without a topic. A reaction
now uses its target's topic session ([entities](src/stores/entities.ts),
[check](test/store-relationships.test.ts)). The superseded reaction add is not
learned by design, because it is no longer the current reaction. On October 18
the held removal update reached Honcho memory on the owner's installation, in
the same topic session as its note.

Honcho memory message dates (October 18): a private-chat question about the
day's conversations dated that reaction removal to the hour its held Honcho job
was retried, not to the removal itself. Nocheh wrote Honcho messages without a
date, so Honcho dated each one by its write. Source evidence now carries its
event's time (Telegram's date, else its capture time); a learned interpretation
keeps the time it was learned ([native memory](src/stores/native-memory.ts),
[check](test/store-native-memory.test.ts)). Messages written earlier keep their
write time until their session is rebuilt.

Honcho learning query limit (October 19): one group-topic interpretation job
failed on every retry with `honcho_upstream_rejected`. Its learning query was
11,107 characters, and the pinned Honcho rejects a reasoning query over 10,000
characters before any model call. Applicable rules (3.6–4.5k) and the learning
instruction (3.5k) leave about 2k for observations, and successful jobs reached
9,757. The query now fits the limit: other evidence keeps only its text, then
rules are left out from the end, then the trigger keeps only its text, each
named in the query's limitations; an input that still cannot fit closes as
`input_limit` instead of retrying ([learning engine](src/stores/learning-engine.ts),
[check](test/learning-workflow.test.ts)). Honcho rejections now log their status,
route and failing field without content ([client](src/honcho.ts)). Since
November 10 the query can use 92,160 UTF-8 bytes, about half of Honcho's input
budget sized to the guard's 512 KiB, instead of 10,000 characters, and the same
trimming applies only past that
([decision](docs/adr/0228-hermes-and-honcho-built-ins-replace-nocheh-copies.md)).

Deep check for hidden data and failure gaps (October 18), verified locally with
synthetic PostgreSQL, not yet run on the owner's installation:
- A reply chain in an ordinary group carries a thread number but is not a topic;
  only forum topics are now treated as topics, in capture, Honcho sessions and
  Hermes ([spaces](src/spaces.ts), [Hermes scopes](services/hermes/scopes.py)).
- A reaction no longer cancels or drops a reply in progress: its epoch advance
  waits for the reply, and a reply whose context changed is retried
  ([reaction state](src/stores/reaction-state.ts),
  [check](test/store-telegram-dispatch.test.ts)).
- A Honcho write that never arrived is resent after ten minutes, a rejected one
  is retried, and an old Honcho derivation failure no longer holds memory
  "building" ([native memory](src/stores/native-memory.ts),
  [queue health](services/honcho/provenance.py)).
- A reaction no longer renames a person; failure causes reach logs and the
  Hermes result; a rate-limited fallback reply is retried; replies no longer
  inherit the replied-to message's files; Health shows unsaved incoming
  messages and reply states; message times no longer show "Invalid Date"; the
  history retention setting reaches the app.
- The four gaps found but left for the owner's decision are fixed below.

Known gaps fixed before the release tests (October 19, owner: "yes" to fixing
them before the Telegram tests), verified locally with synthetic PostgreSQL,
not yet run on the owner's installation:
- A Telegram file over 20 MB, which the Bot API never lets a bot download, now
  settles as a reference without a download (or after Telegram refuses it) and
  no longer holds the reply; the turn says a file was over the limit
  ([attachments](src/stores/attachments.ts),
  [check](test/store-preparation.test.ts)).
- A group turn opens with the speaker's guarded name and @username and the send
  time in UTC, never a Telegram ID, outside the Honcho memory query
  ([dispatch](src/stores/telegram-dispatch.ts),
  [checks](test/store-telegram-dispatch.test.ts),
  [Hermes checks](services/hermes/test_turn_process.py)).
- Only the latest revision of an edited message stays in Honcho memory
  ([decision](docs/adr/0154-message-edits-replace-honcho-writes.md),
  [check](test/store-native-memory.test.ts)).
- An album gets one turn and one reply on its first part, with every part's
  text and files ([decision](docs/adr/0155-albums-answered-once.md),
  [check](test/store-telegram-dispatch.test.ts)).
- Imported group history no longer repeats what the bot saw live: Desktop
  senders are the same people as live senders, and a supergroup or channel
  export mapped to its live chat shares the live messages, which win in search
  and Honcho memory; a newer export replaces an older one
  ([decision](docs/adr/0156-desktop-exports-share-proven-telegram-identities.md),
  [check](test/store-desktop-import-identity.test.ts)).
- A forum export mapped to its live group keeps its topics: the importer
  follows reply links to each topic's creation message
  ([decision](docs/adr/0171-desktop-forum-messages-keep-their-topics.md),
  [check](test/store-desktop-import-identity.test.ts)). A mapped export now has
  its chat's audience, so imports with learning approved are learned (before,
  they waited forever), and an exported copy of the bot's own reply counts as
  already kept ([check](test/store-desktop-import-identity.test.ts)).
- Release test 1 (October 19) passed its addressing part on the owner's
  installation: an unaddressed group message stayed quiet and a Reply was
  answered in about 24 seconds. Its recall part failed: the answer could not
  see the unaddressed message. A group turn now carries the messages since the
  last turn ([decision](docs/adr/0157-group-turns-see-recent-unaddressed-messages.md),
  [check](test/store-telegram-dispatch.test.ts),
  [Hermes check](services/hermes/test_turn_process.py)).
  The rerun on the change carrying it passed: the Reply named the unaddressed
  question once, in about 23 seconds.
- Release test 2 (October 19): Nocheh drafted the requested group message and
  waited for approval, but told the owner to approve it in an old dashboard
  name. Approved in the Inbox, it was delivered once about 2 seconds later. The owner asked for a button under the message, in private chats and
  groups. A pending action now gets Approve and Reject buttons in its own group
  or topic, or in the owner's private chat; only the owner's press decides and
  the card then shows the outcome. Stale "Nocheh Activity" and "Activity
  Decisions" wording now says the dashboard Inbox
  ([decision](docs/adr/0158-telegram-approval-buttons.md),
  [check](test/store-approval-buttons.test.ts),
  [Hermes check](services/hermes/test_approval_cards.py)).
  Card layout, button labels, outcomes and notices are now owner-editable
  templates in Settings › Instructions; the Telegram command replies are
  still fixed in code. On the owner's
  installation a button press in the group approved and delivered the post
  once. The card now also says when the message was sent.
- After that test the owner asked that allowed people post freely in their own
  group, that approval talk happen in the private chat, and that people who are
  not allowed get a fixed reply, and that a message from one group to another
  is shown and approved because it is made from the first group's memory. A
  same-group post by the owner or a permitted participant now needs no
  approval, a group turn can list the groups where the person asking is
  allowed, cards go to the owner's private chat, and an unallowed member who addresses Nocheh gets one editable reply
  without a turn ([decision](docs/adr/0159-group-members-post-freely-and-approvals-go-private.md),
  [check](test/store-approval-buttons.test.ts),
  [Hermes check](services/hermes/test_approval_cards.py)). Not yet run on the
  owner's installation. Live check on the owner's installation (October 19,
  with this change and the quote fix): a same-group post went out once with no
  card and no other reply; a request in the group for the owner's private chat
  put one card in the private chat and one short note in the group, and the
  owner's button press delivered the message once about 4 seconds later, with
  the card showing the outcome. The owner then decided that an allowed member reviews
  their own message to another group where they are also allowed, or to
  another topic when topics keep separate memory: the card
  appears under the request in the group, and only that member or the owner
  can press it. The owner's own request from a group for their private chat
  needs no approval ([decision](docs/adr/0161-requesters-review-their-own-cross-group-messages.md),
  [check](test/store-approval-buttons.test.ts)). Open question to the owner: whether memory should
  stay per group, shared between groups only through owner sharing rules (the
  recommendation), or be shared across all groups or projects of one person.
- Release test 3 (October 19) passed on the owner's installation: Hermes
  restarted about 2 seconds into a private turn, after the input check and
  Honcho recall and before the model call. The first attempt failed as
  unavailable, the automatic second attempt delivered exactly one reply about
  44 seconds after capture, and every service was healthy afterwards. A restart
  during the model call itself was not separately repeated.
- Owner task list (October 19): the owner asked for a Telegram mini app to
  manage Nocheh, Nocheh's own task manager in it, and Notion through MCP as an
  optional extra. Step 1 is in source: a Tasks page in the dashboard and a
  `tasks` assistant tool for the owner's private chat over one list in
  the control store ([decision](docs/adr/0160-owner-task-list.md),
  [check](test/store-tasks.test.ts), [broker check](test/knowledge-broker.test.ts),
  [tool check](test/mcp.test.ts),
  [browser check](test/dashboard-pages.browser.mjs)). Live check pending: ask
  Nocheh in the private chat to add, list and finish a task.
- Telegram mini app (October 19): Home, Inbox and Tasks in Telegram through a
  credential-free mini app service and a Cloudflare tunnel, turned on in
  Settings › Telegram ([decision](docs/adr/0162-telegram-mini-app.md),
  [setup](docs/telegram.md#mini-app), [check](test/mini-app.test.ts),
  [settings check](services/hermes/test_settings.py)). Pending: a live open
  from the owner's phone; the owner tests it on the MVP installation, not the
  local one. Next: the optional Notion connector.
- Task lists, links and tags (October 19–20): personal tasks and each
  project's own list; a task can point to a group and people and has a list
  of tags; a project's chat reaches only its own list
  ([decision](docs/adr/0164-task-lists-links-and-tags.md),
  [check](test/store-tasks.test.ts), [browser check](test/dashboard-pages.browser.mjs)).
  Live check pending: ask Nocheh in a project's group to add a task, and see it
  only in that project's list.
- Tasks like a Notion table (October 26): the owner asked for a task
  structure that covers all the domains of Notion and other task managers so
  it does not change later, and chose everything plus a board and Today.
  Statuses, priority, start and due times, repeats, Telegram reminders,
  subtasks, dependencies, assignees, manual order, custom columns, comments,
  history, attachments, Markdown notes, archive and trash, and outside IDs;
  Today, Upcoming and Board views; Settings › Tasks
  ([decision](docs/adr/0167-tasks-like-a-notion-table.md),
  [check](test/store-tasks.test.ts), [browser check](test/dashboard-pages.browser.mjs),
  [tool check](test/mcp.test.ts)). The first start drops
  existing tasks. Live check pending: set a reminder a few minutes ahead from
  chat and see it arrive once in the private chat. Later: calendar view and
  saved views.
- Notion through MCP (October 26): the owner asked "how can connect Notion
  (use MCP)?". Settings › Connections › Notion signs in through Notion (or a
  Business MCP token), turns Notion on, and chooses which calls ask first;
  the `notion` tool works only in the owner's private chat
  ([decision](docs/adr/0175-notion-through-its-mcp-server.md),
  [check](test/store-notion.test.ts), [sign-in check](services/hermes/test_notion_connection.py),
  [browser check](test/dashboard-pages.browser.mjs)). November 1: the
  dashboard refused Notion's return to it as a cross-site request, so sign-in
  could never finish; a tab opened from another site now gets a page that opens
  the same address again from the dashboard ([check](test/management.test.ts)).
  Live check pending: the
  owner connects Notion on the development machine and asks Nocheh to search it, then to add a
  page and approves the card.
- Release test 4 (October 20) passed on the owner's installation. A private
  message stating a synthetic locker code got one reply. Hiding it and
  Nocheh's reply made a later question answer once without the code; the code
  appeared in no replayed history, tool result or Honcho output. After Undo on
  the message alone, the code returned from the restored message through
  archive search and Honcho, while the still-hidden reply was used nowhere.
  The memory lookups after the hide and the Undo took 52 and 32 seconds:
  sequential Honcho reasoning rounds, each passing the input check, and a
  re-prepared guard cache after the epoch change.
- The same check found that each guard epoch gives a chat a new Hermes profile
  with an empty conversation, so Nocheh forgot the ongoing chat seven times in
  two days, four after automatic learning. In source on a branch: a new
  epoch's profile is seeded once with the chat's recent messages and delivered
  answers, and retirements apply before its first turn
  ([decision](docs/adr/0163-chat-conversation-carries-into-new-guard-epochs.md),
  [check](services/hermes/test_profile_history.py)); the owner chose to fix it
  before the MVP. Earlier-epoch profiles are not yet pruned.
- Release test 5 (October 20) passed on the owner's installation: a group
  member who had never posted added, changed and removed a reaction on an
  older message. Each update was captured once and in order, the current state
  ended empty, Nocheh sent nothing and no errors were logged. Each update
  advanced the guard epoch, so busy reactions start new per-epoch Hermes
  profiles, which are not pruned.
- Release tests rerun on the upgraded installation (October 26): test 1
  passed; a privacy check's provider error delayed the first answer by one
  30-second retry. In test 2 the card and its Reject button worked, but Nocheh
  also answered separately and the card said only "a Telegram group". The card
  is now the reply to the request and the whole answer, and it names and links
  the group and topic
  ([decision](docs/adr/0165-approval-card-is-the-answer-and-links-its-place.md),
  [checks](test/store-approval-buttons.test.ts),
  [runtime checks](services/hermes/test_approval_cards.py)). Asking again
  after the rejection got no new card: the lookup of the earlier request was
  refused because it came from a later turn, and Nocheh said it was still
  waiting. A chat's later turns can now read and list its own requests, and a
  finished request is asked again as a new one
  ([decision](docs/adr/0166-a-chat-follows-its-own-message-requests.md)).
  Test 2 then passed: one card, Approve, one group post, and the card showed
  it was sent. Test 3 passed: the restart cut the first turn, its retry
  answered once, and each of three messages got exactly one reply. Two of those
  replies brought up the earlier post unasked and called it unconfirmed after a
  60-second lookup whose content check failed on a provider error, so the list
  of a chat's requests no longer carries their text, and Nocheh looks requests
  up only when asked and calls a failed lookup unknown. The third message waited
  184 seconds in the reply queue after the restart; not yet explained.
  Test 4 also showed the previous epoch's profile still holding the hidden
  reply, so superseded profiles are now removed once idle and carried over
  ([decision](docs/adr/0168-superseded-epoch-profiles-are-removed.md),
  [checks](services/hermes/test_profile_history.py)). Hermes background
  requests refused by the privacy guard are now recorded with their method,
  host, path and query names, without values, to find and fix their source.
  The 184-second wait in test 3 was Inngest refusing the reply's run because
  the pipeline worker's four request slots were full during background work
  after a memory change, then retrying it with backoff; the worker now accepts
  eight ([decision](docs/adr/0169-reply-runs-are-not-refused-for-worker-capacity.md)).
  The 50-second memory recall after the test 4 hide was Honcho's three
  reasoning rounds plus secret checks of text already checked before the
  epoch changed; those results now carry across epochs
  ([decision](docs/adr/0170-secret-check-results-survive-guard-epochs.md),
  [check](test/store-prepared-context.test.ts)).
  The recorded guard refusals were Hermes asking the provider for its model
  list twice per turn, and two DNS-over-HTTPS lookups at startup. A bare model
  list now passes; the lookups stay refused
  ([decision](docs/adr/0172-provider-model-lists-pass-the-guard.md)).
Pending: a live album, an edit and a small group-export import on the owner's
installation.

Re-running and replacing Honcho memory (October 19): Memory › Long-term memory
and `./bin/nocheh memory longterm` can retry failed Honcho learning in place,
re-learn every chat or chosen chats from their saved messages, or replace the
workspace with a new one that learns the archive again or starts empty, each
after an estimate ([decision](docs/adr/0153-owner-reruns-and-replaces-honcho-memory.md),
[checks](test/store-memory-rebuild.test.ts),
[plugin checks](services/honcho/test_provenance.py),
[browser check](test/dashboard-pages.browser.mjs)). On the owner's installation
the live retry re-ran the 2 failed learning tasks and Honcho memory returned to
ready with none failed or waiting. Read-only counts found no gap left: there was
no incoming traffic from October 13 12:18Z to October 18 11:06Z, and the
messages on either side link to Honcho conclusions at the usual rate, so no
re-learn is needed. Re-learning or replacing the owner's live memory waits for
the owner's word.

Upgrades (November 9, owner: "want to update hermes + honcho and other packages,
for services check the change log to understand what is new and can use it and
what is changed and need code update in our side"): Hermes v0.23.0, Honcho v3.6.0
(`honcho-ai` 2.8.0, `honcho-cli` 0.4.0; built on the Python 3.13.18 digest with
uv 0.13.5, as Honcho's Dockerfile names), Inngest server 1.51 with SDK 4.26.2,
Node 26.13.0, Python 3.14.10, uv 0.13.7, Redis 8.10.3, cloudflared 2026.10.7,
Docker CLI 29.9.3, the Playwright 1.65 tester image, graphql 17.1, lucide-react
1.70 and Tailwind 4.3.5. PostgreSQL 18.6, pgvector 0.8.7 and pgweb have no newer
release; Python stays on 3.14, because Hermes does not support 3.15; typer stays
on 0.28.0. Nocheh's own PDF reader and unpdf are removed (owner: "yes remove ours
and use hermes"): Hermes' document reader reads every PDF. What the new versions
changed on Nocheh's side: Hermes' memory tool now sends its writes inside
`operations[]` (as a list, a JSON string, or JSON-string items), so retiring a
turn also withholds the native notes it added that way and the entries its
patches landed in (spans of 4 or more characters)
([check](services/hermes/test_retired_history.py)); the tester saves its note in
that shape; Hermes takes round video
notes itself, so Nocheh's extra handler is gone; the browser TUI's `/rewind` says
rewind is unavailable, inline pictures are off
([profile check](services/hermes/test_profile_config.py)), and the dashboard
patch follows the new Vite config. The Honcho memory export carries the new
citation table (`conclusion_source_messages`), setup stops when a locked Honcho
build image no longer matches Honcho's Dockerfile or any build image lacks a
digest, and a malformed work unit is
left to Honcho, which now frees its worker ([setup](services/honcho/test_setup.py),
[boundary](services/honcho/test_boundary.py)). The Workflows page rewrite
follows the 1.51 modules and still fails closed on any other build, and its
query gate refuses empty selection sets, which graphql 17.1 parses
([inspection checks](test/workflow-inspection.test.ts)). Checked here without
Docker or PostgreSQL: the Node build and suite on Node 26.13.0 (359 tests, 214
pass, 141 skipped; the 4 failures need PostgreSQL or a service token, as before
the upgrade), dashboard format, Hermes plugin tests on 0.23.0 (848 run; the 3
errors are environment-only, as on 0.22.5), Honcho tests (52 pass), the pin
consistency check, the patched Hermes dashboard and TUI builds, and the page
rewrite against the real Inngest 1.51 assets.
Pending: a real build of every image (with the Hermes native contract tests, the
browser tester image and Compose 5.7 in the management image) and the full
fake-Telegram tester run; the PostgreSQL-backed Node tests in the development
image's runner (they pass on the host, below), the Inngest 1.51
inspection fixture test and the Honcho export rehearsals; a rebuild on the
owner's development machine and a live reply; Honcho's first boot running its
new migrations on existing data; the Workflows page in a real browser (assets under
`/inngest`, no root `/v0/gql` or `/dev` calls, Monaco and Quickstart off);
`/rewind` and pictures in the browser TUI, `/new` while a turn is running, and a
TUI reconnect on uvicorn 0.54's WebSocket stack; isolated Anthropic and OpenAI
turns on the new SDKs (anthropic 0.125, openai 2.54).
Second change on the same branch (owner: "I like this one, dont apply limit use
memory fully and use all features." and "yes" to the Hermes instruction refresh,
exact memory sources, the bigger question limit and the Persian voice fix;
[decision](docs/adr/0228-hermes-and-honcho-built-ins-replace-nocheh-copies.md)):
a role or skill change asks Hermes' own prompt refresh for the profile instead of
Nocheh's per-session marker ([check](services/hermes/test_persona.py)); memory
evidence follows Honcho's exact message citations per conclusion and marks a
conclusion that only has its derivation batch as inexact
([plugin check](services/honcho/test_provenance.py),
[reader](test/store-provenance.test.ts)); setup sets Honcho's longest question
(200,000 characters) and 61,440-token reasoning and summary inputs within the
guard's 512 KiB, and the learning query fits 92,160 UTF-8 bytes instead of 10,000
characters ([setup](services/honcho/test_setup.py),
[check](test/learning-workflow.test.ts)); learning asks Honcho for its result
schema with every dialectic level in `json_object` mode, and Nocheh's own JSON
recovery is gone ([check](test/store-learned.test.ts),
[engine](test/store-learning-engine.test.ts)); the meter sends archive preparation
as UTF-8 ([check](services/honcho/test_meter.py)); voice transcription sends no
language hint ([check](services/hermes/test_voice_text.py)). Checked here: the
Node suite (361 tests, 216 pass, 141 skipped without PostgreSQL, the same 4
PostgreSQL failures), every compiled Node test file on the host against its own
fresh synthetic PostgreSQL 18.6 (155 files: 361 pass, none fail, 4 skipped that
need a container, workflow or Inngest fixture), Hermes plugin tests (849 run,
the same 3 environment errors), Honcho tests (58 pass), and Honcho 3.6.0's own migrations and models
under the provenance query (citation order, batch fallback, deleted ancestors,
workspace scoping). Pending: a live Honcho deriver writing citations under
`json_object` and how often its model leaves them out; recall through Hermes
listing the cited messages first; learning against the live memory provider with
`response_format` (Honcho's repair and retries, `json_object` beside tools) and
the archive's preparation round trip; a role change reaching a continuing chat
in a real isolated turn, where the gateway writes the turn profile's `state.db`;
a Persian voice note transcribed without the hint. Existing conclusions get
citations only when Honcho memory is rebuilt. Also
next: pin PostgreSQL 18.7 and the rebuilt pgvector 0.8.7 digest after its
2026-11-12 release; the subscription compatibility setup needs host uv 0.13.6 or
newer for Python 3.14.10; audit typer 0.29; `/rewind` still shows in the TUI's
command list, which comes from Hermes' server-side catalog; the host's Docker
engine needs its own security update, which the CLI image does not carry.
Earlier upgrades are in [task history](docs/task-history.md).

</current>

<verification>

- Unclear outcomes close (2026-11-08,
  [ADR-0218](docs/adr/0218-unclear-outcomes-close-by-the-owners-word-or-as-a-read.md)):
  Waiting kept web page reads marked "Unclear if it ran" for good. An unclear
  page read now closes by itself; any other unclear operation or message waits
  until the owner presses It ran, It didn't run or Dismiss in its drawer. The
  receipt stays as observed, nothing runs again, and Health stops counting closed
  ones as uncertain. Checks: [closing](test/store-action-resolutions.test.ts),
  [messages](test/store-telegram-actions.test.ts), the dashboard
  [drawer](test/dashboard-pages.browser.mjs) and the agent's
  [status keys](test/mcp.test.ts). Pending: after merge, the
  owner's two existing reads leave Waiting once the development schema update
  runs (automatic on the next build in `make dev`).
- One message when already allowed, stage C (2026-11-08,
  [ADR-0215](docs/adr/0215-an-allowed-operation-answers-in-the-same-turn.md)): an
  operation that a rule or the owner freedom setting already allows is waited for
  in the turn, up to 60 seconds, and answers in that reply. Once the tool holds
  the result, it notes the state it read; the follow-up skips only that answer,
  and a lost note or a follow-up turn's note leaves the follow-up in place. Checks:
  [in-turn wait](test/mcp.test.ts),
  [skip rule](test/action-continuations.test.ts),
  [marks and skips](test/store-action-continuations.test.ts), and the tester
  scenario `allowed_command_runs_without_a_card`.
- Allow a site or command in one chat, stage B (2026-11-08,
  [ADR-0214](docs/adr/0214-allow-a-site-or-command-in-one-chat.md)): the owner
  asked for Claude Code-style auto-approve built on Hermes's approval words. A web
  read's card offers Allow once, Allow where asked for 12 hours, Always allow this
  site where asked and Reject; a command's card, Allow once, Always allow it where asked and
  Reject. A chat rule covers one site or exact command in one chat or topic, and
  survives epochs; deny rules still win. Checks:
  [rules](test/store-action-rules.test.ts), the gateway's
  [card buttons](services/hermes/test_approval_cards.py), and the tester scenario
  `allowed_command_runs_without_a_card`.
- Answers come back to the chat that asked, stage A (2026-11-08,
  [ADR-0212](docs/adr/0212-approved-operations-answer-in-the-chat-that-asked.md)):
  the owner decided that once an approved operation ends, the agent continues in
  the chat that asked and answers there. The details follow the plan's
  recommendations and await the owner's review: the answer is a reply to the
  asking message in its topic, a rejected, failed or unconfirmed operation still
  gets one short line, one asking message gets at most three follow-ups, and the
  first reply says the answer will follow. Each end state of a live conversation's operation now
  commits a follow-up row and a `continue:` workflow; the follow-up waits for the
  asking reply, merges siblings, skips the owner's own private rejection, and
  starts a Hermes turn through an internal event; the text that starts it is
  "After an approved operation ends" in Settings › Instructions. Checks:
  [helpers](test/action-continuations.test.ts),
  [follow-ups](test/store-action-continuations.test.ts),
  [trigger](test/store-controlled-execution.test.ts),
  [wording](test/store-approval-buttons.test.ts), and the tester scenarios
  `approval_waits_across_a_change_and_runs` (private chat) and
  `group_operation_answers_in_topic` (group topic). Later stages, not built:
  allow buttons with chat grants (B), and a short in-turn wait for an operation
  already approved (C). A follow-up interrupted by a runtime restart stays
  uncertain; a follow-up that failed three times is not retried from the
  Workflows page.
- A decided card loses its buttons, and a refused page read is a failure (2026-11-08):
  a group weather read's card kept Approve and Reject after the owner approved it,
  because Telegram's answer to the card send was lost, so no message id was saved.
  A press on a message that carries the card's button names that message, so the
  store passes it with the edit; the gateway keeps it for later edits, and uses it
  only for a card it tried to send to that same chat. The read then ended uncertain, because
  the service answered with JSON and the receipt filed every failure as
  unconfirmed. A web read now returns a JSON or plain-text answer as text, and a
  failure with a known outcome (nothing sent, or a page read that got its whole
  answer) is failed with its fixed code, which `controlled_actions.error_code`
  keeps. Checks: [card settle](services/hermes/test_approval_cards.py),
  [press message](test/store-approval-buttons.test.ts),
  [receipts and page reads](services/hermes/test_controlled_tools.py).
- Reactions while Nocheh works (2026-11-08,
  [ADR-0211](docs/adr/0211-hermes-working-reactions-on-the-answered-message.md)):
  the owner asked whether the bot can react to users' messages and chose
  Hermes's built-in reactions. The committed adapter now runs Hermes's own
  Telegram hooks around a turn: 👀 on the message it answers, then 👍 once the
  reply is sent or 👎 when it failed; silence, cancellation and an uncertain
  delivery clear it. Each reaction is bound to that exact message and the
  space's permission and skips the outbound journal; Settings › Telegram "React
  while working" turns them off. Checks: [simulation tests](services/hermes/test_telegram_simulation.py)
  and the full tester scenario `reactions_show_while_working`. Pending: seen on
  the owner's live install after the machine pull.
- Operation cards read in words (2026-11-08,
  [ADR-0213](docs/adr/0213-operation-cards-read-in-words.md)): the owner showed a
  Notion card that was one block of raw JSON and asked "make msg readable". A
  shell, browser or MCP card now names what it does ("Notion · create pages") and
  shows every field of the exact input after a bold label, long text in a quote
  that opens on a tap, short text with line breaks in a quote shown whole, a
  command as code; text with a hidden character, or a key or value that could
  pass for something else, is quoted with the character written out; two keys
  that read alike by Unicode's confusables show the JSON in code with every
  non-ASCII character as its code; a web page names its host; past
  3,000 characters or 90 entities it shows the exact JSON as before, and an operation
  too long even then gets no card. Checks: [words](test/action-text.test.ts),
  [cards](test/store-approval-buttons.test.ts),
  [list cards](test/store-background-job-changes.test.ts),
  [Hermes check](services/hermes/test_approval_cards.py) and the full tester
  scenario `tool_card_reads_in_words`. Pending: a real Notion card on the owner's
  live install after the machine pull.
- Typing while Nocheh works (2026-10-28,
  [ADR-0188](docs/adr/0188-typing-status-while-a-turn-works.md)): Telegram
  showed nothing while a reply was being worked on, because native typing is
  off and the committed adapter replaces the code that starts it. A committed
  turn now renews "typing…" every four seconds in its own chat or topic until
  the answer is ready or the turn fails, under the reply's audience check and
  outside the outbound journal; Settings › Telegram can turn it off. Checks:
  [simulation tests](services/hermes/test_telegram_simulation.py) and the full
  tester scenario `typing_shows_while_working`. Pending: seen on the owner's
  live install after the machine pull.
- Menu still shown in the default scope after the strangers change (2026-10-28,
  [ADR-0182](docs/adr/0182-strangers-cost-nothing-and-reach-no-model.md)):
  after the development-machine pull the private and group menus were empty but the default
  scope still listed 33 commands. Cause: the clearing lived on the capture
  adapter's menu step, but the adapter that connects skips all native
  post-connect housekeeping, so it never ran. That adapter now clears the
  menu after each connect, reads each scope back, rechecks a minute later and
  retries, and also clears the selected groups' own menus. The Hermes capture
  tests cover the connect path, a rate-limited scope, a menu that comes back
  and a group the bot has left. The fake Telegram now starts with a leftover
  default and forum-group menu; `menu_shown_to_nobody` failed on that before
  the fix.

- Strangers kept away from models, downloads and the menu (2026-10-27,
  [ADR-0182](docs/adr/0182-strangers-cost-nothing-and-reach-no-model.md)):
  the new store test `store-strangers` and every Node test file pass on a
  fresh store cluster; the Hermes refusal tests pass. A fresh cloud run of
  the full tester passed 61 of 62; the miss was the new scenario's own search
  gate matching the owner's query message. After that gate was corrected,
  `menu_shown_to_nobody` and `stranger_in_private_gets_one_reply` passed on a
  fresh fixture: no command menu in any scope, one fixed private reply for a
  file and two slash commands, no model turn, no download, and nothing in the
  owner's search, conversation or identity lists. Not yet run on the development machine
  or against live Telegram.

- Settings apply followed to its end (2026-10-27, revision 5f1010e,
  [ADR-0178](docs/adr/0178-settings-apply-is-followed-to-its-end.md)): the
  full tester on the development machine, beside the live stack, passed the new
  `settings_apply_is_followed_to_the_end` scenario (a reload mid-apply sees
  it, the apply completes with its steps, settings in use afterwards), the
  lingering-turn check and every dashboard page. The browser test passes
  20/20, including a slow apply with a reload and an apply the dashboard
  lost. The fixture's apply recreates no container, so the slow path is
  covered by the browser test; 9b8d61a only lengthens the restart timeout.

- Full end-to-end tester (2026-10-27, revision c650887, cloud synthetic
  installation): `python3 -m tools.acceptance.full_test` passes all 59 checks
  in one fresh run: the 38 earlier simulator scenarios, 19 product scenarios
  (allowed members, addressing, unaddressed messages, the fixed reply for
  people not allowed, approval cards pressed in private chat and groups,
  hide and unhide, reactions keeping group names, learning reaching Honcho,
  Inbox person cards, a Telegram Desktop import with a topic and a file,
  tasks with reminders, defaults), the lingering-turn check and 34 dashboard
  pages and tabs in Chromium. The owner allowed it to run beside the live
  installation and asked that it need no action from them. It found and
  verified a fix for every dashboard page crashing when container status is
  unavailable. It also showed a temporary failure while Nocheh prepares text
  for Honcho answered with HTTP 403, which Honcho never retries, so that batch
  was not learned; [ADR-0174](docs/adr/0174-memory-preparation-outages-are-retried.md)
  now answers 503 for it. Pending: the same run on the development machine beside the
  live stack. [Procedure](docs/telegram-simulation.md).

- Personal-use mocked-Telegram evaluation (2026-10-08, current source): every
  Node test file passes on its own fresh synthetic database (269 passes, four
  fixture-dependent skips); all 439 Hermes/Honcho and 100 tooling Python
  checks pass. A fresh 16-service installation passes its 19 coupled checks,
  the ordinary and faults-and-files HTTP Telegram runs, and the
  [personal-use scenario suite](tools/acceptance/telegram_scenarios.py):
  all 31 scenarios and 288 gates pass with no unmodeled Bot API method, and
  the raw synthetic secret never reached a model call. The suite drives real
  Hermes polling, three stores, Inngest, Honcho and Nocheh tools through a
  scripted fixture brain and a substituted speech service; it does not
  measure model judgement, real transcription or real Telegram. It found and
  verified repairs for a reply never transmitted during a polling reconnect,
  which had been recorded as uncertain and lost; for replies to messages sent
  together arriving out of order; and for a blank voice transcription that
  left its dispatch waiting indefinitely. [Decision](docs/adr/0104-telegram-update-order-and-untransmitted-sends.md),
  [procedure](docs/telegram-simulation.md), [history](docs/task-history.md).
  A later fresh installation with the follow-up repairs passed the 19
  coupled checks, both HTTP runs and every scenario, including terminal
  Telegram rejections, retirement offers and no lingering turn containers; a
  launcher stopped mid-turn left no container and the reply arrived once.
  The per-file storage helper passes 270 Node checks; 440 native and 100
  tooling Python checks pass.

- Personal-use Telegram simulation has passing native, storage, workflow,
  portability, host-isolation and provider-contract evidence across the
  [scenario matrix](docs/telegram-simulation.md). These are synthetic checks;
  [task history](docs/task-history.md) retains the original failures, repairs,
  revisions and carried evidence. Scripted inference does not establish model
  intelligence or actual provider quality.

  The latest byte-verified native/service candidate passes thirteen HTTP Bot API
  fault/file gates: cold-context first-attempt replies, physical `429` delay,
  exact topic and rejected/delivered receipts, one confirmed send, transient file
  recovery with original bytes/hash, denied-private silence and restart without
  duplicate sends. The separate ordinary run passes fourteen gates, including
  private, named-topic and General replies on their first attempts. It starts
  with two abandoned one-hour native leases: actual isolated startup reclaims
  both in the same profile, preserves every earlier message hash, and delivers
  the owner reply in 22.1 seconds. The exclusive profile lock, native fencing,
  current authority and original acceptance deadlines remain active.
  [HTTP runner](tools/acceptance/telegram_rehearsal.py),
  [SDK checks](services/telegram/test_telegram_http_fixture.py),
  [lease decision](docs/adr/0098-isolated-native-lease-recovery.md).

  Guard preparation publishes at most four independent copies concurrently,
  drains started work before releasing a failed audience queue, and checkpoints
  at most 500 fragments per detector batch. Three actual PostgreSQL checks pass
  without skips, including failed-sibling recovery and all 501 fresh fragments.
  The initial wrong-root container test record is disqualified; replacement
  checks verify runtime and test bytes before execution. Packaged source hashes,
  TypeScript compilation and the AST-only graph update pass. Five packaged
  native lease checks and eighteen adjacent native checks also pass.
  [Context checks](test/store-prepared-context.test.ts),
  [recovery checks](services/hermes/test_native_leases.py).

  Real-model observation found transport envelopes entering the same detector
  queue as their individual messages. Capture now preserves exact wire bytes,
  original records and recovery receipts without automatically preparing each
  envelope. Actual updates retain their preparation and dispatch workflows;
  unprepared retrieval still fails closed. Three storage/recovery checks and
  three adjacent preparation/generated-capture checks pass without skips.
  TypeScript compilation and the candidate image's runtime/test hashes pass.
  A seed-reusing real-model run passes reaction removal, the edited meeting
  time and private-to-group isolation on their first attempts in 118.2, 131.6
  and 89.4 seconds. Each answer has one correctly routed physical reply and a
  matching archived delivery. A fresh-topic case fails before delivery; these
  partial passes do not establish cold ingestion or complete model quality.
  [Capture checks](test/stores.test.ts).

  A read-only inspection of the isolated model fixture found that from
  2026-10-03 21:36 UTC, 78 new Honcho memory-context artifacts contained only
  eight distinct content hashes. All 78 guard sources remain pending, with no
  staged guard revision, fragment, or guard publication. Detector admissions
  rose from 2-8 to 31-60 per minute at that boundary, before the operating
  provider container stopped at 22:09 UTC. The fixture scheduler recorded
  worker-capacity errors during the same period. These observations locate the
  stall before guard publication but do not prove the first detector failure's
  cause. Positive provider and first-attempt ready-memory verification remain
  pending. On 2026-10-05 the local Docker socket was absent; no fixture or
  operating container was changed. Aggregate evidence is in ignored fixture
  state; [history](docs/task-history.md) retains the observation.
  A relay candidate now records a separate, content-free result for each
  admitted request: admission number, upstream header/error category, HTTP
  status, and time to headers/error. Eleven networkless checks pass, including
  provider HTTP and transport failures without credential/body leakage. This
  diagnostic cannot recover outcomes for the 2,665 earlier admissions; the
  coupled fixture results are recorded below. Relay (removed `tools/acceptance/model_relay.py`),
  checks (removed `test/test_model_relay.py`).

  With Docker restored by the owner, the 16-service fixture passed health
  startup, but 45 new model admissions included 33 upstream HTTP 503 and one
  HTTP 502 during a detector burst. The fixture was stopped with zero services
  left running. Two isolated benign route probes then received HTTP 200, so a
  healthy CPA socket and isolated success do not establish capacity under
  coupled load. The previously timed-out retirement event delivered one
  archived non-disclosing answer on one dispatch attempt after restart; its
  original timeout remains failed and this is not a fresh first-attempt pass.
  The owner Honcho generation is ready, but 81 generated memory contexts remain
  unguarded. A fixture-only detector pacing option has eleven networkless
  checks. With a five-second detector interval, the owner Honcho snapshot
  caught up and a fresh retired-fact question passed semantic non-disclosure
  on its first dispatch attempt in 64.2 seconds: one physical reply, matching
  archived delivery, all three independent named sources retired, originals
  preserved, guard on, and `limited_memory=false`. The watched paced run's 114
  model outcomes all reached upstream HTTP 200 headers. All sixteen fixture
  services are stopped with state preserved. This does not prove unthrottled
  provider reliability; the cause of the earlier 503 burst and cold full-quality
  rehearsal remain pending.
  A subsequent unused-topic question failed on its first Hermes attempt with
  `model_unavailable`. During its retry window the provider returned 769 HTTP
  429 results, all on detector calls. The workflow ultimately delivered one
  non-disclosing reply in the correct topic on attempt 16, about 69 minutes
  after the question, with one archived original and one outbound receipt.
  This fails the first-attempt and latency gates. The fixture is stopped and
  preserves the original failure. The relay now blocks further upstream
  admissions during a restart-safe bounded cooldown after HTTP 429; eleven
  networkless relay checks pass; a twelfth check confirms that a late success
  from an already-running request cannot clear the cooldown. Coupled cooldown
  behavior remains unverified;
  a fresh-topic first-attempt recheck was then run after provider recovery.
  After provider recovery, a different unused topic passed the focused
  first-attempt and timing gates in 176.4 seconds. One physical reply reached
  topic 18, its delivery was archived, and its text contained neither the
  forbidden other-topic time nor the private synthetic name. The watched run
  and shutdown interval recorded 41 new upstream HTTP 200 outcomes and no 429.
  All sixteen fixture services are stopped, while the operating provider remains
  healthy. This result does not erase the failed topic-17 attempt, exercise the
  cooldown under an actual 429, or establish unthrottled reliability.
  [Procedure](docs/telegram-simulation.md).

  A fresh current-source, isolated 16-service fixture then completed all six
  cold real-model quality cases on their first Hermes dispatch attempts. Each
  produced one physical and archived reply within the five-minute gate;
  bounded semantic review passed reaction removal, correction, private and
  topic isolation, restart recall, and non-disclosing retirement. The two
  captured retired originals were preserved. Honcho was attached and verified,
  but the answer at retirement had `limited_memory=true`, so this is not a
  ready-memory deletion pass. After all 57 ingestion receipts finished, owner
  and topic generations remained building. The shared monthly embedding ledger
  had $4.998666 reserved under its unchanged $5 cap, leaving $0.001334; thirteen
  Honcho queue errors matched budget rejection. The owner correctly noted that
  reported spending was about $0.12: 4,829 successful October embeddings had
  $0.118666 in settled holds, while 488 HTTP 502 embedding outcomes retained
  $4.88 in conservative holds. Of those failures, 457 occurred within about
  eight minutes with 28-309 ms durations, indicating a fast upstream failure
  and repeated attempts rather than a $4.88 provider invoice. A fresh
  ready-memory question was therefore not issued, and neither the cap nor
  historical holds were changed.

  This fresh run also exercised the relay cooldown against actual provider 429s:
  218 upstream HTTP 200 outcomes and three HTTP 429 outcomes were recorded.
  Subsequent admissions waited at least 60 and 120 seconds, respectively; a
  previously admitted request finishing successfully after the first 429 did
  not clear the cooldown. The safety monitor stopped the fixture at its third
  429; a later Honcho-only inspection left all fixture services stopped with
  state preserved. This verifies the bounded fixture relay under those observed
  429s, not unthrottled provider reliability or operating activation. The
  content-free summary and full synthetic receipts remain in ignored local
  acceptance state. [Procedure](docs/telegram-simulation.md),
  runner (removed `tools/acceptance/model_rehearsal.py`),
  relay (removed `tools/acceptance/model_relay.py`).

  The Honcho egress candidate now persists a shared, exponential 60-second to
  one-hour cooldown after paid embedding 5xx outcomes. Blocked calls return
  HTTP 503 with numeric `Retry-After` before making a new spending reservation;
  a later admitted success clears the cooldown, while an older in-flight success
  cannot. Reasoning is unaffected. Failed admissions remain recorded; the
  accounting candidate below separates which holds count against the cap. Thirteen focused
  meter checks pass, including transport failure, restart, HTTP response and
  late-success ordering. This source candidate has not been activated in the
  operating installation or the previous cold fixture image. The existing
  October holds blocked ready-memory work under the prior accounting.
  [Decision](docs/adr/0100-durable-embedding-egress-cooldown.md),
  [checks](services/honcho/test_meter.py).

  The owner rejected increasing the $5 embedding cap and requested accurate
  accounting. The candidate keeps every admission record, releases confirmed
  HTTP-error holds, retains transport/unfinished/unreported holds, and labels
  historical errors whose response type was never recorded. On a read-only
  SQLite backup of the operating ledger, repeated migration produced the same
  result: $0.118666 counted toward the unchanged $5 cap, $4.881334 headroom,
  and $4.88 of original monthly error holds released from cap accounting but preserved
  as unverified exposure. Old pilot holds remain counted. This is not a provider invoice. The operating ledger
  and running services were not changed. A fresh fixture run, provider billing
  comparison, and operating activation remain pending.
  [Decision](docs/adr/0102-separate-embedding-error-holds-from-spending.md),
  [meter checks](services/honcho/test_meter.py).

  The pinned Honcho queue counts processed-with-error items as completed. A
  Nocheh generation previously checked only zero pending/in-progress work, so
  terminal derivation errors could falsely advance readiness. The candidate
  now checks a read-only, workspace-scoped failure boolean before marking ready;
  failed work keeps `honcho_derivation_failed` visible and invalid health cannot
  advance the generation. The isolated Honcho API returned true for an existing
  failed synthetic workspace and false for an empty one, with deriver and Hermes
  stopped; no embedding or model admission was added. Nineteen focused Python
  checks pass; the pinned Linux Node 24 build passes and affected compiled Node
  tests have five passes and four database-fixture skips. Coupled Nocheh readiness
  and a fresh successful derivation remain pending. Terminal upstream failures
  require a new evidence-preserving generation; restarting the worker alone does
  not retry its processed-with-error items.
  [Decision](docs/adr/0101-honcho-terminal-queue-errors-block-readiness.md),
  [API check](services/honcho/test_provenance.py),
  [Nocheh check](test/store-native-memory.test.ts).
  A no-network runtime overlay for this locally integrated source is cached as
  `sha256:3aa964edbc2f6cca8f81de023a641bc563e4b5cd9128ec39990092d7a6b691ac`;
  its compiled readiness file matched the worktree byte-for-byte. The full
  offline Dockerfile build stopped at apt DNS before producing an image. The
  overlay has not run as a fixture or operating service; its preparation receipt
  remains in ignored local state.

  A focused quality-runner window can stop after the selected scenario without
  injecting later restart or retirement questions. Invalid ordering is rejected
  before opening a fixture. Six networkless runner checks pass. This prepares an
  unused-topic recheck; the first attempt failed, and the later focused topic-18
  recheck passed as recorded above.
  Runner (removed `tools/acceptance/model_rehearsal.py`),
  checks (removed `test/test_model_rehearsal.py`).

  Foreground Honcho recall now requires completed evidence beyond the current
  question. Background context still learns the first source; older receipts
  and independent history remain usable. Four checks pass without skips,
  including three PostgreSQL checks for access, guarded recovery and the new
  question-only boundary. TypeScript compilation passes. Coupled real-model
  verification of this candidate is pending.
  [Decision](docs/adr/0099-independent-evidence-for-historical-recall.md),
  [checks](test/store-native-memory.test.ts).

  A fresh empty-state installation of the latest guard/lease candidate passes
  all nineteen coupled checks, including actual Honcho ingestion, silent
  convention/reaction learning, native browser work and outage memory recovery
  in 100.2 seconds under the unchanged five-minute gate. Its current generation
  is ready, all seven current ingestion receipts and five native reviews are
  done, and no guarded publication remains pending. Earlier nineteen-check
  evidence retains its original 54.7-second recovery observation. Durable native
  review handoff has 25 native and six PostgreSQL/workflow passes, with 47
  packaged native checks. All original failed runs remain recorded, including
  an unclassified early native exit; later passes do not explain it.
  [Installation runner](tools/acceptance/rehearsals/installation-rehearsal.py),
  [handoff decision](docs/adr/0097-durable-native-review-handoff.md).

  Consequential delivery, approval, memory-sharing and entity repairs retain
  their separate passing evidence: exact topics and live delivery authority;
  complete approved wording, atomic follow-ups and concurrent receipts;
  unstarted handoff recovery; owner names, merged identities, corrections and
  retired facts. The matrix and history link their focused and adjacent checks.
  The deterministic fixtures use internal networks and synthetic state; the
  authorized model fixture adds only its scoped relay to the existing provider
  network, without a public port or another OAuth owner. The operating
  seventeen services retained their identities, start times and healthy state
  at that observation. No operating activation, real Telegram traffic or new
  live acceptance pass is claimed. Actual model quality and the existing same-topic
  recall failure remain open. Detailed reports stay in ignored
  `data/acceptance/results/telegram-simulation/` in the simulation worktree.

- Guarded reaction evidence now accompanies discovery with bounded target
  excerpts. Five storage/route/retirement checks and six networkless native
  archive checks pass; TypeScript compilation and the AST-only graph update
  pass. [Decision](docs/adr/0086-reaction-discovery-evidence.md). Operating source
  and actual isolated-child image verification also pass. Correct conversational
  recall remains unverified after this activation.

- Primary ingestion now receives its first attempt before a new native note
  review can take the background slot. Five workflow checks and one native-review
  recovery check pass with no skips. Pending review causes no native effect;
  receipt completion releases the prerequisite. Existing uncertain reviews retain
  their identity and reconciliation. Two initial fixture failures were corrected:
  the global sweep may include older synthetic jobs, and Honcho list responses
  must filter by the requested receipt. [Decision](docs/adr/0088-primary-ingestion-before-native-note-review.md).
  TypeScript compilation, the AST-only graph update and operating compiled-byte
  verification pass; current memory readiness remains pending.

- The October 2 General check has one captured message, one linked reply, and one
  execution attempt. The owner confirmed one sensible reply. Elapsed time was
  about 175 seconds, including about 133 seconds before the native execution
  receipt started and 41 seconds until completion. The model effect recorded
  2.2 seconds of broker preparation and 3.2 seconds of provider transport waits.
  Preparation completed about 51 seconds after capture, leaving about 82 seconds
  before the native receipt. These are elapsed workflow boundaries, including
  orchestration waits. Historical receipts lack finer preparation measurements,
  and workflow run timestamps are overwritten by later steps. Native phases
  overlap; they do not establish pure model compute time. The earlier timeout
  and recovered reply remain historical evidence.
- The trusted native parent now retains allowlisted timings and an explicit
  guard-change failure when authorization changes after child completion. It
  withholds the answer and session identity; fourteen focused process/timing/
  delivery checks pass. The guard-change reason also survives durable native
  and workflow receipts; nine async/delivery and two storage-dispatch checks pass.
  Missing measurements in older receipts remain missing.
- A native diagnostic candidate retains only bounded Python error type and
  function-stage identifiers in a failed dispatch receipt. Exception messages
  and provider bodies are excluded, and the asynchronous public receipt still
  exposes only its generic error code. Nine networkless gateway/receipt checks
  pass in a source-verified local Hermes image. This cannot reconstruct the
  missing type from earlier failed receipts; the candidate is not yet exercised
  in the coupled model fixture.
- Archive reads now link a note to at most twenty currently captured reaction
  sources after access checks. The native tool retains guarded reaction changes,
  removals, and anonymous counts, and explains the all-word search behavior. Four
  storage/access/retirement checks and eight native archive/delivery checks pass.
  The operating CLI now links the saved older note to its removal; all seventeen
  services are healthy. This does not pass the live conversational recall gate.
- Archive search can discover bounded current reaction sources without message
  words or a target ID. Returned reaction and target handles retain topic,
  generation, supersession, and retirement checks; evidence is read through the
  guarded path and remains explicitly incomplete. Five storage/route checks and
  nine native archive/delivery checks pass, including a packaged-image check.
  [Decision](docs/adr/0084-scoped-reaction-discovery.md). The last live answer read
  one unrelated source and stopped; the conversational recall gate stays failed.
  The compiled operating lookup finds the saved removal and its older target
  under the original topic boundary; the pinned native source is verified.
- Automatic learned publications now wait while a current Telegram reply or
  leased managed reply is active. Saved reasoning and staged versions are reused
  after the wait; owner corrections and privacy revocations remain immediate.
  Five focused learning/workflow checks pass, including recovery and owner edits.
  [Decision](docs/adr/0083-defer-automatic-memory-publication-during-replies.md). This does not pass recall.
- Background admission now hands a free slot directly to one live callback
  waiting for at most one second. Sleeping retries cannot reserve idle capacity.
  Five workflow checks pass, including foreground capacity, bounded overflow,
  timeout without effects, exception release, supersession and durable receipts.
  [Decision](docs/adr/0087-live-background-admission-handoff.md) supersedes the
  earlier retry-order hint. Operating compiled-byte verification passes; current
  memory readiness remains pending. The scheduler's earlier unexplained exit is
  still retained.
- Owner workflow inspection now joins memory receipts by indexed identity. The
  old event-filtered query exceeded a five-second database deadline on a
  synthetic backlog; the repair and four adjacent workflow checks pass. The
  change preserves receipt/reconciliation links and source-event filtering.
  A later catalog check found that the operating database still used the old
  view despite compiled source. The exact tested view is now activated and
  catalog-verified; full CLI timing inspection succeeds in about 2.2 seconds.
  The earlier source-only verification did not establish database activation.
- The prior native candidate passed 380 networkless image checks and three host checks,
  including real container isolation. Twenty-one subscription compatibility
  checks passed. Thirty workflow regression checks passed; separate bootstrap
  and pinned-engine UI fixture cases remain explicit skips.
- Timing changes passed seven broker/security/storage checks, eleven admin CLI
  checks, and the TypeScript/dashboard build. The dependency patch build passed;
  npm reported zero known vulnerabilities at the recorded audit.
- Dashboard reload shutdown now closes stalled HTTP connections after a bounded
  grace period and still waits for admitted owner writes and lifecycle jobs. The
  regression reproduces the old hang; all four focused shutdown/maintenance checks
  pass on the repair. A one-time recovery of the already-stuck dashboard child
  restored the page after confirming no active workers.
- The learning repair passed four focused learning/entity checks and seven
  learned-memory/native-context/review checks. They cover generated paraphrases,
  changed model identities, new convention evidence, owner corrections,
  retirement, consent, durable results, and uncertain execution identity.
- Populated backup and inactive restore passed: 1,461 files, 88 owned-store table
  fingerprints, workflow fingerprints, and Honcho were verified. Restored bot,
  provider login, memory attachment, and executors stayed inactive. Restored
  containers are stopped; saved state remains preserved. The earlier disk-space
  failure and incomplete dumps remain recorded failures.
- October 14: a backup of the owner's development installation failed with
  `honcho_backup_state_missing` after pausing Telegram for about 75 seconds,
  because installations run only through `make dev` never generate
  `honcho.Dockerfile`. That build file is now optional: a backup records it as
  rebuildable when absent and still requires the five owned Honcho state files
  ([check](services/hermes/test_operations.py)). Since November 11 the build file
  lives in the Honcho source checkout, and backups hold only those five files. The rerun with the fix
  passed: Telegram paused 78 seconds; 947 state files and 99 table fingerprints,
  Honcho and workflow state were covered; the inactive restore matched every
  fingerprint and kept Telegram, provider login, Honcho attachment and
  executors inactive; the restored copy was removed and the operating stack
  returned healthy with one poller.
- Fresh provider chat, literal detector, and refresh-delegation checks passed.
  Persisted CPA refresh metadata predates successful current chat requests;
  expiration was not forcibly induced. September provider cutover and voice
  evidence is retained with its original dates and limitations. Speech source,
  dependencies, and login ownership did not change, so another voice note is
  not required solely by these increments.
- The acceptance report hashes are reconciled, including the later-updated topic
  report. Eleven earlier completed areas remain carried observations; General
  has new owner-confirmed evidence. Exact reports, revisions, and identifiers
  remain in ignored local state.

</verification>

<pending>

Security fixes, part 2 follow-ups ([ADR-0251](docs/adr/0251-fixes-that-lose-nothing.md)):
about a week after installing, check `./bin/nocheh diagnose` for `hermes_page_script_reports`
(none) and a passing tester run, then turn the Hermes page script policy from Report-Only to
enforced in one commit. Later: one
shared name cleaner for cards, forwards and recall labels, and a notice when an off-site
restore check fails.

Silent learning (October 10): on the owner's development installation with
Claude through Honcho, seven `interpret` jobs failed after 9 to 10 attempts
with hourly retries still scheduled, because each retry re-validated the same
saved reasoning result. The saved results were fenced JSON (three), direct
claims labelled with a relationship kind but no object (two), and
interpretations citing source IDs that Honcho recalled from earlier messages
(three). Results are now read from fenced or wrapped JSON, a relationship
label without an object is ignored, the request lists the citable IDs, an
invalid item is dropped and recorded while valid items publish, and a result
still unusable as a whole closes its workflow
([decision](docs/adr/0128-learning-results-keep-valid-items.md),
[learning checks](test/store-learning-engine.test.ts),
[workflow checks](test/learning-workflow.test.ts)). Pending: the owner's
confirmation of keeping valid items rather than failing the whole result, and
a check on the development installation that the seven jobs complete or close
on their next retry.

Silent learning (October 12): 3 of 20 `interpret` jobs closed as failed
because Honcho's reasoning answer hit its 2,500-token output limit and was cut
off inside the entity sections. A cut-off answer now keeps its whole leading
items ([decision](docs/adr/0140-truncated-learning-results-keep-whole-items.md),
[check](test/store-learned.test.ts)). Pending: a live check that the next such
answer publishes its complete interpretations.

Scheduled runs (October 10): the simulator found every scheduled run rejected
before the agent started with `space_policy_changed`, because
`/v1/memory/check` accepted only an archived turn source and schedule fires are
never archived. The check now accepts a scheduled turn credential whose admitted
run still matches its scope, space, profile, guard binding, live lease and
current schedule definition ([check](src/stores/scheduled-runs.ts),
[store test](test/store-server.test.ts)). Pending: rerun the simulator's
schedule scenario on Docker.

Personal-use simulation follow-ups are resolved and verified in the coupled
fixture: definite Telegram rejections close as rejected by Telegram; an
approved action Hermes refuses before any send intent returns to the approved
queue; retirement offers the direct reply and replies that quote the message;
storage tests run with per-file cluster resets
(`python3 -m tools.development.store_tests`); turn containers are removed when
their launcher stops. An approved action whose runtime is unreachable, or
whose response is lost, remains uncertain by design.

Live owner session (October 8, operating stack, source-watched): replies were
delivered once each but retried because a first voice transcript revoked
every in-flight turn; ADR-0108 removes that revocation. Owner-private turns
read the owner's directory, people and projects; the owner freedom setting
(approval required by default) is in Nocheh settings; topics are named from
their root message and selected groups can be named by an explicit Telegram
refresh. Because the Bot API cannot list topics, topics also appear from their
lifecycle messages and the owner can add older empty topics by link in Settings. Development turns now use the watched source. Archive details open
in a drawer. On a fresh simulator installation (October 9) all scenarios pass,
including the owner directory and its group denial, the refresh, owner
freedom, a launcher stopped mid-turn, texts with a voice note in Telegram
order, and an unparseable update that previously wedged polling; browser
checks of the drawer, retirement offers and settings panels pass. Pending
owner rechecks: a live exact approval to a topic and quick live messages with
a voice note. Real-model quality, live Telegram release gates and release
remain pending. [Live summary](docs/mvp-acceptance-status.md).

Memory search model change (October 27, owner: "but we should able do it"):
Settings › Models lets the owner pick either reviewed embedding model again.
Save asks to confirm the memory rebuild, and Apply restarts Honcho with the
new model, moves the gateway ledger and replaces Honcho memory from the archive
([decision](docs/adr/0181-memory-search-model-change-rebuilds-memory.md),
[checks](services/hermes/test_settings.py),
[tester scenario](tools/acceptance/product_scenarios.py)). The owner's
installation still uses `text-embedding-3-small`; switching it waits for the
owner's own choice.

Providers per part (October 13, owner: use their hosted provider gateway instead
of Nocheh's own provider; its wake-up time does not matter): Settings › Models
now lists providers (OpenAI and Anthropic by API key, and custom
OpenAI-compatible providers by HTTPS address and key) and the provider
and model of replies, memory, the secret check and memory search, with one
default for every part ([decision](docs/adr/0141-per-part-model-providers.md),
[resolver](tools/operations/provider/routes.py),
[checks](services/hermes/test_provider_routes.py),
[browser check](test/dashboard-pages.browser.mjs)). After the owner's review,
model lists load from added providers while they are being edited, and each
custom provider is a card with Remove in its header. Owner, October 13: "remove
CPA and it admin panel from our services." CLIProxyAPI, CPA Manager Plus, the
provider logins and the ChatGPT speech route are gone; a fresh installation has
no provider and its model calls wait with `provider_not_configured`; voice
notes are archived without transcription and never hold a reply
([decision](docs/adr/0142-external-providers-only.md)). Pending: the owner
sets up the gateway (or adds an API key), adds it in Settings and
applies; then a live reply, memory answer and secret check through it; whether
and how voice transcription returns is the owner's decision. An existing
installation keeps its old `data/local/provider/` folder (the CPA logins);
reset refuses it as an unknown path until the owner deletes it. Honcho's structured output through
Anthropic's OpenAI-compatible endpoint is unproven. Moving Nocheh itself to an
always-on server is a separate, unstarted step.
Usage tracker (October 13, owner: "we need to have our own tracker ... everything
needs to be displayed in one place (Nocheh)"): Hermes's own per-turn token
counts and cost go to a daily table per part, provider and model
([tracker](services/hermes/usage.py)); Honcho memory and memory search are
counted at Honcho's meter ([meter](services/honcho/meter.py)); System › Usage
shows calls, tokens and estimated cost for every part in one list
([view](tools/operations/provider/usage.py), [page](dashboard/pages/usage.tsx),
[checks](services/hermes/test_usage.py), [view checks](services/hermes/test_usage_view.py)).
Costs Hermes cannot price, such as a custom provider's, show as unknown.
Pending: live counts after the owner adds a provider and applies (Hermes and
the meter must be rebuilt for the tracker to start counting).
With real Claude answers the schedule scenario fires, waits for review and
delivers once (the scheduled-run fix on main holds), but removing the finished
one-time schedule failed: removal paused it, which Hermes refuses for a
terminal job. Removal now leaves a finished job terminal
([adapter](services/hermes/native_cron.py), [test](services/hermes/test_scheduler.py)).
Real-Claude simulator run (October 10, fresh installation, Claude Sonnet 5.5
through the operating provider, real Honcho embeddings): 14 of 16 scenarios
passed before the fixture's 300-call cap; the schedule cleanup failure is fixed
above and polling outage stopped at the cap. Of 300 model calls, 214 were
literal-detection calls, 49 Honcho and 37 Hermes chat. Over 20 replies the
reply time was p50 86 s and p95 176 s while provider wait was p50 2.2 s:
preparation steps (p50 8.9 s), Hermes history (p50 5.7 s), model guard and
step waits dominate, and detection calls are counted as internal steps rather
than LLM time. Answers were natural Persian; while transcription was down the
reply to a text after a voice note said no voice note was found, and a PDF
caption reply said no text could be extracted. After the owner raised the cap
to 1,000, every remaining real-Claude scenario passed. Memory cases with real
Claude and Honcho: reaction removal, corrected fact, private isolation, topic
isolation and recall after restart answered correctly; the retired-fact case
failed. Thirty seconds after every source of the synthetic name was retired,
the owner-private answer still gave the name. No memory result or archive
search after the retirement contained it; Hermes' native session history,
which `/v1/context/prepare` guards but does not filter for retirement, still
held the earlier turns. Recheck on main 4db58ef (October 12, real Claude, owner-approved pause of the
operating stack): after the retirement the owner-private answer no longer gives
the name and says it will not guess, so the native-history fix holds. Claude
calls stopped after the run: 11 in the following two minutes, then none for
three and a half minutes; the recheck used 42 calls. The checker then failed
on a repeated Telegram message number in the restored fixture, now matched by
reply text.
Incident (October 10, about 12:47Z): a host run of the settings tests called
Apply's new Honcho refresh with a temporary state that named no Compose
project, so Compose used the file's `nocheh` project and recreated the
operating stack's five Honcho containers with that state's secrets; the
operating honcho-api then failed on the database password until the recall
thread removed those containers. Honcho start/stop, the Apply refresh and the
provider model list now refuse a state that is neither the installation's own
nor names its own project ([guard](tools/operations/installation/configuration.py),
[test](services/hermes/test_honcho_runtime.py)).

Real-model simulator cases (October 14): after the built-in Claude connection
was removed, the fixture model service can relay to an owner-authorized
provider from a private upstream file, so Hermes, Honcho and the secret check
reason with a real model while Telegram stays simulated
([rehearsal](tools/acceptance/model_rehearsal.py),
[checks](test/test_model_rehearsal.py),
[procedure](docs/telegram-simulation.md)). New cases cover memory shared across
a group's topics and isolation between groups. A fresh fixture from the
simulator change passed the installation rehearsal (15 of 15 gates), both
Telegram rehearsals (14 and 12 gates) and all 38 personal-use scenarios. The
closing lingering-turn check stopped on a transient Docker CLI failure, now
retried. The real-model cases stopped before any answer: their updates were
numbered below the offset the scenario run had already acknowledged, so the
adapter dropped them; numbering now starts above it. Afterwards the operating
stack could not start: three stopped fixtures kept 24 networks and exhausted
Docker's address pools, and with the machine asleep it stayed down for about 11
hours. `make dev` now releases networks of stopped fixtures
([check](test/test_live_dev.py)). On rerun the lingering-turn check passed,
and six of seven real-model cases delivered acceptable answers (reaction
removal, corrected fact, private isolation, a fact shared across a group's
topics, isolation between groups, recall after restart); no raw secret canary
reached the provider outside the secret check. The retired-fact case failed:
seven seconds after both name sources were retired, the private turn still
answered the name "from memory". Retirement advances the guard epoch, so that
turn ran in a fresh native profile without the old notes or history, made no
tool calls, and took the name from the turn-start Honcho context, read before
the epoch's correction sweep had rebuilt the session. Honcho context and recall
now wait for that correction
([ADR-0148](docs/adr/0148-honcho-reads-wait-for-epoch-correction.md)). A rerun
confirmed the retired name no longer leaks, but routine epoch changes kept
Honcho memory closed for the whole run, so only uncorrected owner changes now
hold it ([ADR-0149](docs/adr/0149-only-owner-changes-hold-honcho.md),
[checks](test/store-native-memory.test.ts)). That rerun's scenario failures
came mostly from running the scripted scenarios after real-model relay mode
was enabled; the scenarios now refuse relay mode. A fresh full run on the
narrowed gate (October 15) passed: installation rehearsal, the ordinary Telegram
rehearsal, 39 of 39 scripted scenarios, and all seven real-model cases on the
first delivery. The retired-fact turn said long-term memory was being
corrected and gave no name; it was the only turn Honcho memory was held for.
Real Honcho lookups ran in the corrected-fact, shared-topic and group-isolation
cases, the Honcho queue drained, there were no upstream errors, and no raw
secret canary reached the provider outside the secret check. Observation: each
real Honcho dialectic lookup took 25 to 36 seconds, most of those replies' time.

Honcho recall latency (October 16, from that run's gateway ledger and derived
records): each recall asked one person and made two Honcho reasoning rounds
(about 7 to 10 seconds of model time) and about five sequential secret checks
of 2 to 4 seconds each (11 to 21 seconds); the question's check waited up to
8 seconds behind background checks. Honcho's recall requests were checked at
background priority; they now take reply priority while the deriver stays
background ([ADR-0150](docs/adr/0150-honcho-recall-checks-take-reply-priority.md)).
The `honcho_recall` stage does not separate secret-check time. A real-model
rerun on the change passed all seven cases; in the one comparable recall
(shared topic) the lookup fell from 27.0 to 20.2 seconds, the question's check
from 8.3 to 2.5 seconds and critical-path checks from about 18 to 11 seconds.
About four sequential checks of 2 to 4 seconds remain per recall. Options not
taken without the owner: fewer recall checks or a lighter Honcho reasoning level.

Secret-check model comparison (October 17, synthetic cases only,
[tool](tools/acceptance/detector_eval.py)): 14 cases with known secrets and
near-misses, three rounds each, through the owner's gateway. With the production
low reasoning effort, `gpt-6-luna` passed 42 of 42 with a 2.6-second median and
`claude-sonnet-5-5` passed 39 of 42 with 3.5 seconds; without a reasoning effort
they took 2.2 and 3.1 seconds. Sonnet's only failures were the private-key case,
whose expected value then included the key's armor lines; the case now requires
only the key material. `claude-haiku-4-5-20251001` wrapped every answer in a
code fence, which the detector rejected; the detector now removes one exact
JSON code fence and still rejects any other wrapping. The owner uses Anthropic
models only (October 17). With the fence accepted, Anthropic candidates over
three rounds at low effort: `claude-sonnet-5` passed 42 of 42 with a 2.65-second
median (also 42 of 42 without an effort), `claude-sonnet-5-5` 42 of 42 with 3.34
seconds (2.95 without an effort), `claude-haiku-4-5-20251001` 40 of 42 with 3.36
seconds (two rejected replies, one hiding a missed password), and
`claude-sonnet-4-6` 36 of 42 with 1.84 seconds (it missed the Persian password in
every round). The OpenAI embedding key still works (one synthetic call, status
200). The owner chose `claude-sonnet-5`, and the live secret check uses it
since October 17 (synthetic detector check 3 of 3, 2.8 to 3.4 seconds); every
other part stays on `claude-sonnet-5-5`. `claude-haiku-5-5`, compared later
the same day, passed 37 of 42 with a 2.73-second median against 42 of 42 and
2.52 seconds for `claude-sonnet-5`; it answered in prose instead of JSON in five
calls, so the secret check stays on `claude-sonnet-5`. A larger rerun (five
rounds, 70 calls per model) confirmed it: `claude-sonnet-5` 70 of 70 with a
2.55-second median and 3.13-second p90; `claude-sonnet-5-5` 69 of 70, 3.07 and
4.73 seconds; `claude-haiku-5-5` 55 of 70 and `claude-haiku-4-5-20251001` 61 of
70, every failure an unreadable reply. Since then the check asks Anthropic's own API for
a strict JSON schema, and there on 2026-11-13 `claude-haiku-5-5` passed every check; it is
now the secret check's default on Anthropic (see Secret check on Haiku 5.5 above).

Simulator run on main after the Honcho session, storage and timing merges
(October 10, fresh synthetic installation, deterministic inference): the
installation rehearsal and both HTTP Telegram rehearsals pass; the first
scenario pass had 38 of 42. Its polling-outage, storage and lingering-turn
failures and a second pass's rejected search reply came from the simulator;
after those repairs the affected scenarios pass on rerun. The repeatable
speech-outage restore and the review-drain wait before the lingering check
are not yet exercised in a full pass. The schedule scenario found the
scheduled-run rejection recorded above. Observations for the
storage and timing plans: one run of 180 archived events left 228,823 guard
fragments (97 MB) and 8,713 `guard-context` runtime contexts with only 1,370
distinct contents, none covered by retention; native memory reviews keep
launching isolated turns for several minutes after a burst, and four reviews
in flight when the launcher stopped or the provider was recreated stayed
`waiting`/`receipt_pending` in `reconcile`, rechecked every minute for over
40 minutes; every reply waits
about one second in the preparation outbox; a text after a voice note waits
about two minutes while transcription is unavailable.
[Procedure](docs/telegram-simulation.md).

Hermes native memory reviews after the real-Claude run (October 10): they kept
calling the model after the scenarios ended with no new messages and spent
most of the 1,000-call cap. Each authorization epoch swept the archive and
queued a new native review for every source, because the review identity
includes the guard binding; uncertain reviews were observed every minute with
no end. A source is now reviewed once, later epochs queue only sources whose
review never started, and an uncertain review gets at most eight observations
with doubling gaps before its workflow closes as uncertain
([decision](docs/adr/0124-native-review-once-per-source.md),
[checks](test/store-native-review.test.ts)). Pending: the owner-machine simulator
rerun that confirms no model calls after the scenarios end.

Hermes native memory reviews during the history import (October 26): learning
the 105 imported messages advanced the epoch every few minutes, and each epoch
closed every waiting review and queued a new copy at the back, leaving the old
row pending; 140 reviews became over 400 rows draining one or two a minute.
A waiting review now keeps its identity and place when its input is unchanged,
old copies are deleted, and waiting reviews don't ask Hermes while another one
runs ([decision](docs/adr/0173-waiting-native-reviews-keep-their-place.md),
[checks](test/store-native-review.test.ts)). Eleven learning runs in the same
import closed as `input_limit`: a topic message brings up to 30 related
messages, which did not fit Honcho's 10,000-character query even as text. The
query now leaves other evidence out from the end, keeping the trigger, before
giving up, and the instruction cites only the evidence it shows
([check](test/learning-workflow.test.ts)). Learning stopped by an epoch,
including those runs, was closed and never asked again; the per-source sweep
after each epoch now asks again
([decision](docs/adr/0176-stopped-learning-is-asked-again.md),
[checks](test/store-learning-engine.test.ts)). Work stranded before those
fixes waited for the next epoch, so each worker start now asks once for the
per-source step of stranded sources
([decision](docs/adr/0177-stranded-memory-work-is-picked-up-at-start.md)).
Pending: confirming the queue drains on the owner's installation and the
stopped learning completes.

Current isolated evaluation status: the synthetic 16-service fixture is stopped;
the operating gateway is healthy. The operating database recovered with the
tested wrapper after 81 seconds of WAL replay, and the existing Inngest server
became healthy eight seconds after startup. App and security recovered without
recreation. The owner authorized restoring the missing local tag for the
revision-checked running Hermes image; the sandbox launcher recovered in five
seconds without a container restart. All 17 operating services are healthy at
this checkpoint. The owner authorized the existing model route,
additional fixture reasoning requests, a parallel fixture, and a gateway-only
restart, then explicitly authorized gateway-only source activation. No Telegram
production traffic or release activation is authorized by those checks. The
shared embedding ledger has the outcome-aware schema and retains every prior
call under the unchanged $5 cap. The active gateway now mounts the corrected
main source through an ignored one-service Compose override. Its local authenticated
report counts $0.149799 toward the $5 cap, shows $4.88 of unverified historical
error holds separately, and leaves a $4.850201 admission balance; no paid
request was used for this check. All other operating container IDs stayed fixed.
A future `make dev` from the other session's older source may replace this
override and revert the gateway, so coordinate source reconciliation before
restarting the operating stack. Exact synthetic receipts and identifiers remain
in ignored local state.

The owner first authorized starting only the two existing stopped containers.
The database repeated its prior exit after about 48 seconds of WAL replay;
Inngest was not started on that attempt. The old wrapper's 300 fast readiness
polls sent a smart shutdown before recovery could complete. After two focused
tests and an offline byte-verified image overlay, the owner explicitly authorized
pruning only unused Docker build cache and recreating only the database with
the same named volume. All build cache was removed without changing images or
volumes. Only the database container ID changed; it became healthy after 81
seconds, and the existing Inngest container was started afterward. No volume
reset occurred. The host had about 1.0 GiB free after recovery, so free space
is a current operating risk and additional paid/mock traffic should wait.
The isolated-turn launcher had failed before opening its health port because
`nocheh-hermes:local` was absent. After an explicit owner authorization, that
tag was restored from the running Hermes image whose upstream revision matches
the lock. No isolated-turn container was orphaned and no service was recreated.
The owner then authorized clearing only four regenerable host caches (uv,
Puppeteer and two updater caches). Those exact caches were removed; free space
rose from about 1.0 to 4.2 GiB, and all 17 operating services stayed healthy.
Monitor disk headroom during any focused fixture run; full-stack health and
this cleanup alone do not establish personal-use release.

The focused synthetic same-topic reaction recheck has now issued one question
after the topic-7 generation reached ready. The single-worker native queue
advanced slowly through older synthetic work; one transient embedding retry
reported `memory_preparation_unavailable`, but the topic reached ready without
a terminal derivation failure. The question was captured and handed off, then
timed out after 311.5 seconds while dispatch remained running on attempt one.
A later single physical reply correctly described the synthetic star reaction's
addition and removal and said the report was not currently approved. It was
causally archived, and dispatch finished on attempt one about 430 seconds after
the question began. The Hermes receipt measured about 142 seconds for the agent;
its dispatch intent was written about 189 seconds after the question began,
and control reconciliation completed later. The workflow was admitted about
two seconds after the question and preparation closed about 183 seconds after;
saved outbox publication and run-seen timestamps are overwritten by later
republication and claims, so they do not prove where the wait occurred.
Synthetic Inngest emitted duplicate-span telemetry errors, but their causal
impact is unproven. Thus answer content passed review,
but the bounded first-attempt reply gate failed. The new question advanced the
generation to building while retaining a prior ready snapshot. Diagnose the
pre-intent and reconciliation delays and the transient preparation rejection
before treating this as dependable ready-memory recall. A second distinct
synthetic question was sent while that generation rebuilt and retained its
prior ready snapshot. Its preparation completed after about 43 seconds and
Hermes intent was written after about 76 seconds. The edited meeting time was
answered correctly in one attempt and one causally archived physical reply in
174 seconds, but the answer explicitly reported limited memory. This passes
delivery and corrected-fact content in a rebuilding audience, not the ready
Honcho-memory quality gate. The fixture is stopped with its volumes and
receipts preserved; all 17 operating services remain healthy, and host free
space is about 5 GiB at this checkpoint.

Read-only receipt inspection after Docker cleanup found the first recorded
Inngest run for the 430-second reaction turn about 174 seconds after capture;
preparation completed about six seconds later. The first four minutes contained
258 duplicate-span log lines and two queue-operation warnings above one second.
A successful warm comparison also had duplicate-span errors, so their causal
role remains unproven. The next fixture check should measure first outbox
publication to first run separately from native execution and reconciliation;
overwritten outbox timestamps cannot prove first publication.

The limited-memory suffix came from Hermes' explicit context-status handling,
not from the model's prose. The saved protected snapshot was renewed about
103 seconds after the second question began, after Hermes had read context.
A focused source candidate now validates an expired snapshot synchronously
when its already-ready generation is building, using the existing guarded
revision check and no Honcho model or embedding call. It keeps limited memory
on failed validation. The offline pinned Linux build and three focused
native-memory tests pass; two PostgreSQL-dependent tests were skipped because
that test database was not started. AST Graphify completed with zero model
calls. In a coupled check, the stopped fixture's app was recreated with only
the candidate JS file mounted read-only; only its app and database ran. Its
stale, previously ready topic snapshot returned one scoped source with
`limited_memory=false` and `syncing=true`, and the snapshot was renewed.
The same event bound to another topic was denied with `turn_source_denied`.
Neither the model relay nor Honcho provider services ran, so the check made
no paid request. The candidate is verified for this context-renewal behavior;
a full mocked-Telegram Hermes turn with the same one-file candidate also
answered the corrected synthetic fact in 142 seconds on the first attempt,
with one causally archived reply and no limited-memory notice. A background
refresh may have renewed the deliberately stale snapshot before Hermes read
it, so that turn does not isolate the foreground renewal path. The earlier
scoped API check does isolate and verify that path. The 430-second reaction
reply, Honcho queue latency, and operating activation remain open. A later
instrumented warm-fixture reaction recheck published both workflows about two
seconds after capture, completed preparation at six seconds, started Hermes
at 20 seconds, produced its native result at 68 seconds, and closed the
workflow at 124 seconds. One first-attempt reply arrived in 128 seconds,
correctly described addition and removal of the star, and had no limited-memory
notice. Earlier synthetic replies already held that fact, so this recheck
measures warm delivery and context status rather than independent first
discovery. The earlier 430-second failure remains evidence of cold or loaded
latency, with its precise cause unresolved. Git integration alone does not
activate this candidate.

After Docker resumed, a second monitored warm reaction question on the same
synthetic topic delivered one correct, causally archived first-attempt reply in
116 seconds. Its outbox was published about one second after capture and the
telegram workflow first ran about 24 seconds after capture. This confirms the
earlier 174-second pre-run delay is intermittent, not resolved. Prior replies
still contaminate independent recall assessment. Three synthetic sources in
an unused topic now record a different reaction's addition and removal; its
memory generation is building, so the first ready-memory question remains
pending while the Honcho representation queue drains. No cold-topic reply has
been scored.

The owner authorized the existing model route for the synthetic Telegram
evaluation. A fresh isolated fixture uses scoped read-only client keys through
the existing provider, without another login or refresh owner. Its Honcho meter
uses the authoritative shared spending ledger. After its 1,500 monthly reasoning
attempts were consumed, the owner authorized 200 additional fixture requests,
then all additional requests needed for this evaluation. The temporary fixture
started with a shared ceiling of 1,700 and currently uses 4,000 for this fixture;
it does not reset accounting, alter the $5 embedding cap, or change the
operating configuration. The relay's restart-safe admission journal has an
explicitly authorized configurable allowance (seven admission/HTTP checks pass);
this fixture currently allows 10,000 admissions and retains all prior entries.
Real Hermes/Honcho evaluation remains in progress. Four first-attempt cases
pass for reaction removal, corrected time, private isolation and private recall
after a Hermes restart. A fresh isolated topic receives a correct, single physical
reply with an archived causal link, but workflow completion exceeds the 300-second
gate; the earlier fresh-topic attempt fails before delivery. The current-question
only Honcho peer exclusion has focused PostgreSQL evidence and the fresh-topic
answer shows no other-topic disclosure, but neither failed timing gate is a pass.
A later unused-topic recheck passed in 176.4 seconds on one attempt after provider
recovery; the intervening topic-17 run failed first attempt and reached delivery
only on attempt 16 after a prolonged HTTP 429 period. The 429 cooldown and
unthrottled provider reliability remain unverified in coupled traffic.
A later retirement question first fails with `assistant_runtime_unavailable`,
then physically receives a non-disclosing answer on retry. Honcho also returned the synthetic name while a separately captured,
still-active assistant reply stated the same fact. This observation alone does
not establish reuse of the retired owner message. The fixture-only oracle now
explicitly retires every captured private source containing that synthetic name
before its next question; five focused runner checks pass. Hermes' parent
turn limit is 230 seconds while its Honcho recall request allowed 615; a bounded
foreground recall candidate passes 30 checks in its verified pinned Hermes
image; coupled timing remains open. The resumed fixture starts all 16 services
within its unchanged health gate while all 17 operating container IDs stay fixed.
A focused retirement recheck explicitly retires three independent synthetic
sources, preserves the originals, and delivers one causally archived,
non-disclosing first-attempt reply in 233 seconds. That answer is limited-memory
evidence: all 26 Honcho ingestion receipts for the new owner generation are done,
and none reference the retired sources or contain the synthetic fact. The
Honcho derivation queue later drained and the owner generation became ready.
A fresh ready-memory question failed on its first Hermes attempt during guarded
context preparation; its second attempt delivered one non-disclosing reply and
the workflow completed. That is not a first-attempt pass. A second fresh question
timed out after 300 seconds before any Hermes attempt because guarded source
preparation failed. After a host-wide Docker stop, the isolated fixture had been
restarted while its selected operating provider route remained stopped; the relay
admitted repeated detector requests despite that unavailable upstream. The
fixture is now stopped with its state preserved, with 2,665 retained admissions
of its 3,000 allowance. A relay health/admission candidate fails closed when its
existing provider socket is absent; seven focused tests pass. The actual fixture
relay returns HTTP 503 with that route stopped, then stops cleanly without a
poller or model request. The ready-memory
semantic and first-attempt gates were open at that checkpoint, and the earlier
context-preparation failure still needs a route-available reproduction. The
operating stack was stopped at that checkpoint.
The runner now binds replies to both chat and message, retains pending source
identities before waiting, and stops after a failed case. Four focused checks
pass for late/unrelated replies, cross-chat message-number reuse, duplicate
physical sends and invalid continuation rejected before fixture access. Existing
seeds can be reused with their original evidence; a selected continuation records
omitted cases and requires a previously unused topic for cold-audience isolation;
this does not repeat the cold capture measurement. Earlier reaction and
correction failures later delivered factually correct replies on attempts four
and three; their original timing and first-attempt gates remain failed. The
first fixture restart exceeded its health deadline before a health-only retry
succeeded. A fixture-only 30-second health-probe cadence subsequently passes the
unchanged startup gate; Docker load was observed at 61.76 before and 22.41 later
on eight CPUs. This does not establish a sole cause for the response failures.
Detailed attempts, source identities and native tool evidence remain in ignored
state. Infrastructure checks do not establish model quality, and operating
activation remains separate.

1. The October 2 same-topic reaction case passed again on October 18 on the
   owner's installation, answered from archive read and search without a
   Honcho recall call ([register](docs/mvp-acceptance-status.md)). The original
   diagnosis below is kept: diagnose the October 2 same-topic recall failure
   using the saved event and CLI. One linked reply arrived on attempt two after about 384 seconds. It
   correctly avoided a completion claim but could not identify the removed
   reaction. Topic routing and the saved removal match; the native tools returned
   no matching long-term memory and archive search found only the new question.
   A background learned-rule replacement advanced the guard epoch during attempt
   one; the retry used a replacement generation with no ready context. Attempt
   one failed after about 182 seconds without native phase timings.
   Both outcomes are preserved. Focused reaction-retrieval and receipt checks
   passed. The focused rerun is also failed: one linked reply after four attempts
   did not identify the removal. Its failures include a model failure, a proven
   guard-context change during background learned replacement, and a generic
   runtime failure. Preserve the saved event and use its CLI/native receipts;
   do not request another copy or ask the owner to judge the answer. The scoped
   discovery repair has focused automated evidence; reconcile its operating
   source/image and current memory readiness before any further live check.
   The later discovery-path answer found one handle without reading the reaction;
   guarded observations and target excerpts now have focused candidate coverage.
   The discovery candidate is active and verified in an actual isolated child.
   Finish the primary-ingestion priority activation and memory readiness check
   before judging a new conversation.
2. Preserve the measured General timing boundaries and their limitations. The
   earlier 230-second native timeout is not explained by the short greeting or
   the later recall attempt; retain its failure evidence and the existing limit.
   Dependable answers take priority over speed. Use new receipts to diagnose
   future failures without inventing missing historical measurements.
3. Finish release evidence and runtime revision reconciliation against
   [release acceptance](docs/release-acceptance.md). Service health, Git integration,
   and historical readiness do not establish current recall or release approval.
4. Sanitized history is published on the public `PlaygrndLabs/nocheh`
   repository (recreated, then transferred), so GitHub no longer serves
   pre-sanitization commits (see [history](docs/task-history.md)). The
   sanitized `archive/pre-hermes-nocheh` branch is published and points into
   `main`'s history; the local pre-push guard
   rejects any branch that still contains rewritten commits. The original
   history remains recoverable only from ignored local bundles. Earlier
   third-party clones are not erased.
5. Preserve the new cold six-case pass and coupled 429 cooldown observation
   alongside the topic-17 first-attempt failure, attempt-16 late reply, topic-18
   pass, prior retirement outcomes, and all original receipts. The fresh cold
   retirement answer used limited memory. A subsequent fresh-topic generation
   reached ready, answered a synthetic fact on its first attempt with
   `limited_memory=false`, then rebuilt after every independent source of that
   fact was retired. A new first-attempt answer from the ready generation omitted
   the fact and expressed uncertainty with `limited_memory=false`; both replies
   were physically sent once and causally archived. The isolated fixture is
   stopped with all state and receipts preserved. Its accidentally internal
   embedding-egress network caused three new fast transport 502s; a repaired
   gateway reached the paid endpoint and subsequent embedding calls succeeded.
   The fixture preflight now rejects this network error and unintended external
   bridges. The shared ledger migrated in place without resetting calls or
   raising the $5 cap; historical error holds remain visible. The authorized
   gateway-only source override activated the corrected meter, and the active
   gateway's read-only budget report verifies cap headroom. Reconcile the other
   session's development source before any future full-stack restart; that older
   Compose configuration can remove the override. Unthrottled provider
   reliability and operating release acceptance remain separate gates.
6. Inngest storage: the amplification cause is measured and repaired in source
   ([decision](docs/adr/0105-shared-background-engine-queue.md)). Activate it
   with the next authorized operating restart, then compare span growth per day
   against the 2026-10-08 measurement in ignored
   `data/acceptance/results/inngest-storage/`. The existing telemetry was deleted on owner
   direction. Configurable retention keeps everything by default
   by owner decision ([ADR-0144](docs/adr/0144-keep-history-by-default.md)); the operating `.env` must be checked for an explicit number. The rebuilt `nocheh-db` image is needed
   for the worker to exist in the operating installation. Remaining real prerequisite polls
   (native reconciliation, review prerequisites, retryable failures and the
   perpetual 120-second Honcho context refresh, removed in source) were about six percent of
   sampled background steps.
7. Honcho memory model: H1 to H6 of the
   [plan](docs/honcho-standard-memory-plan.md) ran on 2026-10-10
   ([ADR-0115](docs/adr/0115-honcho-session-revisions.md),
   [ADR-0122](docs/adr/0122-honcho-fresh-start.md)) on the owner's development machine
   development installation, with the Claude provider. Same-topic recall, private
   recall and group isolation passed
   ([status](docs/mvp-acceptance-status.md)). Open items:
   - Reply latency: the median was 88 s and the slowest 172 s. Most of it was the
     Hermes run queue (median 30 s), because Telegram dispatch held one lock
     across all chats. Per-chat dispatch lanes
     ([ADR-0125](docs/adr/0125-per-chat-telegram-dispatch-lanes.md)) run on the
     development installation; their Hermes unit tests pass. The reply limit (3)
     and parallel agent runs (4) are owner settings
     ([ADR-0126](docs/adr/0126-owner-set-parallel-replies-and-runs.md)), and
     secret-guard checks run three at a time instead of one
     ([ADR-0127](docs/adr/0127-parallel-guard-checks.md)). The October 11
     live check with all three running had a private recall question take
     148 s after capture; its Hermes queue wait was 6 ms, and its Honcho
     recall tool took 78 s. That recall asked four connected peers one after
     another, each Honcho reasoning call with its own guarded embeddings, so
     recall now asks them side by side
     ([check](test/store-native-memory.test.ts)), and guard preparation for
     Honcho's provider requests no longer runs one at a time
     ([ADR-0137](docs/adr/0137-side-by-side-runtime-context-guarding.md)). A
     concurrent group reply was not measured because the group message was
     not addressed to Nocheh. The October 12 rerun answered an addressed
     group message in 30 s and a private recall question in 33 s side by
     side; a group recall question took 80 s, 40 s of it Honcho recall with
     the peers now asked side by side. A later cross-topic check recalled
     across topics but took 109–202 s: Honcho recall took 51–75 s, and the
     group's topics waited 53 and 76 s behind each other in one dispatch
     lane, so each topic now has its own lane
     ([ADR-0136](docs/adr/0136-per-topic-dispatch-lanes.md)). The live retest
     ran two topics side by side in 91 and 101 s with Honcho recall at 38–44 s.
     It still made 38 detector calls, 97% of their fragments repeats of text
     another audience had already checked, so detector results are now shared
     by text ([ADR-0138](docs/adr/0138-shared-context-detection.md)). The
     next two-topic test answered in 34 and 37 s with 16 detector calls, but
     made no Honcho recall call and reused per-topic turn-start context cached
     earlier, so the shared-result effect on a never-used topic is still
     unmeasured. Nine of those calls were background memory reviews, so reply
     checks now go first and background checks leave one slot free
     ([ADR-0139](docs/adr/0139-reply-checks-before-background-checks.md),
     [slot check](services/hermes/test_runtime.py)). Pending: a live check of
     that change.
   - Honcho-only recall passed live on October 13: a note in one group topic
     was answered correctly in another topic the next day. The fact reached
     Hermes only through `memory_recall` (Honcho's answer); the
     turn-start Honcho context, the archive results and per-topic chat history
     did not contain it. The reply waited 33 minutes because the Claude login
     expired overnight while the machine slept; once it renewed, the turn took
     about 87 seconds, 24 of them Honcho recall
     ([live summary](docs/mvp-acceptance-status.md)).
   - Voice notes are archived without transcription and never wait
     ([ADR-0142](docs/adr/0142-external-providers-only.md)); the simulator's
     speech scenarios became `voice_is_archived_without_blocking`.
   - Peer cards are workspace-wide, so only owner turns read them.
   - PDF attachments: preparation now reads a PDF's text layer (pinned
     `unpdf` 1.8.1, in a worker thread with a heap limit and 30-second
     deadline), whole pages up to 200,000 bytes, and records an explicit
     status for unreadable or scanned PDFs. Scanned pages are not read (no OCR).
     Since November 9 Hermes' document reader reads every PDF instead
     ([ADR-0192](docs/adr/0192-files-are-read-by-the-runtime-document-reader.md)).
     Pending: the simulator's document scenario now also checks the extracted
     text.
8. Stage timing: steps T1 to T5 of the [stage timing plan](docs/stage-timing-plan.md)
   are implemented and pass focused synthetic checks: the `stage_timings` table with
   14-day retention, Hermes phases and window kept from the run receipt, Inngest
   step and queue timing, transcription, Honcho recall and Telegram send timers,
   `./bin/nocheh admin timings <event|recent>`, and Monitoring › Reply timing.
   Pending: T6 synthetic Telegram simulation (needs Docker), the Hermes gateway
   component test (needs the pinned Hermes image), a live reply inspected with the
   new breakdown after the next authorized restart, and tagging Honcho embedding
   meter rows by event.
9. Storage growth: re-examine every component for uncontrolled growth using the
   [findings](docs/operations-review-plan.md). Inngest telemetry retention now
   defaults to 14 days and covers every Inngest run history table
   ([decision](docs/adr/0111-complete-workflow-history-retention.md)); a running
   Inngest after pruning the newly covered tables is unverified. The same
   setting expires Nocheh's spent workflow publication records and run links
   ([decision](docs/adr/0112-spent-workflow-record-retention.md),
   [checks](test/workflow-retention.test.ts)), and superseded Honcho context
   summaries an hour after a newer one exists
   ([decision](docs/adr/0113-superseded-memory-summary-retention.md)). Honcho
   workspaces of retired guard epochs still remain until ADR-0109. Every Compose
   service now rotates its Docker log (`NOCHEH_LOG_MAX_SIZE` 10m,
   `NOCHEH_LOG_MAX_FILES` 3, owner-adjustable;
   [check](services/hermes/test_configuration.py)); it takes effect when the
   operating containers are next recreated. `./bin/nocheh storage` reports
   database, largest-table and state folder sizes read-only
   ([check](services/hermes/test_storage_report.py)), and Monitoring › Storage
   shows the same report. Broker model-call security events and guard
   invalidation notes now follow the same setting; action and tool security
   events stay as the owner's audit
   ([decision](docs/adr/0121-operational-telemetry-retention.md)). Still
   unbounded: guarded prepared copies (`runtime_prepared_values` and
   `runtime_prepared_inputs`) of superseded guard epochs, which ADR-0109's
   single-workspace model changes; and spool files that fail permanently.
   Finished Hermes journals (outbound, dispatch, async-run and managed-run
   files) can expire after an owner-set number of days
   ([decision](docs/adr/0143-hermes-delivery-log-retention.md),
   [checks](services/hermes/test_journal_retention.py)). On October 13 the
   owner chose "keep data for ever", so both these journals and workflow
   history are kept by default and grow until the owner sets a number of days
   ([decision](docs/adr/0144-keep-history-by-default.md)). The
   Honcho meter now folds calls older than the previous month into monthly
   totals ([decision](docs/adr/0131-honcho-meter-monthly-rollup.md),
   [checks](services/honcho/test_meter.py)). Guard fragments
   of already prepared sources are now removed by the daily retention pass
   ([decision](docs/adr/0130-spent-guard-fragment-retention.md),
   [check](test/workflow-retention.test.ts)).
10. Inngest orchestration: every Nocheh loop outside Inngest is classified
    ([decision](docs/adr/0120-loops-outside-inngest.md)). Product workflows,
    including the Hermes turn and its reply send, run as Inngest functions;
    the rest are adapter capture, the durable handoff and publisher, store
    recovery, health, retention or the Inngest connection, and none becomes a
    cron. The superseded single-database worker is removed; four older modules
    remain only for their tests.
    Steps that come due while the stack restarts or the machine sleeps can fail
    once with `connect_no_healthy_connection` in the seconds before both
    Connect workers re-register (13 runs from October 10 to 12, all background
    memory review or Honcho work); every retry that ran completed, one review
    was still in its backoff wait, and no reply was affected, so no change was
    made.

</pending>
