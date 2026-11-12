# ADR-0242: Private chats stay out of group sharing

<status>
Accepted on 2026-11-12, when the owner approved the Members design: "I just
review the tables and seems what I want if there is a important point or need my
answer ask, else start build." Its step 1 is "Keep your private side out of
groups". Amends [ADR-0226](0226-a-project-can-share-what-its-chats-know.md)
(owner rules and project assignments too, not only project rules),
[ADR-0057](0057-memory-relationship-access-map.md) (the default follow-up and
what one-time access means) and
[ADR-0093](0093-atomic-memory-approval-followups.md) (which replays repair a
follow-up).
</status>

<context>
- Product rule: nothing crosses from the owner's private side into a group or a
  member's chat unless the owner approves a card that names who will see it.
  The owner's private chat can never be put in a project or used as a sharing
  source or destination.
- ADR-0226 kept private chats out of project rules only. An owner rule could
  read the owner's private chat into a group, and a private chat could be
  assigned to a project.
- Memory access suggestions could offer a fact whose evidence came from the
  owner's private chat, and could be raised in any chat. A manual grant could
  target any chat and did not say where the fact came from.
- Automatic follow-up was on by default. With it off, a one-time approval
  posted nothing, and a later turn never reads a one-time grant, so the approval
  had no effect. An exact replay repaired a follow-up whenever the current
  setting was on, whatever the replayed command had done.
- Rows saved before this change, imports and reset snapshots can still name a
  private chat.
</context>

<decision>
- `groupSpace(space)` in `src/spaces.ts`: only a group (a negative chat ID) or
  one of its topics can share, be shared with, or join a project. Everything else
  counts as private and fails closed: the owner's private chat and its topics,
  any other private chat, `desktop:*` imports, `system` and an unknown
  conversation. `groupChatId` is the shared group test. A later split between
  the owner and members can change the helper without changing its callers.
- Writes refuse a private chat:
  - an owner sharing rule with a private source or destination: 400
    `sharing_private_chat`;
  - an `assigned` project assignment of a private chat: 400
    `project_private_chat` (`none` and `inherit` stay allowed, so a saved one
    can be cleared);
  - an organization delegation over a private chat: 400
    `organization_private_chat`;
  - agent proposals use the same codes. Learned organization drops a private
    chat's assignment, and a batch left empty is no proposal.
- Reading fails closed for rows saved earlier:
  - `covers()` starts with `if(!groupSpace(space))return false`;
  - `forDestination()` ignores a private destination;
  - `effective()` gives a private chat no project;
  - the rule list returns `private_sources`, and the dashboard flags such a rule
    with "Reads a private chat. Nocheh skips it."
- Reset:
  - the setup restore refuses a private source, a private destination or a
    private `assigned` row;
  - the reset's own check refuses the same before anything is erased
    (`reset_configuration_private_chat_requires_review`);
  - a legacy space policy loses its private sources, and one for a private
    chat is not carried over.
- Memory access suggestions:
  - never raised in a private chat;
  - skip a fact when any piece of its evidence comes from a private or unknown
    conversation;
  - record `evidence_spaces` in the proposal.
  An older request into a private chat, or one whose fact rests on private
  evidence, is cancelled when decided, with 409
  `memory_access_private_destination` or `memory_access_private_evidence`.
- Follow-up:
  - the `*` setting is created with `auto_followup` false, on a new install and
    in the reset's fresh baseline;
  - one-time access always posts the approved wording once in the chat, now;
  - lasting access posts it only when the owner sends `post: true`, or, when
    `post` is left out, when the chat's follow-up is on;
  - `post` joins the command's identity only when given, so older commands keep
    theirs;
  - a replay repairs a missing follow-up only when the replayed command posted
    (one-time, or `post: true`), never because of the current setting.
- Grants:
  - go only to a group or topic (400 `memory_grant_private_destination`);
  - a fact with any private or unknown evidence needs
    `private_evidence_confirmed: true`, otherwise 409
    `memory_grant_private_sources`;
  - the agent cannot set that flag (it is not a proposal field). Applying a
    `fact_grant` card the owner approved sets it, because that card names the
    sources.
- Every card and editor that shares or rewords a fact names where it came from
  and who will see it:
  - owner `GET /v1/entities/claims/<id>/audience` returns `sources`,
    `private_sources`, `owner_private`, `confirm_required` and `readers`, which
    is the group or topic that can read the fact without a share, matching
    `canRead` and topic memory, or null for only the owner;
  - memory access requests carry `source_spaces`, `audience` and
    `post_default`;
  - knowledge cards for `fact_grant` and `entity_correct` carry
    `fact_audience`;
  - the People share form lists only groups and topics, and asks first, naming
    the private chat, before sharing a fact that came from one;
  - the correction editor says who can read the new wording.
- Dashboard: the chat pickers for sharing rules, projects and organization offer
  only groups and topics. A private chat's page says "Your private chat never
  joins a project." in place of the project card.
</decision>

<consequences>
- What is kept from before:
  - an owner rule or assignment saved earlier that names a private chat stays
    saved, but sharing skips its private parts;
  - a grant made earlier on a fact with owner-private evidence stays active
    until the owner revokes it;
  - on an existing install the saved `*` setting keeps `auto_followup` true
    until the owner turns it off.
- A reset stops before erasure while a rule or project still names a private
  chat, so the owner removes it and runs the reset again.
- Every chat with a positive ID counts as private, a member's too. A later step
  can give a member's private chat its own rules.
- Checks:
  - [spaces](../../test/spaces.test.ts),
    [knowledge contract](../../test/knowledge-contract.test.ts),
    [projects](../../test/store-projects.test.ts),
    [sharing](../../test/store-sharing.test.ts),
    [owner API](../../test/store-owner-api.test.ts),
    [reset setup](../../test/store-reset-setup.test.ts) and
    [reset check](../../services/hermes/test_reset_configuration.py);
  - [knowledge management](../../test/store-knowledge-management.test.ts),
    [memory access](../../test/store-memory-access.test.ts) (with the
    "owner says X about member M" canary),
    [follow-ups](../../test/store-memory-followup.test.ts),
    [audience](../../test/store-entity-owner-corrections.test.ts) and the
    [dashboard](../../test/dashboard-pages.browser.mjs).
</consequences>
