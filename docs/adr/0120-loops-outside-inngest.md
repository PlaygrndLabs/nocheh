# ADR-0120: Classify every Nocheh loop that runs outside Inngest

<status>
Accepted implementation decision. Extends
[0041](0041-local-inngest-workflows.md),
[0042](0042-host-workflow-archive-coordination.md) and
[0047](0047-receipted-event-handoff.md).
</status>

<context>
The owner's 2026-10-09 review requires Inngest to run the full Nocheh
workflow, with Hermes and Honcho as parts of it and without changing Hermes'
internal workflow. The [operations review](../operations-review-plan.md) listed
the periodic paths that still ran outside Inngest and asked for each to be
classified as an Inngest function, an Inngest cron, or a required out-of-band
safety path, and for the superseded single-database worker to be removed.

The same specification also requires source capture and spool draining to
continue during orchestration outages, a supervised publisher that retries
workflow delivery independently of Inngest, and API, capture and management
operations that do not depend on Inngest availability.
</context>

<decision>
Every product workflow already runs as an Inngest function: Telegram
attachment retrieval, transcription, guarded preparation and dispatch (which
calls the Hermes turn and its reply send as a step), imports, native memory
review, Honcho synchronization and context, browser turns, scheduled
occurrences, organization and approved actions. The paths below stay outside
Inngest, each for the stated reason:

| Path | Where | Class | Reason |
| --- | --- | --- | --- |
| Telegram polling and capture into the spool | Hermes Telegram adapter | Adapter capture | Telegram is an adapter; capture must work while Inngest is down, and Hermes keeps its own internals |
| `capture`: spool drain into the archive | `nocheh-app`, 1 s | Out-of-band safety path | Capture continues during orchestration outages |
| `reconciliation`: archive-to-control handoff sweep | `nocheh-app`, 1 s | Out-of-band safety path | Recovers a crash between archive commit and workflow request; it creates the requests Inngest later runs |
| `outbox`: workflow request publisher | `nocheh-app`, 1 s | Out-of-band safety path | The publisher is how work reaches Inngest and retries independently of it |
| `guards`: pending guard, selection and learned publication completion | `nocheh-app`, 1 s | Out-of-band safety path | Completes a cross-store commit interrupted by a crash; it is store recovery, not workflow work, and an Inngest run per sweep would only add history |
| `heartbeat` and the security heartbeat | `nocheh-app` 1 s, `nocheh-security` 5 s | Out-of-band health | Service health is reported whether or not Inngest is reachable |
| `timings`: stage timing expiry | `nocheh-app`, hourly | Out-of-band retention | Bounded local delete with the same retention setting as workflow history |
| Workflow history and record retention | `nocheh-db` retention worker, daily | Out-of-band retention | Removes Inngest's own rows, so it cannot depend on Inngest |
| Worker connection supervisor | `nocheh-app` and executor, 5 s | Out-of-band connection | It is the connection to Inngest |
| Hermes schedule definition sync and finish-receipt flush | Hermes scheduler, 2 s | Adapter capture | Hermes owns schedule definitions; the loop captures definitions and retries finish receipts, while each occurrence advances inside the Inngest schedule workflow |
| Hermes managed-run heartbeat and native review thread | Hermes plugin | Inside an Inngest step | Started and observed by Inngest steps; no independent schedule |
| Workflow lease renewal | `src/workflows/engine.ts`, 15 s | Inside an Inngest step | Keeps the fenced claim of the running step |

No remaining path is converted into an Inngest cron. A cron would either stop
during an Inngest outage, which the specification forbids for capture and
publication, or add an Inngest run per tick to work that is a short database
statement.

The superseded single-database worker (`src/worker.ts`), its workflow service
(`src/workflows/service.ts`) and an unreferenced broker guard service
(`src/security/guard-service.ts`) are removed. The three-store runtime in
`src/stores/` is the only worker.
</decision>

<consequences>
A new periodic path must be an Inngest function or join this table with a
reason. Older single-database modules that only tests import
(`src/workflows/browser.ts`, `src/workflows/memory.ts`,
`src/workflows/preparation-request.ts`, `src/graph.ts`) remain until their
tests move to the three-store runtime.
</consequences>
