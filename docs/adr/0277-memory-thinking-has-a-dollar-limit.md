# ADR-0277: Memory thinking has a dollar limit

<status>
Accepted on 2026-11-23. The owner chose, on a decision card, "Thinking dollar limit, off by
default" over counting thinking in the memory search cap or only renaming. Amends
[ADR-0079](0079-separated-honcho-budgets-and-settlement.md) and
[ADR-0078](0078-owner-honcho-budget-control.md): memory thinking's request-count limit becomes a
monthly dollar limit. Keeps the earlier owner rule that thinking runs freely until the owner
turns a limit on. Keeps the memory search cap as it is.
</status>

## Context

Honcho's egress (`services/honcho/meter.py`) has two limits. Memory search (embeddings) has a
dollar cap: $5 in the pilot, then an owner-set monthly cap up to $15. Memory thinking (the memory
part's chat model) had only a count of requests a month, off unless the owner turned it on. The
meter never priced thinking; the Usage page priced its tokens later through Hermes.

So the dashboard's spending limit showed $0.35 counted while the Usage page showed about $25 of
memory thinking in the same week. Nothing stopped thinking spend, and a request count says
little about cost: one request can cost a fraction of a cent or more than a dollar.

## Decision

1. **The meter prices thinking as each call finishes.** A successful call with a usage report is
   priced at Anthropic's list price from its prompt and output tokens, rounded up to a
   microdollar, into `usage_daily.cost_microdollars`. The price table is the same as
   `CLAUDE_PRICES` in `services/hermes/usage.py`, copied because the meter's container cannot
   import Hermes's module; a test keeps them equal. A model with no known price is not priced
   and is counted as unpriced, never as free. A refused call costs nothing.
2. **A monthly dollar limit replaces the request count.** `policy.thinking_limit` holds the limit
   in microdollars, NULL while it is off, which is the default. The owner sets it in
   Memory › Long-term memory from $0 (pause) to $1,000 in cents, with the same revision check and
   operation id as the search cap (`thinking_limit_cents` on `POST /honcho/budget`; None turns
   it off). It counts the UTC calendar month, in pilot and monthly mode alike, and never counts
   memory search. `reasoning_limit` and its request count are no longer used.
3. **The meter refuses thinking at the limit.** Before a thinking call, while a limit is on, the
   meter refuses with `monthly_thinking_limit_reached` once this month's priced spend has
   reached it, and with `thinking_price_unknown` when the memory model has no known price.
   Spend is counted from finished calls, so calls already under way can pass the limit by their
   own cost.
4. **Spend always shows.** The Limits card shows thinking spend this month, with or without a
   limit, the requests count, and how many calls had no price. The Usage page shows the
   meter's cost for a memory row the meter priced in full, and asks Hermes for the rest, as
   before.

## Consequences

- The owner can cap a re-learn or a runaway learning loop in dollars.
- With the limit off nothing changes for learning.
- A memory model behind a custom gateway is priced at Anthropic's list price, which may differ
  from what the gateway charges.
- When Anthropic changes prices, both tables change together.
