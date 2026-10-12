import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from .journal_retention import DAY, prune, retention_days


def write(path: Path, value, age_days=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(value).encode() if not isinstance(value, bytes) else value)
    stamp = time.time() - age_days * DAY
    os.utime(path, (stamp, stamp))


class JournalRetentionTests(unittest.TestCase):
    def test_only_finished_journals_older_than_the_window_are_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            spool, managed = Path(folder) / 'spool', Path(folder) / 'hermes' / 'nocheh-managed-runs'
            out = spool / 'outbound'
            write(out / 'old.intent', {'key': 'synthetic'}, 40); write(out / 'old.result', {'state': 'delivered'}, 40)
            write(out / 'new.intent', {'key': 'synthetic'}, 5); write(out / 'new.result', {'state': 'delivered'}, 5)
            write(out / 'open.intent', {'key': 'synthetic'}, 40)
            write(out / 'orphan.result', {'state': 'rejected'}, 40)
            dispatch = spool / 'dispatch'
            write(dispatch / 'turn.intent', {}, 40); write(dispatch / 'turn.result', {'state': 'done'}, 40)
            write(dispatch / 'running.intent', {}, 40)
            runs = spool / 'async-runs'
            for suffix in ('.request', '.events', '.started'): write(runs / ('done' + suffix), b'{}', 40)
            write(runs / 'done.result', {'state': 'done'}, 40)
            for suffix in ('.request', '.events', '.started'): write(runs / ('live' + suffix), b'{}', 40)
            for suffix in ('.request', '.receipt', '.stream', '.published'): write(managed / ('sent' + suffix), b'{}', 40)
            write(managed / 'sent.result', {'state': 'done'}, 40)
            for suffix in ('.request', '.receipt'): write(managed / ('owed' + suffix), b'{}', 40)
            write(managed / 'owed.result', {'state': 'done'}, 40)

            self.assertEqual(prune(spool, managed, 30), 5)
            left = sorted(str(path.relative_to(folder)) for path in Path(folder).rglob('*') if path.is_file())
            self.assertEqual(left, sorted([
                'spool/outbound/new.intent', 'spool/outbound/new.result', 'spool/outbound/open.intent',
                'spool/dispatch/running.intent',
                'spool/async-runs/live.request', 'spool/async-runs/live.events', 'spool/async-runs/live.started',
                'hermes/nocheh-managed-runs/owed.request', 'hermes/nocheh-managed-runs/owed.receipt',
                'hermes/nocheh-managed-runs/owed.result']), 'unfinished and unpublished journals stay')
            self.assertEqual(prune(spool, managed, 0), 0, '0 keeps everything')

    def test_an_interrupted_pass_never_leaves_an_unanswered_intent(self):
        with tempfile.TemporaryDirectory() as folder:
            spool = Path(folder)
            write(spool / 'outbound' / 'a.intent', {}, 40); write(spool / 'outbound' / 'a.result', {'state': 'ambiguous'}, 40)
            removed = []
            real = Path.unlink
            def unlink(path, missing_ok=False):
                removed.append(path.suffix)
                if path.suffix == '.result': raise OSError('interrupted')
                return real(path, missing_ok=missing_ok)
            with patch.object(Path, 'unlink', unlink), self.assertRaises(OSError):prune(spool, spool / 'managed', 30)
            self.assertEqual(removed, ['.intent', '.result'])
            self.assertFalse((spool / 'outbound' / 'a.intent').exists())
            self.assertEqual(prune(spool, spool / 'managed', 30), 1, 'the next pass removes the leftover result')

    def test_retention_days_default_to_one_month_and_reject_invalid_values(self):
        with patch.dict(os.environ, {'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS': ''}):self.assertEqual(retention_days(), 30)
        with patch.dict(os.environ, {'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS': '0'}):self.assertEqual(retention_days(), 0)
        for bad in ('-1', '3651', 'month', '1.5'):
            with patch.dict(os.environ, {'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS': bad}), self.assertRaises(ValueError, msg=bad):retention_days()


if __name__ == '__main__':
    unittest.main()
