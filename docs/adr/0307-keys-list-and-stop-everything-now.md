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
   guard epoch). In one transaction it closes every key not yet closed (`stopped`; only those still open are counted);
   cancels follow-ups not yet run or waiting to run again after a failed attempt (`action_continuations`); cancels cards
   not approved, or approved and not started (`telegram_action_requests`, `controlled_actions`, error `owner_stopped`), and
   the follow-up a rejected tool card asks for, uncounted; stops every job not ended as its own Stop does (cancel
   requested, a proposed one stopped), so no job relaunches after its run is cancelled; cancels runs captured or under way
   (`managed_runs`, their runtime turns closed); ends schedule grants not used (`schedule_turn_grants`, `schedule_grants`);
   and records the stop in `key_stops` (one row, the last stop). The workflow rows of the cancelled cards and follow-ups
   are cancelled if still queued or waiting. After it commits, each stopped job's live run is ended, each on its own.
   A reply or follow-up already under way finds its key closed when next checked (`one_time_key_closed`), so it is
   withdrawn like a retired source: the agent's turn is cancelled, nothing is sent, and it does not run again.
3. **Then a new agent login, alone.** The dashboard then asks for `POST /keys/agent-login` (browser session only), a job
   like Apply: a new `AGENT_KEY` is written and applied (`rotate_agent_login`), so Hermes and the services that check the
   login restart with it, in about a minute. The master key and Hermes's session token stay, so the dashboard and executor
   keep theirs and are not restarted, even when an earlier key change left them a restart marker (it waits for the next up
   or Apply). Saved settings not yet applied would be applied with it, so it changes nothing while any wait
   (`settings_pending_apply`), and the page asks the owner to apply or discard them first. If the services do not come
   back, Apply's roll back returns the old login, and the page says so; the keys stay ended either way.
4. **Keys close again once the new login is in use.** Until its services restart, the old login could still start work
   and get new keys. So the job then calls `POST /v1/keys/stop` with `again: true`, which closes and cancels everything
   again and adds its counts to the stop. If that call fails, the job says so (`keys_closed: false`) and the page asks the
   owner to stop again.
5. **One-shot.** Stop does not latch: new messages after it start new replies with new keys. Messages waiting in line are
   answered as usual.
6. **The page follows the login wherever it is opened.** The stop in progress and how it ended are kept outside the page,
   so leaving Keys and coming back, a reload, a lost answer or a second tab all show the same login until it ends.

## Consequences

- A copied key or pass stops working at once. A copied agent login stops working once the services restart with the new
  one, about a minute later, and not at all if they roll back to it (the page says so). The replies, runs, cards and jobs
  in progress are lost and must be asked again.
- Stop can be pressed again at any time; the same operation id answers the same.
- `key_stops` is new; `one_time_keys` rows keep the reason `stopped`. Management lets `/v1/keys` and `/v1/keys/stop`
  through to storage (`allowed_path`).
