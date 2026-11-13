# ADR-0246: Projects replace the share box: a group answer uses only that group

<status>
Accepted on 2026-11-13 with the owner's Members design, as part of its step 2,
"Projects and the private button". Supersedes
[ADR-0226](0226-a-project-can-share-what-its-chats-know.md) in full. Amends
[ADR-0243](0243-project-boards-get-the-private-side-only-through-a-card.md)
where it ties joining a project with tasks to joining one whose chats share,
and its sharing warnings; [ADR-0242](0242-private-chats-stay-out-of-group-sharing.md)
where it describes project rules; and
[ADR-0091](0091-bounded-agent-knowledge-organization.md), whose delegated
organization may now only create projects. Restores
[ADR-0057](0057-memory-relationship-access-map.md)'s "projects remain
organizational" and ADR-0091's rule that project organization grants no source
or fact access. Keeps the owner's own sharing rules and fact grants, as the owner
chose ("Keep them, yours only").
</status>

<context>
- The Members design sets two rules for projects. A group answer uses only that
  group, for everyone, the owner included. A person in two groups of one project
  can instead ask for a private answer that combines them (step 2's private
  button, its own decision).
- ADR-0226 gave each project a checkbox, "Chats in this project share what they
  know", with filtered and approved modes. While it was on, Nocheh kept one
  project-owned sharing rule into each assigned group or topic, "Don't share
  into this chat" left a group out, and the Sharing page showed those rules as
  "Set by project". A group answer could then use what every other group of the
  project knew, which the new rule forbids.
- A topic could sit in a different project from its group, or in none. The read
  set of a private answer and the audience of a project's board are whole
  groups, so a topic of its own would need an exceptions list everywhere.
- Delegated organization could move a chat into or out of a project with no
  review unless the project shared or had tasks. Joining a project now decides
  who can get private answers that combine groups, so every move is the owner's.
- The owner's own sharing rules and per-fact grants let one group use knowledge
  from another. Asked whether they should stay, the owner chose "Keep them,
  yours only".
</context>

<decision>
- **No share box.** `projects.sharing_enabled`, `projects.sharing_mode`,
  `project_assignments.share_into` and `sharing_rules.project_id` are gone, with
  every project-owned rule. A project save or an assignment that carries one of
  those fields is refused with 400 `unknown_policy_field`. A project never
  shares between its groups, and project membership grants no knowledge access
  in a group. A project decides its role and skills, its task board and what a
  private answer may add.
- **Existing data.** Starting the stores deletes every project-owned rule with
  its previews and releases, then drops the column and its index; the rules are
  deleted, never turned into the owner's, or they would come back as owner rules.
  Texts already said in groups stay in their history and memory. The owner's
  rules and their releases stay.
- **The owner's exception.** The owner's sharing rules and fact grants stay,
  made and used only by the owner. They are the one written exception to "a
  group answer uses only that group". The rule dialog says who will see the
  result: "Everyone allowed in <destination>, its topics included, will see
  what this rule lets in." `covers` matches a rule's exact sources only, as it
  always did for the owner's rules; the topic cover of project rules is gone.
- **Topics follow their group.** A topic's project is always its group's.
  `writeAssignment` takes only `inherit` for a topic and refuses anything else
  with 400 `project_topic_follows_group`, which covers the owner API, applied
  proposals and undo. Starting the stores turns every topic row into `inherit`
  and raises its revision, and `effective()` reads a topic's project from its
  group even when an older own row says otherwise. Learning drops topic
  assignments, a proposal that gives a topic a project or none is refused, and
  a reset refuses a topic row other than `inherit` (TypeScript and Python).
- **Organizing never moves a chat.** Delegated organization may only create
  projects: a proposal with any assignment never matches a delegation and waits
  for the owner's review. `inspect` lists `create_project` as the only automatic
  operation and `project_moves` under review.
- **Joining asks first.** A proposal's owner view carries `project_groups`
  (and `undo_project_groups`): each project a move puts a group into or takes
  it out of, with the other groups Nocheh serves there, using the step's
  `projectGroups` helper. `/v1/projects` lists each project's served `groups`.
  Wherever a group joins a project, from the project, from the group's page,
  from the Inbox or when the owner turns Nocheh on in it, the dashboard names
  the project's other groups first, then says "People in two of these groups
  can get private answers that combine them. Put only related groups in one
  project; keep family groups out of projects.", then the task-list sentence of
  ADR-0243. `task_projects` counts only tasks set on the whole project
  (`group_id IS NULL`), the ones a joining group would see.
- **Which project a group joins.** Turning Nocheh on in a group with no
  assignment asks "Which project does this group join?", with the projects and
  "None", before it turns on; Cancel leaves it off. A served group with no
  assignment asks the same on its page. "None" is saved as a real answer
  (`mode: 'none'`). Neither asks while no active project exists.
- **Notes and map.** The agent-visible `knowledge_access` and `organization`
  notes say a project grants no access in a group and that organizing never
  moves a chat. The memory map's project edge is always "contains" and never
  grants access.
</decision>

<alternatives>
- Turning project rules into owner rules would keep what groups already share,
  but it would keep cross-group answers the owner never wrote a rule for.
- Keeping per-topic projects would need an exceptions list in every read set,
  task audience and card.
- Removing automatic organizing entirely was left for later; creating projects
  stays useful and needs no review.
- Removing the owner's sharing rules and fact grants as well was offered; the
  owner kept them as tools only the owner uses.
</alternatives>

<consequences>
- A live project that had the box on stops sharing at the next start, and its
  rules and texts not yet said are gone. A read-only check on the owner's
  install before merging tells whether any project had it on.
- A topic that sat in its own project now follows its group, also into that
  group's task board.
- Every move of a group into or out of a project, also one the agent proposes
  under a delegation, waits in the Inbox.
- The Telegram side does not announce a new group; the dashboard asks.
- Checks: [projects](../../test/store-projects.test.ts),
  [sharing and the cleanup](../../test/store-sharing.test.ts),
  [organizing](../../test/store-knowledge-management.test.ts),
  [contract](../../test/knowledge-contract.test.ts),
  [notes](../../test/store-owner-supervision.test.ts),
  [map](../../test/store-memory-access.test.ts),
  [owner API](../../test/store-owner-api.test.ts),
  [reset](../../test/store-reset-setup.test.ts),
  [reset tool](../../services/hermes/test_reset_configuration.py) and the
  [dashboard](../../test/dashboard-pages.browser.mjs). The full-tester gate
  `group_answer_uses_only_that_group` belongs to the step's scenario work.
</consequences>
