# ADR-0287: Projects tick the groups that share memory

<status>
Accepted on 2026-11-23. The owner chose a tick list over group pairs and over the one
switch. Amends [ADR-0267](0267-share-group-chats.md); memory walls
([ADR-0286](0286-memory-walls.md)) follow it with no change.
</status>

## Context

"Share group chats" was one switch per project: every group read every other, or none
did. A project can hold a group that should stay apart, such as one about money, next to
groups that belong together.

## Decision

1. **A project keeps the groups left unticked.** `projects.own_groups` (a `text[]`, empty by
   default) sits beside `share_chats`. A group of the project is ticked while `share_chats`
   is on and the group is not in `own_groups`. A group added to the project later starts
   ticked. A change that does not name `own_groups` keeps it. Only whole groups go in it,
   never a topic or a private chat (`invalid_project`).
2. **Ticked groups read each other, both ways.** `sharedProjectGroups` gives a ticked group
   the project's ticked served groups, when at least two are ticked. An unticked group, and a
   ticked group with no other ticked group, reads only itself. Every reader that widens
   through it follows: group turns, members' private chats and schedules, the members' app,
   reminder delivery and the memory wall of the read set.
3. **Answer privately follows what a group answer misses.** The button is offered in a group
   whose answer does not already read every served group of its project: an unticked group,
   or a ticked group while some group is unticked.
4. **The dashboard shows ticks, not the switch.** Edit project lists the project's groups
   with a tick each, Tick all and Clear, and a line saying who reads what. Saving with no
   tick turns `share_chats` off and empties `own_groups`. The project drawer says how many
   groups share memory, and each group row says "Shares memory" or "Own memory only". The
   list shows only for a project with two or more groups.

## Consequences

- Each distinct set of ticked groups is its own memory wall, made on first read.
- Tasks stay one list for the whole project, whatever the ticks say (ADR-0276).
