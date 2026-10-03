"""Reclaim native admission rows only while the profile file lock is held."""
import os
import sqlite3
from contextlib import closing
from services.hermes.isolated_profile import database_path


def reclaim_isolated_leases(profile):
    # The caller holds .memory.lock for the entire isolated process. Every
    # managed foreground/review child takes that same mounted file lock.
    # A previous child therefore cannot still own these rows, even when its
    # namespace-local PID equals this container's PID. Keep Hermes's normal
    # acquire/refresh/release and transcript fencing active during the new turn.
    if os.environ.get('NOCHEH_ISOLATED_TURN') != '1':
        raise ValueError('isolated_lease_recovery_required')
    path = database_path(profile)
    if path.parent.name != 'native-state':
        raise ValueError('isolated_native_layout_required')
    if not path.exists():
        return
    tables = {
        'session_turn_leases': {'conversation_id', 'holder', 'acquired_at', 'expires_at'},
        'compression_locks': {'session_id', 'holder', 'acquired_at', 'expires_at'},
    }
    # Do not create a replacement database or guess after an upstream schema
    # change. The two admission tables are disposable; messages and compression
    # lineage are not touched. Both deletions commit or neither does.
    with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=rw', uri=True, timeout=5)) as db:
        try:
            db.execute('BEGIN IMMEDIATE')
            present = []
            for table, expected in tables.items():
                columns = {row[1] for row in db.execute('PRAGMA table_info(' + table + ')')}
                if not columns:
                    continue
                if columns != expected:
                    raise ValueError('unsupported_native_lease_schema')
                present.append(table)
            for table in present:
                db.execute('DELETE FROM ' + table)
            db.commit()
        except BaseException:
            db.rollback()
            raise
