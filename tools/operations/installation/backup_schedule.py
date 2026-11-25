"""Daily automatic backups: when the next one is due, and which old automatic ones to remove.

The dashboard asks `due` every few minutes and starts a due backup through the same path as
Back up now. Only backups this schedule started are ever removed; Back up now copies stay.
Folders of backups that never finished are swept once no backup can still be writing them.

Every backup, from the dashboard or the command line, records how it ended in HEALTH; `health`
reads it, with the schedule's and the off-site copy's records, for System › Health and the
owner's Telegram notice (ADR-0251).

The set time is in the owner's time zone (Settings › General), the one every part of Nocheh follows (owner_zone.py)."""
import json
import os
import shutil
import stat
import tempfile
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from tools.operations.installation.admin_operations import identifier
from tools.operations.installation.configuration import load
from tools.operations.installation.owner_zone import owner_zone

RECORD = 'admin/backup-schedule.json'
# Outside the folders a backup copies, so a restored copy never inherits the record of the backup that made it.
HEALTH = 'admin/backup-health.json'
# An unfinished backup younger than this may still be running; older ones failed.
UNFINISHED_GRACE = timedelta(hours=12)
MINIMUM_FREE = 1024 ** 3


def settings(values, zone='UTC'):
    hour, minute = (int(part) for part in values['NOCHEH_BACKUP_TIME'].split(':'))
    return {'enabled': values['NOCHEH_BACKUP_SCHEDULE'] == 'daily', 'time': values['NOCHEH_BACKUP_TIME'],
            'hour': hour, 'minute': minute, 'time_zone': zone,
            'keep': int(values['NOCHEH_BACKUP_KEEP'])}


def _now(now):
    return now or datetime.now(timezone.utc)


def _read(state):
    try:
        record = json.loads((Path(state) / RECORD).read_text())
        if isinstance(record.get('automatic'), list) and isinstance(record.get('last_attempt'), str): return record
    except (OSError, ValueError, AttributeError): pass
    return None


def _write(state, record, name=RECORD):
    path = Path(state) / name; path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as file:
        json.dump(record, file); file.flush(); os.fsync(file.fileno()); temporary = Path(file.name)
    temporary.chmod(0o600); temporary.replace(path)


def _record(state, now):
    """The schedule's own record. A new installation starts counting from now, so turning the
    schedule on never pauses the assistant straight away; the first backup runs at the set time."""
    record = _read(state)
    if record is None:
        record = {'automatic': [], 'last_attempt': now.isoformat()}; _write(state, record)
    return record


def last_moment(now, schedule):
    """The latest scheduled time at or before `now`."""
    local = now.astimezone(ZoneInfo(schedule['time_zone']))
    moment = local.replace(hour=schedule['hour'], minute=schedule['minute'], second=0, microsecond=0)
    return moment if moment <= local else moment - timedelta(days=1)


def _complete(root, entry):
    path = root / entry['id']
    return not path.is_symlink() and (path / 'manifest.json').is_file()


def _size(path):
    return sum(file.stat().st_size for file in path.rglob('*') if file.is_file() and not file.is_symlink())


def _sweep(root, now):
    """Removes the folders of backups that never finished, once no backup can still be writing them.
    A link of that name is left alone."""
    for stage in root.glob('.backup-*'):
        try:
            found = stage.lstat()
            if stat.S_ISDIR(found.st_mode) and now - datetime.fromtimestamp(found.st_mtime, timezone.utc) >= UNFINISHED_GRACE:
                shutil.rmtree(stage, ignore_errors=True)
        except OSError: continue


def prune(state, record, keep, now):
    """Keep the newest `keep` finished automatic backups and any that may still be running."""
    root = Path(state) / 'admin/backups'; kept = []; finished = 0; changed = False
    _sweep(root, now)
    for entry in sorted(record['automatic'], key=lambda entry: entry['at'], reverse=True):
        try: identifier(entry['id'])
        except ValueError: changed = True; continue
        path = root / entry['id']
        if _complete(root, entry):
            finished += 1
            if finished <= keep: kept.append(entry); continue
        elif now - datetime.fromisoformat(entry['at']) < UNFINISHED_GRACE:
            kept.append(entry); continue
        if path.exists() and not path.is_symlink(): shutil.rmtree(path)
        changed = True
    if changed:
        record['automatic'] = sorted(kept, key=lambda entry: entry['at']); _write(state, record)
    return record


def _needed(root, record):
    """A backup needs room for another copy; filling the disk would stop the database too."""
    finished = [root / entry['id'] for entry in record['automatic'] if _complete(root, entry)]
    return max(MINIMUM_FREE, 2 * _size(finished[-1]) if finished else 0)


def _free(state):
    """Free space where backups are written. A new installation has no backups folder until its first backup,
    so the nearest folder that exists is measured instead."""
    root = Path(state) / 'admin/backups'
    return shutil.disk_usage(next((path for path in (root, root.parent) if path.is_dir()), Path(state))).free


def due(state, now=None):
    now = _now(now); schedule = settings(load(state), owner_zone(state)); record = prune(state, _record(state, now), schedule['keep'], now)
    if not schedule['enabled'] or datetime.fromisoformat(record['last_attempt']) >= last_moment(now, schedule):
        return {'due': False}
    root = Path(state) / 'admin/backups'; root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(root).free < _needed(root, record):
        # Counted once for each scheduled time, so each day without a backup is news again.
        moment = last_moment(now, schedule).isoformat()
        if record.get('skipped') != 'low_disk' or record.get('skipped_for') != moment:
            days = record.get('skipped_days') if record.get('skipped') == 'low_disk' else 0
            record.update(skipped='low_disk', skipped_at=now.isoformat(), skipped_for=moment,
                          skipped_days=(days if type(days) is int else 1) + 1)
            _write(state, record)
        return {'due': False, 'skipped': 'low_disk'}
    return {'due': True}


