# ADR-0290: Nocheh grants every schedule change and fire

<status>
Accepted on 2026-11-24. The owner approved the key design ("Approve, start step 1") and
answered "Yes, read-only for now" for Hermes's own cron page and `nocheh cron`. Amends
[ADR-0266](0266-schedules-set-by-asking.md) decisions 3, 4, 5 and 7 and
[ADR-0277](0277-members-own-schedules.md) decisions 5 and 6; both stay as written for
everything else.
</status>

## Context

The key design takes Nocheh's master key away from Hermes. Today Hermes's gateway alone
can define a schedule (`/v1/scheduler/definition`) and fire one (`/v1/scheduler/input`
with any reason, the epoch read from `/v1/scheduler/ownership`). A later agent login that
can only post checkpoints must not be able to create, change or fire schedules as the
owner. Hermes still decides when a schedule is due; Nocheh decides that it may be set or
fired.

## Decision

1. **Grants are rows Nocheh keeps.** No new secret passes through Hermes. A turn grant
   (`schedule_turn_grants`) names a turn, its chat, its schedule profile and its person
   (the owner, or the member in their own chat). An edit, Run now or clock grant
   (`schedule_grants`) names one schedule and is used once. Expired grants are kept a
   day, then dropped.
2. **Set by asking, as that turn.** When `/v1/schedules/turn` allows a turn, Nocheh
   records a turn grant for 15 minutes and answers with the chat and profile. Hermes
   posts a schedule the tool set from inside the sealed turn, through the broker, to
   `/v1/schedules/turn/definition`. Nocheh needs that grant, the turn still allowed now,
   the same chat and profile, a member's cap counted inside the transaction, Telegram
   delivery, a known time zone and a cron it can match exactly. It records who set it
   and in which turn, and sends Nocheh's message for a new schedule from there; Hermes
   no longer asks for it (`/v1/scheduler/announce` is gone).
3. **Hermes alone only checkpoints.** `/v1/scheduler/definition` without a grant accepts
   only a schedule Nocheh already has, with the same execution version, never turning it
   back on and never changing whether it is removed. Anything else is 403
   `schedule_definition_not_allowed`, so a schedule made or changed outside Nocheh, an
   imported one included, stays inert until it is set again by asking.
4. **A press is granted first.** The owner's Pause, Resume, Delete and Run now on the
   Schedules page, a member's in the members' app and a press on Nocheh's message each
   get a grant bound to the press's request id before Nocheh asks the agent. Pause and
   Resume may change only whether the schedule is on, never what it says. Delete removes
   it whatever Hermes holds, and a deleted schedule never comes back by a press. Hermes refuses the
   change it made when Nocheh does not accept it (`cron_change_refused`).
5. **Fires need a grant and the right time.** Around its own advance Nocheh issues a
   90-second clock grant for that cursor and epoch, used once. It is dropped when the
   advance answers, and otherwise outlives the advance call's timeout, so a slow but
   valid capture still lands. A fire's identity does not include its reason, so a later
   retry of the same slot as missed is never an identity conflict. A timed fire must land when the
   definition says: not early, a scheduled one at most ten minutes late, after the last
   clock fire, on a minute an exact 5-field cron names in the schedule's own time zone
   (UTC when it names none), an interval's spacing apart, a once schedule once per
   execution version, and within `repeat`. Run now needs its press's grant and never
   counts as a clock fire. Catch-up is refused (`schedule_catch_up_off`).
6. **Hermes's own schedule surfaces are read-only.** The native cron page answers any
   write with 403 `cron_read_only`, and `nocheh cron` keeps list, show and runs; its
   write actions say they are gone. New group schedules and catch-up are off for now.
7. **Nocheh delivers and owns the epoch.** Hermes no longer calls `ownership` or
   `delivery`; Nocheh already delivers a scheduled result after its run, and now also
   offers the owner's card for a result that waits for the owner, such as a group
   schedule's.

## Consequences

- A schedule registered before this change keeps firing with no action from the owner:
  its checkpoints pass, a version from before grants takes its body from its definition
  record for a press, and its runs with no `fired_by` are not counted against timing.
- Croniter forms beyond the matcher (6 or 7 fields, `L`, `W`, `#`, aliases,
  wrap-around ranges, and a field's last value with a step, such as `23/2` or `sat/2`,
  which croniter reads as the whole field) are refused when set by asking; an older schedule with one has
  its clock fires refused and Hermes skips them. A time in a spring-forward gap does
  not match.
- A change whose answer is lost (a timeout, a dropped connection, a restart) is posted
  again by Hermes's scheduler loop, the very same body, until Nocheh answers: a change
  Nocheh recorded comes back as a duplicate with no grant, and a press's change it did
  not record still takes that press's grant while it lasts. A refused change leaves the
  schedule inert and listed as not saved; a new schedule whose turn post Nocheh refused is
  removed from Hermes's store again, and a refused removal shows again so it can be
  deleted. An inert schedule's waiting workflow ends; the post that sets it again opens
  a new one.
- The turn grant is a window while the turn's pass lives; closing passes at turn end
  comes with the agent login.
