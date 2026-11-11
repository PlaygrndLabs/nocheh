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
            turns = spool / 'brain-turns'
            for suffix in ('.request', '.events', '.started', '.outcome'): write(turns / ('old' + suffix), b'{}', 40)
            write(turns / 'old.result', {'state': 'done'}, 40)
            for suffix in ('.request', '.events', '.started'): write(turns / ('new' + suffix), b'{}', 5)
            write(turns / 'new.result', {'state': 'done'}, 5)
            for suffix in ('.request', '.events', '.started'): write(turns / ('live' + suffix), b'{}', 40)
            for suffix in ('.request', '.receipt', '.stream', '.published'): write(managed / ('sent' + suffix), b'{}', 40)
            write(managed / 'sent.result', {'state': 'done'}, 40)
            for suffix in ('.request', '.receipt'): write(managed / ('owed' + suffix), b'{}', 40)
            write(managed / 'owed.result', {'state': 'done'}, 40)
            # The Telegram service's send journals share the spool; it prunes them itself.
            out, sends = spool / 'outbound', spool / 'dispatch'
            write(out / 'sent.intent', {'key': 'synthetic'}, 40); write(out / 'sent.result', {'state': 'delivered'}, 40)
            write(sends / 'reply.intent', {}, 40); write(sends / 'reply.result', {'state': 'done'}, 40)

            self.assertEqual(prune(spool, managed, 30), 2)
            left = sorted(str(path.relative_to(folder)) for path in Path(folder).rglob('*') if path.is_file())
            self.assertEqual(left, sorted([
                'spool/brain-turns/new.request', 'spool/brain-turns/new.events', 'spool/brain-turns/new.started', 'spool/brain-turns/new.result',
                'spool/brain-turns/live.request', 'spool/brain-turns/live.events', 'spool/brain-turns/live.started',
                'spool/outbound/sent.intent', 'spool/outbound/sent.result', 'spool/dispatch/reply.intent', 'spool/dispatch/reply.result',
                'hermes/nocheh-managed-runs/owed.request', 'hermes/nocheh-managed-runs/owed.receipt',
                'hermes/nocheh-managed-runs/owed.result']), 'unfinished, unpublished and Telegram journals stay')
            self.assertEqual(prune(spool, managed, 0), 0, '0 keeps everything')

    def test_an_interrupted_pass_never_leaves_an_unanswered_run(self):
        with tempfile.TemporaryDirectory() as folder:
            spool = Path(folder)
            write(spool / 'brain-turns' / 'a.request', {}, 40); write(spool / 'brain-turns' / 'a.result', {'state': 'ambiguous'}, 40)
            removed = []
            real = Path.unlink
            def unlink(path, missing_ok=False):
                removed.append(path.suffix)
                if path.suffix == '.result': raise OSError('interrupted')
                return real(path, missing_ok=missing_ok)
            with patch.object(Path, 'unlink', unlink), self.assertRaises(OSError):prune(spool, spool / 'managed', 30)
            self.assertEqual(removed, ['.request', '.events', '.started', '.outcome', '.result'])
            self.assertFalse((spool / 'brain-turns' / 'a.request').exists())
            self.assertEqual(prune(spool, spool / 'managed', 30), 1, 'the next pass removes the leftover result')

    def test_retention_days_default_to_keeping_everything_and_reject_invalid_values(self):
        with patch.dict(os.environ, {'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS': ''}):self.assertEqual(retention_days(), 0)
        with patch.dict(os.environ, {'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS': '30'}):self.assertEqual(retention_days(), 30)
        for bad in ('-1', '3651', 'month', '1.5'):
            with patch.dict(os.environ, {'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS': bad}), self.assertRaises(ValueError, msg=bad):retention_days()


if __name__ == '__main__':
    unittest.main()
