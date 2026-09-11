<adr>

# ADR-0041: Local Inngest product workflows

Status: accepted by the owner on 2026-09-12; implementation and activation are
tracked separately in [TASK.md](../../TASK.md).

<decision>

Use local Inngest for all product workflow families in verified phases. Keep the
owned archive and domain execution receipts authoritative, with a transactional
outbox and permanent deduplication. Use TypeScript Connect applications for the
Compose worker and host worker; retain thin Python/native Hermes adapters.

The server and persistent Redis join the installation's Compose project. A
dedicated Inngest database and role use the existing PostgreSQL instance without
granting access to the archive. Orchestration stores contain references and safe
status metadata, not product content or credentials. SDK 4.20.0 and server 1.44.0
are the accepted initial candidates; verified image digests are recorded with
compatibility evidence before activation.

Nocheh shows workflow summaries and validates retry/cancel controls. Its owner
session protects a read-only Inngest view. Native Telegram processing and delivery
remain one receipt-protected operation. Browser streaming and native schedule
definition semantics are retained; Inngest owns durable scheduling and retries.

Capture and outbox publication remain independently supervised. Host backup,
restore and service shutdown stay outside Inngest; snapshots cover the archive,
native receipts, Inngest history and Redis at a common quiesced point. Restores
are inactive. One fenced authority owns each family throughout migration and
rollback. Uncertain effects are reconciled, never automatically repeated.

</decision>

<supersession>

This accepts and replaces the previously unaccepted workflow-monitoring proposal.
It amends ADR-0031 only for schedule execution ownership: native definitions,
parsing, cadence, occurrence accounting and history remain Hermes-owned.
It extends ADR-0023/0032 recovery coverage and ADR-0038 workflow monitoring.
Existing accepted ADR text is preserved. Product requirements are consolidated in
[SPECS.md](../../SPECS.md); the sequence is in the
[execution plan](../workflow-monitoring-plan.md).

The owner authorized phased local cutover after acceptance, with the host recovery
path, Nocheh summaries and detailed Inngest inspection. This does not authorize
Inngest Cloud, VPS work, external notifications, provider cutover, Honcho attachment
or declaring unfinished release gates complete.

</supersession>

</adr>
