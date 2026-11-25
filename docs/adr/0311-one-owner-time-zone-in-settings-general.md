# ADR-0311: One owner time zone, in Settings › General

<status>
Accepted on 2026-11-25. The owner said the time zone is not for schedules only, it is for all
parts, so it belongs in a better place. The owner chose that daily backups follow it too.
Amends [ADR-0282](0282-owners-time-zone-where-schedules-are.md) decision 2 and
[ADR-0187](0187-daily-automatic-backups.md) on the backup time zone.
</status>

## Context

- The owner's time zone was set in two places: Settings › Tasks and the Schedules page (also the
  mini app's Schedules tab). Daily backups had a third picker of their own,
  `NOCHEH_BACKUP_TIME_ZONE`, under Privacy & data.
- Nocheh already read one stored value, the task settings' `time_zone`, for task dates and
  reminders, new owner schedules, quiet hours, each chat's daily session, and times in the
  owner's source tags. Only the backup schedule read its own.

## Decision

1. **Settings › General.** A new first Settings section holds "Your time zone": every zone the
   device knows and "Use this device's". It saves from the save bar through
   `POST /tasks/time-zone`, which still stores the task settings' `time_zone`. The owner can
   still set it by asking in their private chat (`my_time_zone`).
2. **No other picker.** Settings › Tasks has no time zone; its sub-tab is "Priorities". The
   Schedules page shows the zone read only, with a link to Settings › General. The mini app shows
   the line without the link and may no longer `POST /tasks/time-zone`.
3. **The time zone save keeps the task settings' revision.** An edit open in Settings › Tasks
   still saves after the time zone changes, and a Tasks save keeps the time zone.
4. **Backups follow it.** `NOCHEH_BACKUP_TIME_ZONE` is retired and dropped when the `.env` is
   read. The backup schedule asks `GET /internal/owner-time-zone` (service token) at each check
   and on System › Backups. It records the last zone read in its own record and uses it while
   Nocheh cannot answer, else UTC, so a restart never moves a backup.
5. **Members keep their own** time zone for their private chat
   ([ADR-0281](0281-members-own-time-zone.md)). Schedules already set keep the zone they were
   set in.

## Consequences

- An installation whose backups ran at 04:00 UTC now runs them at 04:00 in the owner's time zone.
- Changing the time zone can move one day's backup earlier or later; the schedule still makes at
  most one attempt for each set time.
- Not changed: the dashboard shows times in the device's time zone; monthly spending and usage
  days count in UTC.
