import json
import tempfile
import unittest
from collections import namedtuple
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from tools.operations.installation import backup_schedule
from tools.operations.installation.configuration import validate_backups

Usage = namedtuple('Usage', 'total used free')
JOBS = ['%08d-1111-4111-8111-111111111111' % number for number in range(1, 13)]


def at(text):
    return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)


class BackupScheduleTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.state = Path(self.folder.name)
        self.settings({})
        self.disk = patch('tools.operations.installation.backup_schedule.shutil.disk_usage', return_value=Usage(0, 0, 50 * 1024 ** 3))
        self.disk.start()

    def tearDown(self):
        self.disk.stop(); self.folder.cleanup()

    def settings(self, values):
        lines = {'NOCHEH_CONFIG_VERSION': '1', **values}
        (self.state / '.env').write_text(''.join(f'{key}={value}\n' for key, value in lines.items()))

    def backup(self, job, finished=True):
        path = self.state / 'admin/backups' / job; path.mkdir(parents=True)
        if finished: (path / 'manifest.json').write_text(json.dumps({'created_at': 'x', 'files': {}}))
        return path

    def test_new_installation_waits_for_the_set_time_instead_of_pausing_now(self):
        self.assertFalse(backup_schedule.due(self.state, at('2026-10-28T15:00:00'))['due'])
        self.assertFalse(backup_schedule.due(self.state, at('2026-10-29T03:59:00'))['due'])
        self.assertTrue(backup_schedule.due(self.state, at('2026-10-29T04:00:00'))['due'])

    def test_one_attempt_a_day_and_a_missed_time_runs_when_the_machine_is_back(self):
        backup_schedule.due(self.state, at('2026-10-27T12:00:00'))
        backup_schedule.started(self.state, JOBS[0], at('2026-10-28T04:00:00'))
        # A failed or finished attempt is not retried the same day.
        self.assertFalse(backup_schedule.due(self.state, at('2026-10-28T23:00:00'))['due'])
        # Asleep at 04:00 on the 29th: due as soon as it is checked again.
        self.assertTrue(backup_schedule.due(self.state, at('2026-10-29T09:30:00'))['due'])

    def test_time_follows_the_chosen_time_zone(self):
        self.settings({'NOCHEH_BACKUP_TIME': '05:30', 'NOCHEH_BACKUP_TIME_ZONE': 'Asia/Kolkata'})
        backup_schedule.due(self.state, at('2026-10-28T12:00:00'))
        # 05:30 in Kolkata (UTC+05:30) is midnight UTC.
        self.assertFalse(backup_schedule.due(self.state, at('2026-10-28T23:59:00'))['due'])
        self.assertTrue(backup_schedule.due(self.state, at('2026-10-29T00:00:00'))['due'])

    def test_off_never_runs(self):
        self.settings({'NOCHEH_BACKUP_SCHEDULE': 'off'})
        backup_schedule.due(self.state, at('2026-10-27T12:00:00'))
        self.assertFalse(backup_schedule.due(self.state, at('2026-10-30T12:00:00'))['due'])
        self.assertIsNone(backup_schedule.status(self.state, at('2026-10-30T12:00:00'))['next_at'])

    def test_keeps_newest_finished_automatic_backups_and_never_touches_manual_ones(self):
        self.settings({'NOCHEH_BACKUP_KEEP': '2'})
        manual = self.backup(JOBS[11])
        start = at('2026-10-20T04:00:00')
        for day in range(4):
            backup_schedule.started(self.state, JOBS[day], start + timedelta(days=day)); self.backup(JOBS[day])
        # Failed long ago (no manifest) and one possibly still running.
        backup_schedule.started(self.state, JOBS[4], start + timedelta(days=4)); self.backup(JOBS[4], finished=False)
        now = start + timedelta(days=5, hours=1)
        backup_schedule.started(self.state, JOBS[5], now - timedelta(minutes=5)); running = self.backup(JOBS[5], finished=False)
        backup_schedule.due(self.state, now)
        left = sorted(path.name for path in (self.state / 'admin/backups').iterdir())
        self.assertEqual(left, sorted([JOBS[2], JOBS[3], JOBS[5], JOBS[11]]))
        self.assertTrue(manual.is_dir()); self.assertTrue(running.is_dir())
        self.assertEqual(backup_schedule.status(self.state, now)['automatic'], [JOBS[2], JOBS[3], JOBS[5]])

    def test_low_disk_skips_instead_of_filling_the_disk(self):
        backup_schedule.due(self.state, at('2026-10-27T12:00:00'))
        with patch('tools.operations.installation.backup_schedule.shutil.disk_usage', return_value=Usage(0, 0, 100 * 1024 ** 2)):
            self.assertEqual(backup_schedule.due(self.state, at('2026-10-28T05:00:00')), {'due': False, 'skipped': 'low_disk'})
        self.assertEqual(backup_schedule.status(self.state, at('2026-10-28T05:00:00'))['skipped'], 'low_disk')
        self.assertTrue(backup_schedule.due(self.state, at('2026-10-28T05:05:00'))['due'])

    def test_settings_are_validated(self):
        validate_backups({'NOCHEH_BACKUP_SCHEDULE': 'daily', 'NOCHEH_BACKUP_TIME': '23:59', 'NOCHEH_BACKUP_TIME_ZONE': 'America/New_York',
                          'NOCHEH_BACKUP_KEEP': '365'})
        for bad in ({'NOCHEH_BACKUP_SCHEDULE': 'hourly'}, {'NOCHEH_BACKUP_TIME': '24:00'}, {'NOCHEH_BACKUP_TIME': '4:00'},
                    {'NOCHEH_BACKUP_TIME_ZONE': 'Mars/Base'}, {'NOCHEH_BACKUP_TIME_ZONE': '../etc'},
                    {'NOCHEH_BACKUP_KEEP': '0'}, {'NOCHEH_BACKUP_KEEP': '400'}):
            with self.assertRaises(ValueError): validate_backups(bad)

    def test_rejects_unsafe_job_ids(self):
        with self.assertRaises(ValueError): backup_schedule.started(self.state, '../elsewhere')


if __name__ == '__main__':
    unittest.main()
