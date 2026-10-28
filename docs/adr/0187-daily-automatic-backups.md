# ADR-0187: Daily automatic backups

<status>
Accepted on 2026-10-28, when the owner chose to move Nocheh to an always-on
server once the MVP checks pass, with backups built first. Extends
[ADR-0144](0144-keep-history-by-default.md).
</status>

<context>
- A backup ran only when the owner pressed Back up now or typed
  `./bin/nocheh backup`. Development mode allowed data loss; leaving it
  means a lost disk or a bad change must not lose the owner's archive and
  memory.
- A backup briefly stops ingress and writers, so it can't run at any moment,
  and each copy is a full snapshot (about 1.5 GB on the development machine), so
  copies can't pile up forever.
- The dashboard already runs backups safely: it drains its own requests,
  closes live sockets and hands the paused stores to the backup.
</context>

<decision>
- Four `.env` settings, edited in Settings › Privacy & data:
  `NOCHEH_BACKUP_SCHEDULE` (`daily`, the default, or `off`),
  `NOCHEH_BACKUP_TIME` (`HH:MM`, default `04:00`), `NOCHEH_BACKUP_TIME_ZONE`
  (an IANA name, default `UTC`) and `NOCHEH_BACKUP_KEEP` (1–365, default 7).
  They are read from the saved file at each check, so they take effect
  without Apply.
- The dashboard checks every five minutes. A backup is due when the latest
  scheduled time has passed since the last attempt. It starts through the same
  path as Back up now, and only when no other operation, import or
  maintenance is running. A machine that was asleep at the set time backs up
  at the next check.
- Each start is recorded in `admin/backup-schedule.json` before the backup
  begins, so a failed attempt waits for the next day instead of looping. A
  new installation starts counting from its first check, so turning the
  schedule on never pauses the assistant at once.
- Only backups the schedule started are removed: the newest `KEEP` finished
  ones stay, and an unfinished one stays for 12 hours in case it is still
  running. Backups started by hand are never removed.
- A due backup is skipped while free space is below twice the newest
  automatic backup (at least 1 GiB), so it can't fill the disk the database
  runs on. System › Backups shows the schedule, the next time and a skip.
- Copies stay on the same machine. Protection against losing the machine
  itself comes from the host (for example the server provider's own backups)
  or from copying a backup elsewhere; that is not automated here.
</decision>

<consequences>
- Installations that never set these keys back up daily at 04:00 UTC and
  keep seven automatic copies.
- Saving new messages pauses for the length of one backup each day.
- Checks: `services/hermes/test_backup_schedule.py`.
</consequences>
