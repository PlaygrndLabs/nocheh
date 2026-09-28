# ADR 0078: Owner-controlled Honcho monthly budget and usage view

Status: Accepted

Extends ADR-0034's conservative embedding admission ledger and ADR-0077's
initial monthly cutover. The $5 pilot limit and Honcho acceptance gate remain
in effect.

## Decision

After Honcho is verified and attached, the authenticated owner dashboard can
set the UTC monthly embedding cap from $0 to $15 in cent increments. The
default monthly cap is $5. A $0 cap pauses paid embeddings. Lowering a cap
below existing reservations blocks further paid embeddings while zero-reserve
subscription reasoning remains available within the existing 1,500-request
safety bound. Cap updates use a durable ledger
revision and an idempotent operation ID; they never erase reservations or
restart a budget window.

The dashboard presents current reservations, admission headroom, request
counts, provider-reported embedding tokens, and a token-priced estimate.
Estimates omit requests without a usage report and are labeled separately
from OpenAI's authoritative billed usage. Raw request digests, source content,
provider credentials, and per-call audit data stay out of the budget API.

## Rationale

A fixed $5 cap and raw SQLite inspection do not let the owner manage ongoing
embedding use. A persistent ledger policy applies changes atomically with
request admission, while revision checks and clear accounting let the owner
adjust spending without mistaking conservative reservations for charges.
