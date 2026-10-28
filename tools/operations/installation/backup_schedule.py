"""Daily automatic backups: when the next one is due, and which old automatic ones to remove.

The dashboard asks `due` every few minutes and starts a due backup through the same path as
Back up now. Only backups this schedule started are ever removed; Back up now copies stay."""
import json
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from tools.operations.installation.admin_operations import identifier
from tools.operations.installation.configuration import load

RECORD = 'admin/backup-schedule.json'
# An unfinished backup younger than this may still be running; older ones failed.
UNFINISHED_GRACE = timedelta(hours=12)
MINIMUM_FREE = 1024 ** 3


def settings(values):
    hour, minute = (int(part) for part in values['NOCHEH_BACKUP_TIME'].split(':'))
    return {'enabled': values['NOCHEH_BACKUP_SCHEDULE'] == 'daily', 'time': values['NOCHEH_BACKUP_TIME'],
            'hour': hour, 'minute': minute, 'time_zone': values['NOCHEH_BACKUP_TIME_ZONE'],
            'keep': int(values['NOCHEH_BACKUP_KEEP'])}


def _now(now):
    return now or datetime.now(timezone.utc)


def _read(state):
    try:
        record = json.loads((Path(state) / RECORD).read_text())
        if isinstance(record.get('automatic'), list) and isinstance(record.get('last_attempt'), str): return record
    except (OSError, ValueError, AttributeError): pass
    return None


def _write(state, record):
    path = Path(state) / RECORD; path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
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


def prune(state, record, keep, now):
    """Keep the newest `keep` finished automatic backups and any that may still be running."""
    root = Path(state) / 'admin/backups'; kept = []; finished = 0; changed = False
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


def due(state, now=None):
    now = _now(now); schedule = settings(load(state)); record = prune(state, _record(state, now), schedule['keep'], now)
    if not schedule['enabled'] or datetime.fromisoformat(record['last_attempt']) >= last_moment(now, schedule):
        return {'due': False}
    # A backup needs room for another copy; filling the disk would stop the database too.
    root = Path(state) / 'admin/backups'; root.mkdir(parents=True, exist_ok=True, mode=0o700)
    finished = [root / entry['id'] for entry in record['automatic'] if _complete(root, entry)]
    needed = max(MINIMUM_FREE, 2 * _size(finished[-1]) if finished else 0)
    if shutil.disk_usage(root).free < needed:
        if record.get('skipped') != 'low_disk':
            record['skipped'] = 'low_disk'; record['skipped_at'] = now.isoformat(); _write(state, record)
        return {'due': False, 'skipped': 'low_disk'}
    return {'due': True}


def started(state, job, now=None):
    """Records a scheduled backup before it starts, so a failed one is not retried in a loop."""
    identifier(job); now = _now(now); record = _record(state, now)
    record['last_attempt'] = now.isoformat(); record.pop('skipped', None); record.pop('skipped_at', None)
    record['automatic'].append({'id': job, 'at': now.isoformat()}); _write(state, record)
    return {'recorded': True}


def status(state, now=None):
    """What System › Backups shows about the schedule."""
    now = _now(now); schedule = settings(load(state)); record = _read(state) or {'automatic': []}
    upcoming = last_moment(now, schedule) + timedelta(days=1)
    if record.get('last_attempt') and datetime.fromisoformat(record['last_attempt']) < last_moment(now, schedule):
        upcoming = now
    return {'enabled': schedule['enabled'], 'time': schedule['time'], 'time_zone': schedule['time_zone'],
            'keep': schedule['keep'], 'next_at': upcoming.astimezone(timezone.utc).isoformat() if schedule['enabled'] else None,
            'skipped': record.get('skipped'), 'skipped_at': record.get('skipped_at'),
            'automatic': [entry['id'] for entry in record['automatic']]}
