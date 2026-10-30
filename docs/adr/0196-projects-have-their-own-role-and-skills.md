# ADR-0196: Projects have their own role and skills

<status>
Accepted on 2026-10-29 as part 3 of the chat-review build the owner approved
("I all thing is ready start build."). The plan the owner accepted adds a role
and skills per project, used by every group in that project, with the group's
own on top, and no rules per person. Extends
[ADR-0151](0151-chat-role-and-skills-in-hermes-profiles.md).
</status>

<context>
- A role and skills could be set for one chat or for every chat. A client with
  several groups needed the same instructions in each, such as what a green check
  means in that client's chats, copied by hand into every group.
- Projects already group chats, and a topic follows its group's project.
</context>

<decision>
- A project's role and skills are kept like a chat's, in Hermes's profile layout:
  `projects/<project id>/SOUL.md` and `projects/<project id>/skills/`. Only the
  owner sets them, on the project's page in Memory › Projects.
- A turn's signed credential names the active project of its chat, resolved when
  the turn starts; an archived project or a chat outside any project names none.
  The project never changes which Hermes profile or history the turn uses.
- The turn's role is the chat's own, else its project's, else the default role.
  Skills add up from the default to the project's to the chat's, and a later
  skill with the same name replaces an earlier one.
</decision>

<consequences>
- Instructions for a client are written once for its project. Moving a chat to
  another project changes its role and skills from its next turn.
- Group members still cannot change a role or skill, and the agent only reads
  them, as before.
</consequences>
