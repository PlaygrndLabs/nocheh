# ADR-0282: The owner sets their time zone where schedules are

<status>
Accepted on 2026-11-23. The owner asked that the owner, like a member
([ADR-0281](0281-members-own-time-zone.md)), can change their time zone by hand or by
asking the agent. Amends ADR-0281 decision 4: the tool and its route serve the owner too.
</status>

## Context

The owner's time zone sits under Settings › Tasks on the dashboard. New schedules set in
the owner's private chat run in it, and task dates follow it. The mini app had no way to
change it, and the agent could not change it when asked.

## Decision

1. **One setting.** The owner's time zone stays the task settings' `time_zone`. It is
   never null.
2. **The Schedules page.** The dashboard's Schedules page, also the mini app's Schedules
   tab, shows "Your time zone": a list of every zone the device knows and "Use this
   device's". `POST /tasks/time-zone {time_zone}` saves that field alone, through
   `tasks.saveTimeZone`, and keeps the rest of the task settings. The mini app may reach
   this route, and still never `POST /tasks/settings`.
3. **By asking.** The MCP tool `my_time_zone` now posts to `POST /v1/schedules/time-zone`
   (was `/v1/members/time-zone`). For the owner it runs only in the owner's own live,
   not forwarded message in their private chat: the same check that lets them set
   schedules (`scheduleTurn`). Hermes keeps the tool only in that turn and in a member's
   private chat. It drops it from every other turn, including a group, a job, a box, a
   machine and a scheduled run. Anything else is refused with `time_zone_not_here`, and
   an unknown zone or null with `invalid_time_zone`. Member refusals now use
   `time_zone_not_here` too.
4. **Schedules already set keep theirs.** A change moves new schedules and task dates
   only. A member with no zone of their own follows the owner's.

## Consequences

- The tool list of a turn that is not a bound reader names `my_time_zone`. Hermes removes
  it before the turn runs, so `verify_profile_tools` still passes.
- Checks: `test/store-member-schedules.test.ts`, `test/store-tasks.test.ts`,
  `test/mini-app.test.ts`, `test/fixtures/owner-storage-paths.json`, the Schedules page
  browser test and `services/hermes/test_member_private.py`.
