import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from services.hermes.isolated_profile import database_path
from services.hermes.native_memory import memory_lock


class NativeLeaseRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.profile = Path(self.temporary.name)
        (self.profile / 'native-state').mkdir()
        self.environment = patch.dict(os.environ, NOCHEH_ISOLATED_TURN='1')
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def seed(self):
        from hermes_state import SessionDB
        db = SessionDB(database_path(self.profile))
        db.create_session('synthetic-session', source='telegram')
        db.append_message('synthetic-session', 'user', 'Exact preserved history 😃\r\n  wording')
        holder = f'pid={os.getpid()}:turn=previous-container'
        self.assertTrue(db.try_acquire_session_turn_lease('synthetic-session', holder, ttl_seconds=3600))
        self.assertTrue(db.try_acquire_compression_lock('synthetic-session', holder, ttl_seconds=3600))
        return db

    def test_reused_namespace_pid_is_reclaimed_and_history_is_preserved(self):
        db = self.seed()
        try:
            before = db.get_messages_as_conversation('synthetic-session')
            self.assertFalse(db.try_acquire_session_turn_lease('synthetic-session', 'next-turn'))
            with memory_lock(self.profile, reclaim_native=True):
                self.assertTrue(db.try_acquire_session_turn_lease('synthetic-session', 'next-turn'))
                self.assertFalse(db.try_acquire_session_turn_lease('synthetic-session', 'competing-turn'))
                self.assertTrue(db.try_acquire_compression_lock('synthetic-session', 'next-compression'))
                self.assertTrue(db.refresh_session_turn_lease('synthetic-session', 'next-turn'))
                self.assertFalse(db.refresh_session_turn_lease('synthetic-session', 'previous-container'))
                self.assertEqual(db.get_messages_as_conversation('synthetic-session'), before)
                db.release_session_turn_lease('synthetic-session', 'next-turn')
                self.assertTrue(db.try_acquire_session_turn_lease('synthetic-session', 'after-release'))
        finally:
            db.close()

    def test_default_lock_does_not_change_native_admission(self):
        db = self.seed()
        try:
            with memory_lock(self.profile):
                self.assertFalse(db.try_acquire_session_turn_lease('synthetic-session', 'next-turn'))
        finally:
            db.close()

    def test_recovery_waits_for_a_live_profile_owner_then_recovers_after_its_crash(self):
        db = self.seed()
        db.close()
        owner = subprocess.Popen([sys.executable, '-u', '-c',
            'import sys,time; from services.hermes.native_memory import memory_lock\n'
            'with memory_lock(sys.argv[1]):\n print("locked",flush=True); time.sleep(30)', str(self.profile)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        successor = None
        try:
            self.assertEqual(owner.stdout.readline().strip(), 'locked')
            successor = subprocess.Popen([sys.executable, '-u', '-c',
                'import sys; from pathlib import Path; from services.hermes.native_memory import memory_lock\n'
                'with memory_lock(sys.argv[1],reclaim_native=True): Path(sys.argv[1],"recovered").write_text("done")', str(self.profile)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            time.sleep(.3)
            self.assertIsNone(successor.poll())
            self.assertFalse((self.profile / 'recovered').exists())
            with sqlite3.connect(database_path(self.profile)) as check:
                self.assertEqual(check.execute('SELECT count(*) FROM session_turn_leases').fetchone()[0], 1)
            owner.kill(); owner.communicate(timeout=5)
            out, err = successor.communicate(timeout=5)
            self.assertEqual(successor.returncode, 0, err)
            self.assertTrue((self.profile / 'recovered').exists())
            with sqlite3.connect(database_path(self.profile)) as check:
                self.assertEqual(check.execute('SELECT count(*) FROM session_turn_leases').fetchone()[0], 0)
        finally:
            for process in (owner, successor):
                if process is not None and process.poll() is None:
                    process.kill(); process.communicate(timeout=5)

    def test_unknown_schema_rolls_back_both_tables(self):
        db = self.seed(); db.close()
        with sqlite3.connect(database_path(self.profile)) as check:
            check.execute('ALTER TABLE compression_locks ADD COLUMN unknown_identity TEXT')
        with self.assertRaisesRegex(ValueError, 'unsupported_native_lease_schema'):
            with memory_lock(self.profile, reclaim_native=True):
                self.fail('unexpected entry')
        with sqlite3.connect(database_path(self.profile)) as check:
            for table in ('session_turn_leases', 'compression_locks'):
                self.assertEqual(check.execute('SELECT count(*) FROM '+table).fetchone()[0], 1)

    def test_fresh_database_is_not_created_and_other_modes_fail_closed(self):
        with memory_lock(self.profile, reclaim_native=True):
            self.assertFalse(database_path(self.profile).exists())
        with patch.dict(os.environ, NOCHEH_ISOLATED_TURN='0'):
            with self.assertRaisesRegex(ValueError, 'isolated_lease_recovery_required'):
                with memory_lock(self.profile, reclaim_native=True):
                    self.fail('unexpected entry')
        (self.profile/'native-state'/'state.db').symlink_to(self.profile/'outside.db')
        with self.assertRaisesRegex(ValueError, 'session_path_denied'):
            with memory_lock(self.profile, reclaim_native=True):
                self.fail('unexpected entry')


if __name__ == '__main__':
    unittest.main()
