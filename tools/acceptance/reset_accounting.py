"""Erase monitor content while preserving accounting, with its native writer lock.

Only the reset coordinator may call this after stopping installation writers.
No backup is made. The separate Honcho spending ledger is never opened here.
"""
import fcntl
import hashlib
import json
import math
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

# Pinned CPAMP 1ae656c82990c480f3f104326a08c6e0001eeb4c, initialized empty.
# An unknown migration must be reviewed before content can be erased safely.
SCHEMA = 'ba6df07f1ea7f4bfdb9fbd451218a4376c7fd629a9223eb49c0ebd78520fb9f6'
ERASE = ('account_action_candidates', 'codex_inspection_leases', 'codex_inspection_logs',
         'codex_inspection_results', 'codex_inspection_runs', 'dead_letter_events')
SCRUB = {
    'usage_events': ('endpoint', 'path', 'client_ip', 'x_forwarded_for', 'user_agent',
                     'fail_summary', 'response_metadata_json', 'header_error_kind',
                     'header_error_code', 'header_trace_id', 'fail_body'),
    'usage_monitoring_event_projection_v1': ('search_text', 'header_error_kind', 'header_error_code', 'header_trace_id'),
    'usage_monitoring_header_latest_v1': ('response_metadata_json', 'header_error_kind', 'header_error_code', 'header_trace_id'),
    'quota_cooldowns': ('evidence_json', 'last_error'),
    'usage_data_migrations': ('last_error',),
    'usage_derived_cleanup_jobs': ('last_error',),
    'usage_hourly_aggregate_state': ('last_error',),
    'usage_pricing_rollup_state': ('last_error',),
    'usage_rollup_checkpoints': ('last_error',),
    'usage_monitoring_rollup_state': ('last_error',),
}
FTS = 'usage_monitoring_event_search_v1'


def _quoted(name):
    return '"' + name.replace('"', '""') + '"'


def schema(db):
    rows = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name').fetchall()
    signature = hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()
    if signature != SCHEMA:
        raise ValueError('accounting_schema_requires_review')
    return [row[1] for row in rows if row[0] == 'table' and not row[1].startswith(FTS)]


def _positive(value):
    # Match the pinned Go JSON reader, including numeric strings and fractional
    # JSON numbers. These hints affect later cache-accounting migrations.
    if isinstance(value, str):
        try:
            stripped = value.strip()
            if not stripped or not stripped.lstrip('+-').isdigit():
                return None
            number = int(stripped)
        except ValueError:
            return None
        return number if 0 < number < 2**63 else None
    if type(value) is float and math.isfinite(value) and 0 < value < 2**63:
        return int(value)
    return None


def accounting_hints(raw, depth=0):
    """Retain only the pinned reader's cache mode, explicit total and validity."""
    if depth > 1 or not isinstance(raw, str) or not raw.strip():
        return None
    if len(raw.encode()) > 8 * 1024 * 1024:
        raise ValueError('accounting_payload_too_large')
    try:
        value = json.loads(raw, parse_int=float, parse_float=float,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict):
        return None
    if isinstance(value.get('detail'), dict):
        value = value['detail']
    result = {}
    parents = [value.get('tokens'), value.get('usage'), value]
    for parent in parents:
        if not isinstance(parent, dict):
            continue
        mode = next((parent[k] for k in ('cache_input_mode', 'cacheInputMode') if k in parent), '')
        mode = mode.strip().lower() if isinstance(mode, str) else ''
        if mode in ('included_in_input', 'separate_from_input') and 'cache_input_mode' not in result:
            result['cache_input_mode'] = mode
        # Upstream first() selects the first present value; invalid first values
        # do not allow a later alias in the same parent to override them.
        total = _positive(next((parent[k] for k in ('total_tokens', 'totalTokens', 'total') if k in parent), None))
        if total is not None and 'total_tokens' not in result:
            result['total_tokens'] = total
    nested_raw = next((value[k] for k in ('raw_json', 'rawJson') if k in value), '')
    nested = accounting_hints(nested_raw, depth + 1)
    if nested is not None:
        for key, item in nested.items():
            result.setdefault(key, item)
    return result


