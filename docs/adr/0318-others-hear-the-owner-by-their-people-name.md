# ADR-0318: Others hear the owner by their People name

<status>
Accepted on 2026-11-28 by the owner, after a live test where a member read "The owner said in
this group today…". Builds on 0274 (People names everywhere). Keeps 0152 (no names in source
labels).
</status>

## Context

- Groups, members' private chats and private answers read the owner as "the owner", because
  source labels and notes name the owner only by that fixed word (0152), so nobody can pass as
  the owner by name.
- Nocheh repeated that word to others. People in a group know the owner by name.

## Decision

1. The owner's People name is the name the owner chose on the People page for their own
   Telegram account (`ownerPublicName`, through `identityPeopleNames`). No chosen name, no
   People name.
2. Every turn carries it as `owner_name` (`agentWithPrompts`). Hermes passes it on only when
   the turn's scope is not the owner (`turn_process.owner_name`: one line, at most 200
   characters), and a retry may carry another name.
3. Outside the owner's private chat, the reply rules end with a new editable text,
   `reply.owner_name` (Settings › Assistant, "Naming you to others"), which must keep `{name}`:
   call the owner by that name when speaking of them to others, and say "you" to the owner.
   The owner's private chat and the owner's ask about a member keep their rules.
4. The fixed group not-allowed reply (`telegram.not_allowed`) fills `{owner}` with the People
   name, or "the owner" without one. The default reads "Sorry, in this group I only work with
   {owner} and {owner}'s members."
5. Source labels, notes and the memory evidence keep "the owner" (0152).
6. The private not-allowed reply is unchanged: it goes to strangers who write privately, so it
   does not name the owner.

## Consequences

- Without a People name, replies and the fixed reply read as before.
- A replaced `telegram.not_allowed` without `{owner}` is sent as written.
