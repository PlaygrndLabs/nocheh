# ADR-0313: Problem notices are off by default

<status>
Accepted on 2026-11-26. The owner did not want system problem messages in their private chat:
"make it optional and by default be disable". A separate read-only problems group was considered
and dropped as more than the need. Amends the notice default of the problem check
(`tools/operations/provider/problems.py`).
</status>

## Context

- The dashboard's problem check sends the owner's private chat a notice about each new or worse
  problem. `TELEGRAM_PROBLEM_NOTICES` turned it off, but it was on by default.
- The private chat is where the owner talks to Nocheh. System messages there are noise.
- With notices off, a failure, such as a scheduled brief that did not run, must still be seen.
  System › Health already lists the problems, but only when the owner opens it.

## Decision

1. `TELEGRAM_PROBLEM_NOTICES` defaults to `false`. The check sends a notice only when it is `true`.
   Everything else about notices stays as it was.
2. The System item in the dashboard's menu shows, in red, how many things System › Health says
   need a look (`issues` in `dashboard/lib/system-health.ts`), on every page.
3. Health also lists the two problems only a notice told about before: a GitHub app GitHub
   refused, and stopped machine jobs whose programs Nocheh could not end.
4. The notice that a schedule's result or a job's report did not reach its chat
   (`ownerNotice` in `src/stores/telegram-actions.ts`) is not a problem notice and is not
   covered by the switch: it is about a chat the owner turned off and needs the owner's action.

## Consequences

- An installation whose `.env` already says `TELEGRAM_PROBLEM_NOTICES='true'` keeps notices on
  until the owner switches them off in Settings › Telegram.
- With notices off, nothing tells the owner about a problem until they open the dashboard.
