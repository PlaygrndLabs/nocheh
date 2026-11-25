# ADR-0307: The Keys list and "Stop everything now"

<status>
Accepted on 2026-11-25 as step 1, part C (second half), of the owner-approved key design. The owner chose what Stop does
on 2026-11-25: "End all, new agent login". Builds on [ADR-0306](0306-close-key-read-gaps-and-log-key-use.md) (each key's use
is counted) and [ADR-0295](0295-agent-login-replaces-the-master-key-in-hermes.md) (the agent login).
</status>

## Context

Every reply and run now has its own key, closed when it is done (ADR-0305), and each key's use is counted (ADR-0306). The
owner had no way to see the keys, and no single action to end everything at once if they think a key or the agent's login
was copied. The design promised a dashboard Keys list and a "Stop everything now".

## Decision

1. **The Keys list.** `GET /v1/keys` (owner only) lists the owner, then each member as the Members page orders them: on or
   paused (a member's state), how many keys are open now, and when one of their keys last brought a request (the latest
   `last_used_at` within the 30 days keys are kept). It also gives the last stop and what it ended. The dashboard shows it
   on its own Keys page, after Members. A member's pause stays on the Members page; pausing ends their keys (ADR-0306).
2. **Stop ends everything under way, at once.** `POST /v1/keys/stop` is one owner command (idempotent by operation id, no
   guard epoch). In one transaction it closes every open key (`stopped`); cancels cards not approved, or approved and not
   started (`telegram_action_requests`, `controlled_actions`, error `owner_stopped`); cancels follow-ups not yet run
   (`action_continuations` pending or waiting); cancels runs captured or under way (`managed_runs`, their runtime turns
   closed); ends schedule grants not used (`schedule_turn_grants`, `schedule_grants`); and records the stop in `key_stops`
   (one row, the last stop). The workflow rows of the cancelled cards and follow-ups are cancelled if still queued or
   waiting. After it commits, every job not ended is stopped as its own Stop does (`halt`), which ends its live run.
3. **Then a new agent login, alone.** The dashboard then asks for `POST /keys/agent-login` (browser session only), a job
   like Apply: a new `AGENT_KEY` is written and applied (`rotate_agent_login`), so Hermes and the services that check the
   login restart with it, in about a minute. The master key and Hermes's session token stay, so the dashboard and executor
   keep theirs and are not restarted. If the services do not come back, Apply's roll back returns the old login, and the
   page says so; the keys stay ended either way.
4. **One-shot.** Stop does not latch: new messages after it start new replies with new keys. Messages waiting in line are
   answered as usual.

## Consequences

- A copied key, pass or agent login stops working at once; the replies, runs, cards and jobs in progress are lost and must
  be asked again.
- Stop can be pressed again at any time; the same operation id answers the same.
- `key_stops` is new; `one_time_keys` rows keep the reason `stopped`.
