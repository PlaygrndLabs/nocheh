# ADR-0038: Observed Telegram health and host OAuth callbacks

Status: accepted for the local incident repair, 2026-09-11.

## Context

A native Telegram polling recovery reached `telegram_network_error` while Nocheh
continued reporting its startup `connected` value. The upstream adapter expected
its supervisor to replace it after a fatal error; the thin Nocheh supervisor only
waited indefinitely. One incoming update remained pending at Telegram.

The provider panel started browser OAuth inside Docker. The registered callback
uses `http://localhost:1455/auth/callback`, which addresses the owner's host browser,
not the container. Container health and credential-file presence did not establish
that either message processing or authentication worked.

## Decision

Observe native adapter fatal state and actual successful getUpdates/capture progress.
Report degraded or failed reception separately from service liveness. On retryable
fatal failure, save a content-free incident and exit the runtime after bounded cleanup;
Compose restarts the entire process. This terminates the old poller before its
replacement starts. Nonretryable failures remain visible for owner intervention.
Durable dispatch and delivery receipts retain their existing replay rules.

Add owner-only Monitoring to Nocheh. It reads existing durable workflow records,
shows current stage blockers, attempts, next checks, successes, skips and uncertain
outcomes, and refreshes every ten seconds. It also shows live reception, services,
provider login and active route. Missing observations are unavailable, not zero.
This is current-state monitoring, not a complete historical trace of every attempt.

For owner-started browser OAuth, Nocheh temporarily binds host loopback port 1455.
It associates the pending OAuth state with the listener and relays the one-time
callback through the authenticated provider management API. Upstream retains the
PKCE verifier and token exchange. The listener expires after five minutes, rejects
unmatched/replayed callbacks, and removes codes from its return navigation. An
occupied port fails before starting a login. No new container port is exposed.

The three proxy API keys are locally generated service credentials for Hermes,
Honcho and preparation. They are independent of ChatGPT OAuth and paid embeddings.

## Inngest

Self-hosted Inngest is a candidate for durable workflow execution and step history.
It is not activated by this repair. Moving execution requires explicit step,
retry, outbox and delivery-receipt ownership; publishing success-shaped shadow runs
would not demonstrate that Inngest owns the work. The proposed migration is in
[workflow-monitoring-plan.md](../workflow-monitoring-plan.md).
