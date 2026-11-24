# ADR-0298: One monthly spending limit

<status>
Accepted on 2026-11-24. The owner asked for it after the comparison with another personal
assistant. Default: off until the owner sets an amount.
</status>

## Context

Model calls cost money in several places: replies and scheduled runs in Hermes, the secret
check, images and voice notes, and Honcho's memory thinking and memory search. Memory
already has its own limits (ADR-0279). Nothing stops the rest, so a loop in a schedule or a
busy group could spend without bound while the owner is away.

## Decision

1. **One setting.** Settings › Models has "Monthly spending limit"
   (`NOCHEH_MONTHLY_LIMIT_USD`, whole dollars 1 to 100000, empty is off). It is read at
   each check, so it needs no Apply. The row shows this month's and last month's spend.
2. **Counted from the usage report.** Every two minutes, with the problem check, the
   dashboard adds this UTC month's cost from the same rows the Usage page shows. Costs the
   report cannot price are left out and named in the warning.
3. **Warn at 80%, pause at 100%.** Each level is told once a month in the owner's private
   chat, as a problem notice; raising the limit can warn again. At the limit the month is
   written to core (`POST /internal/spending-pause`, service token, table
   `spending_pause`) and to Honcho's meter (`policy.spend_paused`).
4. **What waits.** The security service reads the pause at most every 15 seconds. While the
   current UTC month is paused, a model call is refused with 402 `monthly_spend_limit`
   unless the turn is the owner's own private chat and not a scheduled run. Hermes reads 402
   as out of credit and stops at once. Honcho's meter refuses memory thinking with
   `monthly_spend_limit_reached`; memory search keeps working so recall still finds notes.
5. **Resume.** A new month, a higher limit or turning the limit off clears the pause at the
   next check.

## Consequences

- Members and groups get no reply while paused, and the problem check may report those
  failed replies. The owner was warned at 80% and at the limit.
- The secret check on incoming messages keeps running, so archiving stays safe; its small
  cost still counts.
- A month's total can pass the limit by the calls already under way when it is reached.
