<adr>

# ADR-0047: Retry event delivery until a workflow records receipt

<context>

The 2026-09-16 isolated outage rehearsal observed an HTTP-accepted preparation
event that never reached the engine's event store. The archive and Nocheh outbox
still held the source. The pinned Inngest v1.44.0 server uses a separate event
messaging backend; its default in-memory transport can acknowledge a publication
with no subscriber during startup. External Redis persistence does not cover
that handoff. See the pinned [messaging configuration](https://github.com/inngest/inngest/blob/v1.44.0/pkg/config/messaging.go)
and [in-memory transport](https://github.com/inngest/inngest/blob/v1.44.0/vendor/gocloud.dev/pubsub/mempubsub/mem.go).

</context>

<decision>

As part of the owner's approved durable migration, retain responsibility for
event delivery until a fenced workflow claim records receipt for its current
dispatch. Re-publish an accepted but unreceived event after 30 seconds, retaining
the exact event ID, workflow ID, version, epoch and dispatch. Apply the existing
admission, registration, state, lease and retry constraints. A recorded workflow
receipt stops these delivery retries; Inngest owns execution retries and waits.

This extends ADR-0041 and ADR-0046 without adding a service, changing permanent
deduplication identities or restoring a legacy execution scanner. Events still
contain only opaque references and approved metadata.

</decision>

<consequences>

An unreceived event can be sent more than once. Inngest event deduplication and
Nocheh's permanent workflow/domain identities, fenced claims and effect receipts
remain necessary. An HTTP acknowledgement alone is insufficient evidence that a
workflow has received its request. This does not claim exactly-once transport.

Validation covers unchanged event re-publication, bounded retry timing and
stopping after receipt, plus the real-server outage, effect-crash and duplicate
capture rehearsal. Results and deployment status are in [TASK.md](../../TASK.md).

</consequences>
</adr>
