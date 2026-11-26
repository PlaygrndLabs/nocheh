import json
import os
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
        # No Nocheh answers here: the schedule keeps UTC unless a test gives the owner's time zone.
        self.zone = patch('tools.operations.installation.backup_schedule._ask_owner_zone', side_effect=OSError('no nocheh'))
        self.zone.start()

    def tearDown(self):
        self.zone.stop(); self.disk.stop(); self.folder.cleanup()

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

    def test_time_follows_the_owners_time_zone(self):
        self.settings({'NOCHEH_BACKUP_TIME': '05:30'})
        with patch('tools.operations.installation.backup_schedule._ask_owner_zone', return_value='Asia/Kolkata'):
            backup_schedule.due(self.state, at('2026-10-28T12:00:00'))
            # 05:30 in Kolkata (UTC+05:30) is midnight UTC.
            self.assertFalse(backup_schedule.due(self.state, at('2026-10-28T23:59:00'))['due'])
            self.assertTrue(backup_schedule.due(self.state, at('2026-10-29T00:00:00'))['due'])
            status = backup_schedule.status(self.state, at('2026-10-28T12:00:00'))
        self.assertEqual((status['time_zone'], status['next_at']), ('Asia/Kolkata', '2026-10-29T00:00:00+00:00'))

    def test_keeps_the_last_owner_time_zone_while_nocheh_cannot_answer(self):
        self.settings({'NOCHEH_BACKUP_TIME': '05:30'})
        with patch('tools.operations.installation.backup_schedule._ask_owner_zone', return_value='Asia/Kolkata'):
            backup_schedule.due(self.state, at('2026-10-28T12:00:00'))
        # A restart at the set time: the zone read before still holds, so the backup neither moves nor runs early.
        with patch('tools.operations.installation.backup_schedule._ask_owner_zone', side_effect=OSError('refused')):
            self.assertFalse(backup_schedule.due(self.state, at('2026-10-28T23:59:00'))['due'])
            self.assertTrue(backup_schedule.due(self.state, at('2026-10-29T00:00:00'))['due'])
        # An answer that is no time zone counts as no answer.
        with patch('tools.operations.installation.backup_schedule._ask_owner_zone', return_value='Mars/Base'):
            self.assertEqual(backup_schedule.status(self.state, at('2026-10-29T00:00:00'))['time_zone'], 'Asia/Kolkata')

    def test_utc_until_nocheh_has_answered_once(self):
        with patch('tools.operations.installation.backup_schedule._ask_owner_zone', side_effect=OSError('refused')):
            self.assertEqual(backup_schedule.status(self.state, at('2026-10-28T12:00:00'))['time_zone'], 'UTC')

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
        validate_backups({'NOCHEH_BACKUP_SCHEDULE': 'daily', 'NOCHEH_BACKUP_TIME': '23:59', 'NOCHEH_BACKUP_KEEP': '365'})
        for bad in ({'NOCHEH_BACKUP_SCHEDULE': 'hourly'}, {'NOCHEH_BACKUP_TIME': '24:00'}, {'NOCHEH_BACKUP_TIME': '4:00'},
                    {'NOCHEH_BACKUP_KEEP': '0'}, {'NOCHEH_BACKUP_KEEP': '400'}):
            with self.assertRaises(ValueError): validate_backups(bad)

    def test_rejects_unsafe_job_ids(self):
        with self.assertRaises(ValueError): backup_schedule.started(self.state, '../elsewhere')



    def test_unfinished_backup_folders_are_swept_once_no_backup_can_still_write_them(self):
        now = at('2026-10-28T12:00:00'); root = self.state / 'admin/backups'; root.mkdir(parents=True)
        old, young = root / '.backup-old', root / '.backup-young'
        for stage, age in ((old, timedelta(hours=13)), (young, timedelta(hours=1))):
            (stage / 'archive.dump').parent.mkdir(); (stage / 'archive.dump').write_bytes(b'partial')
            moment = (now - age).timestamp(); os.utime(stage, (moment, moment))
        elsewhere = Path(self.folder.name) / 'elsewhere'; elsewhere.mkdir(); (elsewhere / 'kept').write_text('kept')
        (root / '.backup-linked').symlink_to(elsewhere)
        os.utime(root / '.backup-linked', (0, 0), follow_symlinks=False)
        backup_schedule.due(self.state, now)
        self.assertFalse(old.exists()); self.assertTrue(young.is_dir())
        self.assertTrue((root / '.backup-linked').is_symlink()); self.assertTrue((elsewhere / 'kept').is_file())

    def test_backups_that_did_not_finish_are_counted_until_one_does(self):
        values = {'NOCHEH_BACKUP_SCHEDULE': 'daily', 'NOCHEH_BACKUP_TIME': '04:00', 'NOCHEH_BACKUP_KEEP': '7'}
        start = at('2026-10-28T04:00:00')
        self.assertEqual(backup_schedule.health(self.state, values, start)['failed'], 0)
        backup_schedule.record_backup(self.state, 'running', start)
        backup_schedule.record_backup(self.state, 'failed', start, error='backup_unsupported_link', path='hermes/a\u202eb')
        found = backup_schedule.health(self.state, values, start, details=True)
        self.assertEqual((found['failed'], found['reason']), (1, 'backup_unsupported_link'))
        # Direction and invisible characters in a name a command chose reach the page escaped, and never the notice.
        self.assertEqual(found['path'], 'hermes/a\\u202eb')
        self.assertNotIn('path', backup_schedule.health(self.state, values, start))
        self.assertNotIn('a\u202eb', (self.state / backup_schedule.HEALTH).read_text())
        # A backup still running is not a failure; one that never recorded its end is, once the grace period is over.
        backup_schedule.record_backup(self.state, 'running', start + timedelta(days=1))
        self.assertEqual(backup_schedule.health(self.state, values, start + timedelta(days=1, hours=1))['failed'], 1)
        stale = backup_schedule.health(self.state, values, start + timedelta(days=1, hours=13))
        self.assertEqual((stale['failed'], stale['reason']), (2, 'backup_interrupted'))
        backup_schedule.record_backup(self.state, 'running', start + timedelta(days=2))
        backup_schedule.record_backup(self.state, 'failed', start + timedelta(days=2), error='backup_disk_full')
        self.assertEqual(backup_schedule.health(self.state, values, start + timedelta(days=2))['failed'], 3)
        backup_schedule.record_backup(self.state, 'running', start + timedelta(days=3))
        backup_schedule.record_backup(self.state, 'complete', start + timedelta(days=3), unreadable=['hermes/profiles/x/workspace/y'])
        done = backup_schedule.health(self.state, values, start + timedelta(days=3))
        self.assertEqual((done['failed'], done['reason'], done['unreadable']), (0, None, 1))

    def test_what_the_newest_complete_backup_left_out_stays_told_while_later_ones_fail_or_run(self):
        values = {'NOCHEH_BACKUP_SCHEDULE': 'daily', 'NOCHEH_BACKUP_TIME': '04:00', 'NOCHEH_BACKUP_KEEP': '7'}
        start = at('2026-11-01T04:00:00'); left_out = ['hermes/profiles/x/workspace/a', 'hermes/profiles/x/workspace/b']
        backup_schedule.record_backup(self.state, 'running', start)
        backup_schedule.record_backup(self.state, 'complete', start, unreadable=left_out)
        backup_schedule.record_backup(self.state, 'running', start + timedelta(days=1))
        running = backup_schedule.health(self.state, values, start + timedelta(days=1), details=True)
        self.assertEqual((running['unreadable'], running['unreadable_paths']), (2, left_out))
        backup_schedule.record_backup(self.state, 'failed', start + timedelta(days=1), error='backup_disk_full')
        # The newest backup there is still lacks them, so the notice line stays open instead of being marked fixed.
        failed = backup_schedule.health(self.state, values, start + timedelta(days=1), details=True)
        self.assertEqual((failed['failed'], failed['unreadable'], failed['unreadable_paths']), (1, 2, left_out))
        self.assertEqual(backup_schedule.health(self.state, values, start + timedelta(days=2))['unreadable'], 2,
                         'a backup left running by a restart changes nothing either')
        backup_schedule.record_backup(self.state, 'running', start + timedelta(days=2))
        backup_schedule.record_backup(self.state, 'complete', start + timedelta(days=2))
        done = backup_schedule.health(self.state, values, start + timedelta(days=2), details=True)
        self.assertEqual((done['failed'], done['unreadable'], done['unreadable_paths']), (0, 0, []))

    def test_low_disk_skips_count_each_day_and_status_warns_without_a_backups_folder(self):
        values = {'NOCHEH_BACKUP_SCHEDULE': 'daily', 'NOCHEH_BACKUP_TIME': '04:00', 'NOCHEH_BACKUP_KEEP': '7'}
        self.disk.stop()
        try:
            status = backup_schedule.status(self.state, at('2026-10-27T12:00:00'))
            self.assertIn(status['low_disk'], (True, False))
            self.assertFalse((self.state / 'admin/backups').exists(), 'looking never makes the folder')
        finally: self.disk.start()
        backup_schedule.due(self.state, at('2026-10-27T12:00:00'))
        low = Usage(0, 0, 100 * 1024 ** 2)
        with patch('tools.operations.installation.backup_schedule.shutil.disk_usage', return_value=low):
            for moment in ('2026-10-28T05:00:00', '2026-10-28T09:00:00', '2026-10-29T05:00:00'):
                backup_schedule.due(self.state, at(moment))
            self.assertEqual(backup_schedule.health(self.state, values, at('2026-10-29T05:00:00'))['skipped_days'], 2)
            self.assertTrue(backup_schedule.status(self.state, at('2026-10-29T05:00:00'))['low_disk'])
        self.assertEqual(backup_schedule.health(self.state, {**values, 'NOCHEH_BACKUP_SCHEDULE': 'off'})['skipped_days'], 0)
        backup_schedule.started(self.state, JOBS[0], at('2026-10-29T06:00:00'))
        self.assertEqual(backup_schedule.health(self.state, values, at('2026-10-29T06:00:00'))['skipped_days'], 0)
        self.assertFalse(backup_schedule.status(self.state, at('2026-10-29T06:00:00'))['low_disk'])


if __name__ == '__main__':
    unittest.main()
