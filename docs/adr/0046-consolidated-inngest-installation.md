<adr>

# ADR-0046: Consolidated applications and Inngest-only workflows

<decision>

Accepted by the owner on 2026-09-16. Service names describe tool and purpose.
Nocheh combines archive/API, capture, publisher and ordinary Connect handlers in
`nocheh-app`, with independently supervised progress and bounded separate pools.
The broker and guard share `nocheh-security`, outside agent execution. Hermes
serves native dashboard assets through its existing managed administration server,
with presentation preferences separate and no duplicate native startup lifecycle.
The owner dashboard and host executor remain independent host processes.

Keep the Inngest engine, durable Redis, shared-server dedicated PostgreSQL database,
Honcho API/deriver/stores/gateway, full CPA monitoring, speech and launcher boundaries.
`inngest-db-init` is a completed one-shot job; pgweb is an optional read-only tool.
All nine Nocheh workflow families use Inngest. Retain native vendor internals,
synchronous security, durable outbox/receipts, admission and stale-owner fencing.
After verified cutover, remove legacy execution and engine-switch controls.

</decision>

<consequences>

This supersedes the separate Nocheh application processes in ADR-0041, the native
presentation container in ADR-0025/0027/0036, and separate guard transport in
ADR-0037. Security and independent host recovery requirements still apply.
Consolidation shares application failure fate; bounded pools/concurrency and
independent connection supervision protect capture during engine outages.
Source-preserving migration is preferred. The owner permits resetting obstructing
application data as a fallback, preserving backups, credentials, settings,
spending totals and receipts/checkpoints preventing repeated external effects.
This allowance concerns migration only and does not relax future durability.

</consequences>

<acceptance>

Use isolated Compose credentials/state/images, then snapshot and migrate
preparation before Telegram through pause/drain/reconcile. Verify all nine families,
privacy, approvals, outages, late receipts, inactive restore, both dashboards and
single gateway/scheduler/refresh authority. Live text/voice/group/isolation/approval/
restart acceptance and subscription transcription remain release gates.
Actual implementation, activation and evidence belong in [TASK.md](../../TASK.md).

</acceptance>
</adr>