def fingerprint(db, tables):
    """Exact digest of retained rows/fields and the original accounting hints."""
    result = {}
    for table in tables:
        if table in ERASE:
            continue
        excluded = set(SCRUB.get(table, ()))
        if table == 'usage_events':
            excluded.add('raw_json')
        columns = [row[1] for row in db.execute('PRAGMA table_info(' + _quoted(table) + ')') if row[1] not in excluded]
        select = ','.join(map(_quoted, columns))
        digest = hashlib.sha256()
        for row in db.execute('SELECT ' + select + ' FROM ' + _quoted(table) + ' ORDER BY ' + select):
            digest.update(json.dumps(row, separators=(',', ':'), allow_nan=False).encode() + b'\n')
        result[table] = digest.hexdigest()
    digest = hashlib.sha256()
    for identifier, raw in db.execute('SELECT id,raw_json FROM usage_events ORDER BY id'):
        digest.update(json.dumps([identifier, accounting_hints(raw)], separators=(',', ':')).encode() + b'\n')
    result['accounting_hints'] = digest.hexdigest()
    return result


@contextmanager
def locked_database(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_nlink != 1:
        raise ValueError('accounting_path_denied')
    # CPAMP's processlock package uses this exact advisory lock filename.
    descriptor = os.open(str(path) + '.manager.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('accounting_writer_still_running') from None
        for suffix in ('-wal', '-shm', '-journal'):
            if Path(str(path) + suffix).is_symlink():
                raise ValueError('accounting_path_denied')
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=rw', uri=True, timeout=0, isolation_level=None)
        try:
            yield db
        finally:
            db.close()
    finally:
        os.close(descriptor)


def scrub(db, tables):
    removed = {table: db.execute('SELECT count(*) FROM ' + _quoted(table)).fetchone()[0] for table in ERASE}
    for table in ERASE:
        db.execute('DELETE FROM ' + _quoted(table))
    for table, columns in SCRUB.items():
        specs = {row[1]: row for row in db.execute('PRAGMA table_info(' + _quoted(table) + ')')}
        for column in columns:
            value = '{}' if column.endswith('_json') else '' if specs[column][3] else None
            db.execute('UPDATE ' + _quoted(table) + ' SET ' + _quoted(column) + '=?', (value,))
    # Paginate by primary key: raw payloads never accumulate in memory or logs.
    after = None
    while rows := db.execute('SELECT id FROM usage_events WHERE (? IS NULL OR id>?) ORDER BY id LIMIT 128', (after, after)).fetchall():
        for identifier, in rows:
            raw = db.execute('SELECT raw_json FROM usage_events WHERE id=?', (identifier,)).fetchone()[0]
            hints = accounting_hints(raw)
            sanitized = '' if hints is None else json.dumps(hints, separators=(',', ':'))
            db.execute('UPDATE usage_events SET raw_json=? WHERE id=?', (sanitized, identifier))
        after = rows[-1][0]
    db.execute('INSERT INTO ' + FTS + '(' + FTS + ") VALUES('rebuild')")
    return removed


def sanitize(path):
    """Atomic logical cleanup, followed by WAL truncation and free-page removal.

    An interruption during compaction is safe to retry under the reset fence.
    The coordinator must not resume writers until this entire function succeeds.
    """
    with locked_database(path) as db:
        tables = schema(db)
        db.execute('PRAGMA secure_delete=ON')
        db.execute('BEGIN EXCLUSIVE')
        try:
            before = fingerprint(db, tables)
            removed = scrub(db, tables)
            if fingerprint(db, tables) != before:
                raise RuntimeError('accounting_preservation_mismatch')
            db.execute('COMMIT')
        except BaseException:
            db.execute('ROLLBACK')
            raise
        if db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
            raise RuntimeError('accounting_checkpoint_busy')
        db.execute('VACUUM')
        if db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]:
            raise RuntimeError('accounting_checkpoint_busy')
        if fingerprint(db, tables) != before or db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('accounting_verification_failed')
        with Path(path).open('rb') as file:
            os.fsync(file.fileno())
        directory = os.open(Path(path).parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        return {'accounting_preserved': True, 'erased_rows': removed, 'compacted': True, 'backup_created': False}
