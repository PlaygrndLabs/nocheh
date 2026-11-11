import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from .retention import DAY, prune, retention_days


def write(path: Path, value, age_days=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(value).encode())
    stamp = time.time() - age_days * DAY
    os.utime(path, (stamp, stamp))


class RetentionTests(unittest.TestCase):
    def test_only_finished_journals_older_than_the_window_are_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            spool = Path(folder)
            out, dispatch = spool / 'outbound', spool / 'dispatch'
            write(out / 'old.intent', {'key': 'synthetic'}, 40); write(out / 'old.result', {'state': 'delivered'}, 40)
            write(out / 'new.intent', {'key': 'synthetic'}, 5); write(out / 'new.result', {'state': 'delivered'}, 5)
            write(out / 'open.intent', {'key': 'synthetic'}, 40)
            write(out / 'orphan.result', {'state': 'rejected'}, 40)
            write(dispatch / 'reply-a.intent', {}, 40); write(dispatch / 'reply-a.result', {'state': 'done'}, 40)
            write(dispatch / 'reply-b.intent', {}, 40)
            # The brain's own journals in the shared spool are not this service's to remove.
            write(spool / 'async-runs/done.result', {'state': 'done'}, 40)
            self.assertEqual(prune(spool, 30), 3)
            left = sorted(str(path.relative_to(folder)) for path in spool.rglob('*') if path.is_file())
            self.assertEqual(left, ['async-runs/done.result', 'dispatch/reply-b.intent', 'outbound/new.intent', 'outbound/new.result', 'outbound/open.intent'])
            self.assertEqual(prune(spool, 0), 0, '0 keeps everything')

    def test_retention_days_default_to_keeping_everything_and_reject_invalid_values(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(retention_days(), 0)
        with patch.dict(os.environ, {'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS': '30'}):
            self.assertEqual(retention_days(), 30)
        for value in ('-1', '3651', 'x'):
            with patch.dict(os.environ, {'NOCHEH_HERMES_JOURNAL_RETENTION_DAYS': value}), self.assertRaises(ValueError):
                retention_days()


if __name__ == '__main__':
    unittest.main()
