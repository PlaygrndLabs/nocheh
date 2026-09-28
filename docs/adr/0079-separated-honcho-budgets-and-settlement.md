# ADR 0079: Separate Honcho budgets and settle reported embeddings

Status: Accepted

Supersedes ADR-0034's permanent per-request embedding reservation and extends
ADR-0078's owner budget view. The $5 pilot, $5 initial UTC-monthly embedding
cap, attachment gate, and pre-egress reservation remain.

## Decision

The API-key embedding route has a dollar cap. The shared-subscription reasoning
route has a separate 1,500-request safety bound per budget window. Neither route
spends the other's allowance. Reasoning has no local dollar budget because this
route uses the shared ChatGPT subscription rather than the paid embedding key.

Every bounded embedding attempt reserves the model's existing upper bound
before egress: one cent for `text-embedding-3-small` or two cents for
`text-embedding-3-large`. A successful response with a valid token usage report settles
that hold to the model's token-priced amount, rounded upward to one
microdollar. Failed, unfinished, and unreported attempts keep the full hold.
Previously completed monthly calls with valid usage settle once when the
ledger is opened; historical pilot reservations remain intact. The settled
amount is local admission accounting, and the OpenAI usage dashboard remains
authoritative for charges.

The owner dashboard gives the two routes separate panels and explains why a
hold can exceed reported usage. The embedding cap remains the only editable
budget control. Its revision-checked updates preserve every call and do not
reset a window.

## Rationale

The old combined request count let embedding traffic consume the subscription
reasoning allowance. Permanent one-cent reservations made the monthly cap
appear close to exhaustion even when successful embeddings used only a small
fraction of that amount. Settling confirmed usage makes the cap useful while
keeping a conservative hold whenever the paid outcome is uncertain.
