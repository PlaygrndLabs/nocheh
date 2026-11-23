# ADR-0281: A member's own time zone

<status>
Accepted on 2026-11-23. The owner agreed that a member's schedule runs in the owner's
time zone unless they name another, and asked for a setting that lets the member change
their time zone themselves or by asking the agent. Amends
[ADR-0277](0277-members-own-schedules.md) decision 2.
</status>

## Context

A member's schedule ran in the owner's time zone unless the member named another for
that one schedule. A member in another city had to name it every time.

## Decision

1. **One setting per member.** `members.time_zone`, an IANA name such as Europe/Berlin,
   or null for the owner's. Null by default. It counts only for a member with Personal
   assistant on.
2. **New schedules use it.** `/v1/schedules/turn` gives the member's time zone, or the
   owner's when they have none, as the zone Hermes's schedule gate puts on a new
   schedule that names none. A schedule already set keeps its own zone; the member can
   ask the agent to move one.
3. **The members' app.** Settings › Schedules has a time zone list (every zone the phone
   knows), "Use this phone's time zone", and "Same as the owner", which never names the
   owner's zone. `POST /time-zone {operation_id, time_zone|null}` counts against the
   member's write limit. `GET /schedules` returns `time_zone`, the member's own or null.
4. **By asking.** The MCP tool `my_time_zone` (`POST /v1/members/time-zone`), offered only
   to a member's own private chat, sets it from the member's own live message there, not
   a forward, with Personal assistant on: the same check that lets them set schedules
   (`scheduleTurn`). Anything else is refused with `member_time_zone_not_here`; an
   unknown name with `invalid_time_zone`.

## Consequences

- Pausing a member, or turning Personal assistant off, keeps their time zone with the
  rest of their data.
- Resetting the setup does not keep a member's time zone: it goes back to the owner's.
- Checks: `test/store-member-schedules.test.ts`, `test/store-member-app-server.test.ts`,
  `test/member-bound-readers.test.ts`, the members' app browser test and
  `services/hermes/test_member_private.py`.
