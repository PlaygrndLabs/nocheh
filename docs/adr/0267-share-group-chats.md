# ADR-0267: "Share group chats": a project's groups read each other

<status>
Accepted on 2026-11-20, as step 1 of the shared and private connectors plan. The
owner decided, on 2026-11-20: a project setting with an on/off switch that lets the
project's groups freely share their data, on by default, for new and existing
projects alike ("we aren't live yet"). Amends
[ADR-0247](0247-projects-replace-the-share-box.md) (a group answer uses only that
group) while a project's switch is on, and
[ADR-0249](0249-answer-privately.md) (Answer privately is offered only while it is
off). Keeps [ADR-0248](0248-tasks-follow-data-access.md) (tasks follow what a chat
reads) and [ADR-0262](0262-member-private-chat.md) (a member's private chat).
</status>

## Context

Since ADR-0247 a group answer reads only its own group, and a person in two groups
of one project combines them only through Answer privately. The owner wants the
groups of one project, such as one company's groups, to share what they know
without that step. Groups in no project, other projects and every private chat
must stay apart. Nocheh cannot check who is in a Telegram group, so the switch is
the owner's call, with its risk said where it is set: everyone in any of the
project's groups, members or not, can see answers built from all of them.

## Decision

1. **A project switch.** `projects.share_chats boolean NOT NULL DEFAULT true`
   ("add if missing" at start). The owner's project save takes `share_chats`
   (boolean, else 400 `invalid_project`); a save without it keeps the stored value,
   a new project starts on. It is an owner command, so it raises the guard epoch.
2. **Bound on the server, per request.** A group or topic reader (not the owner,
   not a bound answer, member or member-read reader) gets a read set from
   `bindReads` on every storage request and Telegram turn: when its group is served,
   in an active project whose switch is on, and that project has another served
   group, the read set holds every served group of the project
   (`sharedProjectGroups`), whole, with the turn's own chat as home. With topics
   keeping their own memory, the turn's own topic is read exactly and the other
   groups whole. A read set a pass carries is dropped and decided again. A missed
   call site stays the group's own read (fail closed).
3. **Every read follows the set.** Source access (`canRead`, `readable`), archive
   search and conversations, relations, learned entries, Honcho recall (the session
   list widened by group ids) and tasks (`reach`) read the set
   (`sharedReads`). The owner's private chat and every other private chat are never
   in it; groups in no project, other projects and unserved groups are never in it.
4. **A member's private chat.** A member who joined a group of a sharing project
   reads all of that project's served groups from their private chat, and that
   project's tasks view reaches them. Off, it reads only the groups they joined.
5. **Answer privately only while off.** `PrivateAnswerRepository.offerable`
   offers the button only in a project whose switch is off: a sharing project's
   group answer already reads its groups.
6. **Dashboard.** Memory › Projects: the project dialog's "Share group chats"
   switch with the risk line, and a badge on the project. Wherever a group joins a
   project, the note says what the project's switch means: shared answers while on,
   private answers while off.

## Consequences

- The owner turns sharing off per project; each group then reads only itself and
  Answer privately comes back. An archived project shares nothing.
- Known gaps, accepted for now: the members' app's group reach is not widened, nor
  is reminder delivery's (a member's reminder set in one group on a task of
  another group of the project takes the owner lane, not the member's chat); a
  group a member's turn left out, left or last saw long ago comes back through
  another joined group of a sharing project; a reset-setup snapshot restores
  `share_chats` at its default (on); a member's per-group switch is passed by
  sharing; the start-of-turn Honcho session context stays the group's own (recall
  tools reach the others); sharing rules and fact grants stay keyed to the home
  group.
- Checks: `test/store-shared-project-chats.test.ts`, the owner API, private-answer
  and project store tests, the dashboard browser test, and the full tester's
  `project_groups_stay_apart` (off, then on).
