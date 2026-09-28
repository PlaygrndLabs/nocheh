# ADR 0077: Allow the monthly cap for exhausted-pilot acceptance

Status: Accepted

Extends ADR-0034's embedding admission ledger and ADR-0068's detached Honcho
acceptance workspace. It does not change the production attachment gate in
ADR-0033.

## Decision

An explicit owner command may switch an exhausted $5 pilot ledger to the $5
per-UTC-month cap while Honcho memory is detached and unverified. The command
requires a fully reserved pilot and a fully detached, unverified connection.
It keeps the pilot reservations in the lifetime ledger. Repeating the command
does not create a new spending window.

Budget activation alone cannot mark live acceptance passed, attach memory, or
authorize historical ingestion. The six live Honcho checks and subsequent
attachment remain separate operations.

## Rationale

A fully reserved pilot otherwise prevents the paid embedding check needed to
verify and attach memory. Starting the already specified monthly cap permits
that check without disabling the admission ledger or treating budget state as
acceptance evidence.
