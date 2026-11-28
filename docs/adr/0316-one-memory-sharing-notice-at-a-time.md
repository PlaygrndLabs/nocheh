# ADR-0316: One memory sharing notice at a time, with no id and no local link

<status>
Accepted on 2026-11-28, after a live test: four owner notices in two minutes each read "A memory access suggestion needs
review: http://localhost:8783/#inbox?kind=memory_access&decision=***". The id was hidden by the secret check (as in
ADR-0314), and a local address does not open from the owner's phone. Amends the owner notice of the memory access
suggestions (`MemoryAccessRepository.suggest`).
</status>

## Decision

1. A new suggestion sends the owner's private chat a notice only when no notice sent in the last hour still has a
   suggestion waiting. One advisory lock makes the check and the send one step, so suggestions in a row send one notice.
   Every suggestion still waits in the Inbox.
2. The notice names no request id: "Memory sharing suggestions wait for your review", with a link to the dashboard's Inbox
   (`#inbox`) only when `NOCHEH_DASHBOARD_URL` is set to an http or https address (`dashboardInbox`). Without one it says
   to open Inbox in the dashboard or the Nocheh app, and has no link.

## Consequences

- The owner gets at most one such notice an hour while suggestions wait, and a new one after they are all decided.
- A suggestion that sent no notice is not told about later; the Inbox lists it.
