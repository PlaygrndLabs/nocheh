"""Finished delivery journals expire after the owner's retention days.

A journal is removed only once its closed result is older than the retention
window. Unfinished journals, and managed receipts still owed to Nocheh, stay.
Within a group the result file goes last, so an interrupted pass never leaves
an intent that looks unanswered; the next pass removes what remains."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

from .async_runs import CLOSED

DAY = 86400
OUTBOUND = {'delivered', 'rejected', 'ambiguous'}


def retention_days():
    value = os.environ.get('NOCHEH_HERMES_JOURNAL_RETENTION_DAYS', '').strip() or '30'
    if not re.fullmatch(r'\d{1,4}', value) or int(value) > 3650:
        raise ValueError('Invalid NOCHEH_HERMES_JOURNAL_RETENTION_DAYS')
    return int(value)


def _closed(result: Path, cutoff: float, states) -> bool:
    try:
        if result.stat().st_mtime >= cutoff:
            return False
        state = json.loads(result.read_bytes()).get('state')
    except (FileNotFoundError, ValueError, AttributeError):
        return False
    return states is None or state in states


def _remove(result: Path, suffixes) -> int:
    for suffix in suffixes:
        result.with_suffix(suffix).unlink(missing_ok=True)
    result.unlink(missing_ok=True)
    return 1


def prune(spool: Path, managed: Path, days: int, now: float | None = None) -> int:
    """Remove finished journals older than `days`; 0 keeps everything."""
    if not days:
        return 0
    cutoff, removed = (now if now is not None else time.time()) - days * DAY, 0
    for result in (spool / 'outbound').glob('*.result'):
        if _closed(result, cutoff, OUTBOUND):
            removed += _remove(result, ('.intent',))
    for result in (spool / 'dispatch').glob('*.result'):
        if _closed(result, cutoff, None):
            removed += _remove(result, ('.intent',))
    for result in (spool / 'async-runs').glob('*.result'):
        if _closed(result, cutoff, CLOSED):
            removed += _remove(result, ('.request', '.events', '.started'))
    for result in managed.glob('*.result'):
        # A receipt that was never published is still owed to Nocheh.
        if result.with_suffix('.receipt').exists() and not result.with_suffix('.published').exists():
            continue
        if _closed(result, cutoff, CLOSED):
            removed += _remove(result, ('.receipt', '.request', '.context', '.stream', '.events', '.started', '.published'))
    return removed


def start(spool: Path, managed: Path, days: int, stop: threading.Event) -> threading.Thread:
    """Prune daily after the boot pass the caller already ran."""
    def loop():
        while not stop.wait(DAY):
            try:
                prune(spool, managed, days)
            except OSError:
                pass
    thread = threading.Thread(target=loop, name='journal-retention', daemon=True)
    thread.start()
    return thread
