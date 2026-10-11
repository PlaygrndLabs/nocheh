# ADR-0131: The Honcho meter folds closed months into totals

<status>
Accepted on 2026-10-10. Bounds the Honcho egress ledger listed as unbounded
in the storage review; the embedding cap rules in `SPECS.md` are unchanged.
</status>

<context>
The Honcho meter (`services/honcho/meter.py`) records one SQLite row per
embedding and reasoning call. Cap accounting sums only the current window, but
the lifetime total and the owner report read every row, so rows could not
simply be deleted.
</context>

<decision>

- Once per calendar month (when the meter opens its ledger or finishes a
  call), calls older than the previous calendar month are folded into
  `call_rollups`: one row per month, route and outcome with the call count,
  summed holds and summed duration. Unfinished old calls fold as `unfinished`.
- The current cap window and the previous month keep individual rows, so the
  cap, released holds and unverified legacy exposure are computed exactly as
  before.
- The lifetime total adds the folded holds; the report lists the monthly
  totals beside the remaining calls.
- In the pilot window every call counts toward the cap, so nothing is folded
  before monthly mode is enabled.

</decision>

<consequences>

- Ledger size is bounded by about two months of calls plus a few rows per
  month.
- Per-call audit flags and token usage of folded months are no longer kept;
  their holds and outcome labels are.
</consequences>