def started(state, job, now=None):
    """Records a scheduled backup before it starts, so a failed one is not retried in a loop."""
    identifier(job); now = _now(now); record = _record(state, now)
    record['last_attempt'] = now.isoformat()
    for key in ('skipped', 'skipped_at', 'skipped_for', 'skipped_days'): record.pop(key, None)
    record['automatic'].append({'id': job, 'at': now.isoformat()}); _write(state, record)
    return {'recorded': True}


def read_health(state):
    try:
        record = json.loads((Path(state) / HEALTH).read_text())
        if isinstance(record, dict): return record
    except (OSError, ValueError): pass
    return {}


def shown(text, limit=300):
    """A file name as System › Backups may show it: backslashes, and control, invisible and direction
    characters, as escapes, so a name can neither hide nor reorder what is around it."""
    def escape(character):
        if character == '\\': return '\\\\'
        if unicodedata.category(character)[0] in 'CZ' and character != ' ':
            code = ord(character)
            return '\\u%04x' % code if code <= 0xFFFF else '\\U%08x' % code
        return character
    text = str(text)
    return ''.join(escape(character) for character in text[:limit]) + ('…' if len(text) > limit else '')


def record_backup(state, outcome, now=None, error=None, path=None, unreadable=()):
    """Called by every backup: 'running' as it begins, then 'complete' or 'failed' with a fixed code. Backups
    that did not finish are counted in a row until one does. The entry a failure names, and the entries left
    out as unreadable, are kept for System › Backups only. Recording never stops a backup."""
    now = _now(now).isoformat(); record = read_health(state)
    failed = record.get('failed_in_row') if type(record.get('failed_in_row')) is int else 0
    if outcome == 'running':
        # One that never ended, such as one stopped by a restart, counts as not finished.
        if record.get('state') == 'running': failed += 1; record.update(error='backup_interrupted', path=None)
        record.update(state='running', started_at=now, failed_in_row=failed)
    elif outcome == 'complete':
        record = {'state': 'complete', 'at': now, 'started_at': record.get('started_at'), 'failed_in_row': 0,
                  'unreadable': len(unreadable), 'unreadable_paths': [shown(item) for item in list(unreadable)[:10]]}
    else:
        record.update(state='failed', at=now, failed_in_row=failed + 1, error=error or 'backup_failed',
                      path=shown(path) if path else None)
    try: _write(state, record, HEALTH)
    except OSError: pass


def health(state, values=None, now=None, details=False):
    """What the owner is told about backups: how many in a row did not finish and why, how many entries a command
    made unreadable in the newest complete one, how many days in a row the automatic one was skipped for low disk,
    and how many off-site copies in a row failed or were skipped. Codes and counts only, never a file name;
    `details` adds the names for System › Backups."""
    now = _now(now); values = load(state) if values is None else values
    record = read_health(state)
    count = lambda value: value if type(value) is int and value > 0 else 0
    failed, reason = count(record.get('failed_in_row')), record.get('error')
    if record.get('state') == 'running':
        # A backup still running after the grace period was stopped without recording why.
        try: stale = now - datetime.fromisoformat(record['started_at']) >= UNFINISHED_GRACE
        except (KeyError, TypeError, ValueError): stale = True
        if stale: failed, reason = failed + 1, 'backup_interrupted'
    # From the newest complete backup, also while a later one runs or after it failed: only a complete one replaces it.
    result = {'failed': failed, 'reason': reason if failed else None, 'unreadable': count(record.get('unreadable')),
              'skipped_days': 0, 'offsite_failed': 0, 'offsite_reason': None, 'offsite_skipped': 0}
    schedule = _read(state) or {}
    if settings(values)['enabled'] and schedule.get('skipped') == 'low_disk':
        result['skipped_days'] = count(schedule.get('skipped_days')) or 1
    from tools.operations.installation import offsite
    if offsite.settings(values)['enabled']:
        remote = offsite.read_record(state)
        result['offsite_failed'] = count(remote.get('failed_in_row'))
        if result['offsite_failed']: result['offsite_reason'] = (remote.get('last') or {}).get('error')
        skipped = remote.get('skipped') if isinstance(remote.get('skipped'), dict) else {}
        result['offsite_skipped'] = count(skipped.get('count'))
    if details:
        result.update(state=record.get('state'), at=record.get('at'),
                      path=record.get('path') if failed and reason == record.get('error') else None,
                      unreadable_paths=(record.get('unreadable_paths') or []) if result['unreadable'] else [])
    return result


def status(state, now=None):
    """What System › Backups shows about the schedule."""
    now = _now(now); schedule = settings(load(state), owner_zone(state)); record = _read(state) or {'automatic': []}
    upcoming = last_moment(now, schedule) + timedelta(days=1)
    if record.get('last_attempt') and datetime.fromisoformat(record['last_attempt']) < last_moment(now, schedule):
        upcoming = now
    # Back up now still runs on a nearly full disk; the page warns first.
    try: low_disk = _free(state) < _needed(Path(state) / 'admin/backups', record)
    except OSError: low_disk = None
    return {'enabled': schedule['enabled'], 'time': schedule['time'], 'time_zone': schedule['time_zone'],
            'keep': schedule['keep'], 'next_at': upcoming.astimezone(timezone.utc).isoformat() if schedule['enabled'] else None,
            'skipped': record.get('skipped'), 'skipped_at': record.get('skipped_at'), 'low_disk': low_disk,
            'automatic': [entry['id'] for entry in record['automatic']]}
