<decision>

# 0093 — Commit memory approval and its follow-up together

<context>

[0057](0057-memory-relationship-access-map.md) permits a one-time, exact memory
grant for a pending group response. [0041](0041-local-inngest-workflows.md) makes
the control outbox durable. Committing a grant before creating its follow-up
leaves a crash window: approval can succeed without any work available to send,
and replaying a saved decision can bypass the missing handoff.

</context>

<choice>

Prepare the guarded Telegram proposal before taking control-store locks. Record
the memory decision, grant, exact action, both delivery links, security event and
workflow request in one control transaction. Recheck the request expiry, fact
revision and guard binding at that boundary. A denied action or failed handoff
rolls back the approval. Guarded delivery wording must match the approved grant.
Delivery and one-time consumption still require the separate native receipt.

An exact replay of an older committed decision can repair its missing handoff
only while its grant, request, automatic-follow-up setting and authorization are
current. Reuse the original action identity and any saved receipt. This is an
owner-command recovery path; listing requests does not authorize new work and
imported history does not become active authority.

A confirmed action already linked to a grant can repair the missing request link
after revocation. That reconciliation checks the source, destination, binding and
wording hash, records the historical delivery, and preserves revocation without
starting any new action.

Keep the standalone trusted-action entry point for content-free owner
notifications. It uses the same preparation and transactional staging primitives.

</choice>

<consequences>

Derived preparation can survive a rolled-back control transaction and be reused
on retry, but it cannot send a message by itself. Control locks never surround
model preparation. There is no new workflow family, provider call, schema,
credential or delivery retry policy. Existing numeric and concrete-topic action
identities remain compatible with [0092](0092-exact-topic-action-destinations.md).

</consequences>

</decision>
