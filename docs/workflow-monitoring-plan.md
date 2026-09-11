# Workflow monitoring and proposed Inngest adoption

[SPECS.md](../SPECS.md) defines accepted monitoring requirements.
[TASK.md](../TASK.md) records implementation. The Inngest sequence below is an
unaccepted proposal, not part of the product specification or authorized activation.

Implemented now: Nocheh's Monitoring page reads PostgreSQL workflow records and
observed native Telegram reception. It shows success, failure, waiting, retries,
skips, uncertain delivery, provider state and the most recent Telegram incident.
It does not provide a retained timeline of every state transition or notifications.

## Why consider Inngest

The owner suggested the official [inngest SDK](https://www.npmjs.com/package/inngest).
Inngest provides persisted steps, retries and execution history. Its server can run
locally in Docker with the Event API and dashboard at port 8288. Self-hosting can
use PostgreSQL instead of the default SQLite persistence; the server also has queue
and state-store requirements. Sources: [self-hosting](https://www.inngest.com/docs/self-hosting),
[observability](https://www.inngest.com/docs/platform/monitor/observability-metrics).

## Proposed increments — not yet implemented

1. Pin the SDK and server; add a local Compose service and an owner-authenticated
   dashboard entry. Use a separate schema in the owned PostgreSQL installation
   for orchestration metadata, keeping archive identities and original bytes
   authoritative in the existing archive. Verify queue persistence and restore.
2. Add a transactional outbox for committed source IDs. Pass IDs and bounded stage
   metadata to Inngest, not raw messages, media, secrets or model prompts. Replay
   uses stable source identities and deterministic idempotency keys.
3. Move capture-following stages into functions: file availability, transcript
   generation, guarded projection readiness, assistant execution, and confirmed
   delivery. Inngest becomes the sole scheduler for each migrated stage; disable
   the old loop for that stage to avoid competing retry owners.
4. Keep native Hermes agent execution and the security boundary. Preserve owner
   approval, policy rechecks, guarded context, subscription-only reasoning and
   delivery receipts. A retry must check an existing receipt; ambiguous external
   effects never resend automatically.
5. Accept with restart, database/outbox outage, duplicate events, quota waits,
   detector failure, cancellation, approval and ambiguous-delivery fixtures. Then
   repeat real owner Telegram text/voice acceptance and record the cutover.

Choose concrete versions and document the orchestration cutover in a new ADR
before activation. Hosted Inngest Cloud is outside this local-only proposal.
