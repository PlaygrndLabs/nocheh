# ADR-0151: Each chat's role and skills live in its Hermes profile

<status>
Accepted on 2026-10-17.
</status>

<context>
The owner asked for a role and skills per group or user, a memory file per chat,
and to use Hermes' own profile role and skills rather than a Nocheh copy. Every
selected group and the owner's private chat already has its own canonical
Hermes profile, but turns ran with `skip_context_files=True` and without the
skills toolset, so Hermes ignored `SOUL.md` and skills. Turn profiles are
derived from the canonical one (per topic, policy revision, guard epoch and
installation generation), and isolated turns mount only the profile files they
are given.
</context>

<decision>

- The owner's role for a chat is the canonical profile's `SOUL.md`; its skills
  are `skills/<name>/SKILL.md` with Hermes frontmatter (`name`,
  `description`). `nocheh-default/` in the Hermes home holds the same files for
  every chat. Topics have none of their own.
- Before each turn the profile is given the effective files: the chat's role or
  else the default role, and the default skills plus the chat's, the chat's
  winning by name. The canonical source folders are never rewritten by a turn.
- Turns load `SOUL.md` as identity (`load_soul_identity`) and enable the
  `skills` toolset, but drop Hermes' `skill_manage`, so a turn reads skills and
  cannot write them. Isolated turns mount `SOUL.md` and `skills/` read-only
  beside `config.yaml`.
- The owner reads and saves them through the `persona.read` and `persona.write`
  runtime operations (`/v1/manage/hermes`, action `persona`) with a revision
  check. That route also serves the existing profile, preference and
  native-note actions, which had no route in the storage service.
- Hermes native notes stay the per-chat memory the agent updates; no separate
  memory file is added.

</decision>

<consequences>
A replacement runtime implements the two operations with its own notion of a
role and skills. A turn that runs directly in a canonical profile (legacy
security runtime without a guard epoch) reads only that chat's own files and
not the defaults. An original-only reset does not yet carry roles and skills
across with the other preferences.
</consequences>
