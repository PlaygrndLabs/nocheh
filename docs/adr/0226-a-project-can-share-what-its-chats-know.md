# ADR-0226: A project can share what its chats know

<status>
Accepted on 2026-11-09, after the owner asked whether a coworker who is in two
related groups could use what each group knows in the other, and then: "isnt
better to have check box to share entities in create/edit project to do it?"
Amends how [ADR-0057](0057-memory-relationship-access-map.md) keeps projects
organizational and how [ADR-0091](0091-bounded-agent-knowledge-organization.md)
says an assignment never grants knowledge access. Extends the topic memory of
[ADR-0135](0135-group-topics-share-memory.md) and the project of
[ADR-0196](0196-projects-have-their-own-role-and-skills.md). Owner sharing
rules, fact grants and their approvals are unchanged.
</status>

<context>
- Until now a project only organized chats. To let two related groups use each
  other's knowledge, the owner had to write a sharing rule for each direction
  and keep its sources in step by hand when a chat joined or left.
- Sharing rules already do this safely: approved or filtered mode, preview,
  revision checks, and recall that rechecks the rule on every use. Approved
  previews and releases point at their rule by a foreign key.
- Automatic organization may move chats between projects. If project
  membership carried knowledge, that permission would decide who knows what.
- With shared topic memory, a rule into one topic of a group is read by the
  whole group, so a group cannot take part in a project chat by chat.
- At most ten filtered rules can reach one group before recall refuses, and a
  rule with very many sources makes each filtered recall large.
</context>

<decision>
- A project has `sharing_enabled`, off by default, and `sharing_mode`,
  `filtered` by default or `approved`. The create and edit dialog shows them as
  "Chats in this project share what they know", with "Filter automatically" and
  "I approve each text", and the warning "Everyone allowed in any of these chats
  will see what the others know." Only the owner changes them. A save that
  leaves them out keeps their saved values.
- Sharing uses ordinary rows in `sharing_rules` with a `project_id`. Only the
  project and assignment commands write them, inside the command that holds the
  guard lock: `syncProjectSharing` after every project save and every assignment
  change of the project a chat leaves and the one it joins, and the revision rise
  in `writeAssignment` when a topic stops following a source group. The reset
  restore puts them back as saved. A rule's ID is
  fixed: `sha256("project-sharing:" + project_id + ":" + destination)`. Rows
  are never deleted, because previews and releases point at them; they are
  turned off.
- There is one rule into each group or topic assigned to the project, except a
  topic whose group is assigned to the same project: with shared topic memory
  it reads the group's rule. Its sources are the project's other assigned
  groups and topics outside the destination's own group, sorted. Private chats, including
  the owner's, are never a source or destination. A rule is on only while the
  project is active and shares, the destination is assigned, and it has a
  source.
- A source group also covers its topics that follow it into the project: those
  with no assignment of their own or one that inherits. Sharing checks a
  source through `covers()`, which owner rules use as an exact match.
- An assignment has `share_into`, true by default and kept when the chat moves.
  "Don't share into this chat" sets it to false. It turns off the project rules
  into that chat's whole group, in both topic memory modes, and the chat stays a
  source. Only assigned chats have the switch; a topic that follows its group
  follows the group's choice.
- A project rule's revision rises whenever the rule narrows: it is turned off,
  changes mode, loses a source, or a topic stops following one of its source
  groups out of the project. Turning a rule on, adding a source, or a rename
  keeps its revision, so earlier texts stay valid only while the rule reads no
  less than when they were made. An approved text is still released for one
  rule, so it reaches one chat.
- A change that would give one rule more than 100 sources, or one group more
  than ten enabled filtered rules, owner rules included, is refused with 409
  `sharing_rule_limit`, and the command leaves every revision as it was.
- An owner save of a sharing rule is refused with 409
  `sharing_rule_project_managed` when the ID belongs to a project rule, or would
  for any project and a chat that has a project assignment or is the rule's
  destination. The project upsert only updates a row
  with its own `project_id`, so neither kind ever takes over the other.
- A turned-off project rule into a chat that is no longer in the project, or
  whose group now is, is hidden from the sharing rules list, the inspect tool
  and the agent's context. The row stays for its foreign keys.
- Delegated automatic organization never moves a chat into or out of a project
  that shares, also when the chat follows its group. Such a move goes to owner
  review. A proposal read by the owner carries `sharing_projects`, the projects
  that share which its change touches, worked out on the server with the same
  rule (a topic set to follow its group counts its group's project), and an
  applied organization carries `undo_sharing_projects` for its undo. The review
  card and the undo confirmation show the warning when either is set.
- On the sharing rules page and in a rule's details, a project rule reads "Set
  by project <name>", shows On or Off instead of a switch, and links to the
  project. The chat's project card has "Don't share into this chat", marks the
  projects that share in its list, and asks with the warning before a chat
  joins or follows its group into one. The memory map marks an assignment as
  granting access while an enabled rule of its project reads from or into that
  chat.
- The reset snapshot keeps the new columns and project rules as saved; it
  checks that a project rule's ID matches its project and destination.
</decision>

<consequences>
- Two related groups share what they know with one checkbox, and the rules
  follow the chats in the project without manual edits.
- Turning sharing on in a project with many chats reaches many people at once.
  The warning says so, and the default is the filtered mode.
- With `TELEGRAM_TOPIC_MEMORY=topic`, a topic that follows its group into the
  project is a source but gets no project sharing of its own, and neither does
  a topic assigned directly to the same project as its group: it is a source
  for the project's other groups only. A topic assigned directly to a project
  its group is not in gets its own rule.
- A topic that stops following a source group invalidates every earlier text
  of the rules that read that group, also texts made from the group itself.
- An owner rule saved with the ID a project would use for a chat that has no
  assignment yet keeps that ID; assigning that chat to the project while it
  shares is then refused with 409 `sharing_rule_project_managed`. Owner rules
  get such an ID only when it is passed explicitly.
- A chat left out of sharing still gives what it knows to the other chats.
  Keeping its knowledge in too would need another switch.
- Project rules have no privacy notes of their own; the filter uses the default
  rules for every project rule.
</consequences>
