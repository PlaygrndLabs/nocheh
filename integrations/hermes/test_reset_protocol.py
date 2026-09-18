import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from scripts import reset_protocol as protocol


class ResetProtocolTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name).resolve()
        self.generation = str(uuid.uuid4())
        self.token = '123456:synthetic-reset-fixture-not-a-real-token'
        metadata = self.state.stat()
        self.preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()),
                          'executable': False, 'content_copied': False, 'blockers': [],
                          'installation': {'state': str(self.state), 'state_anchor': {
                              'device': metadata.st_dev, 'inode': metadata.st_ino, 'kind': 'directory'}}}
        self.journal = self.state / 'admin/reset/progress.json'
        (self.state / 'spool').mkdir()
        (self.state / 'spool/.restore-inactive').touch()

    def ready(self, journal):
        journal.create(self.preflight, self.generation)
        for step in protocol.STEPS[:protocol.STEPS.index('telegram_boundary')]:
            journal.complete(step, protocol.fingerprint({'verified_fixture_step': step}))

    def boundary(self, journal, transport, **kwargs):
        return journal.telegram_boundary(self.token, kwargs.get('quiescent', lambda: None),
                                         kwargs.get('generation', lambda: self.generation), transport)

    def test_ordered_evidence_survives_reopen_and_cannot_be_rebound(self):
        with protocol.locked(self.state) as journal:
            journal.create(self.preflight, self.generation)
            with self.assertRaisesRegex(ValueError, 'out_of_order'):
                journal.complete('erased', 'a' * 64)
            with self.assertRaisesRegex(ValueError, 'empty_baseline'):
                self.boundary(journal, Mock())
            journal.complete('isolated_acceptance', 'a' * 64)
        with protocol.locked(self.state) as journal:
            journal.create(self.preflight, self.generation)
            journal.complete('isolated_acceptance', 'a' * 64)
            with self.assertRaisesRegex(ValueError, 'evidence_changed'):
                journal.complete('isolated_acceptance', 'b' * 64)
            with self.assertRaisesRegex(ValueError, 'already_in_progress'):
                journal.create(self.preflight, str(uuid.uuid4()))
            with self.assertRaisesRegex(ValueError, 'already_in_progress'):
                journal.create({**self.preflight, 'review_changed': True}, self.generation)
        self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.journal.parent / 'coordinator.lock').stat().st_mode & 0o777, 0o600)

    def test_one_confirmed_discard_retains_new_messages_across_restart(self):
        updates = ['before reset']; calls = []
        def discard(token):
            self.assertEqual(json.loads(self.journal.read_text())['telegram']['state'], 'attempting')
            self.assertEqual(token, self.token)
            calls.append(1); updates.clear(); return True
        with protocol.locked(self.state) as journal:
            self.ready(journal)
            self.assertFalse(self.boundary(journal, discard)['reused'])
        updates.append('fresh acceptance update')
        with protocol.locked(self.state) as journal:
            self.assertTrue(self.boundary(journal, discard)['reused'])
            self.assertEqual(journal.value['steps'][-1]['step'], 'telegram_boundary')
            journal.complete('fresh_acceptance', 'b' * 64)
            journal.complete('resumed', 'c' * 64)
        self.assertEqual(calls, [1]); self.assertEqual(updates, ['fresh acceptance update'])
        self.assertNotIn(self.token, self.journal.read_text())
        self.assertNotIn('acceptance update', self.journal.read_text())

    def test_response_loss_or_process_death_never_repeats_discard(self):
        for failure in (TimeoutError('private token-bearing URL'), SystemExit(9)):
            with self.subTest(failure=type(failure).__name__):
                if self.journal.exists(): self.journal.unlink()
                for path in self.journal.parent.glob('telegram-*.attempt'): path.unlink()
                calls = []
                def discard(_token):
                    calls.append(1); raise failure
                with protocol.locked(self.state) as journal:
                    self.ready(journal)
                    with self.assertRaises((RuntimeError, SystemExit)) as caught:
                        self.boundary(journal, discard)
                    self.assertNotIn('private', str(caught.exception))
                with protocol.locked(self.state) as journal:
                    with self.assertRaisesRegex(RuntimeError, 'outcome_uncertain'):
                        self.boundary(journal, discard)
                    with self.assertRaisesRegex(ValueError, 'out_of_order'):
                        journal.complete('fresh_acceptance', 'a' * 64)
                self.assertEqual(calls, [1])

    def test_unsynced_intent_does_not_send_and_reopen_remains_conservative(self):
        transport = Mock(return_value=True)
        with protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(protocol, 'sync_directory', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError): self.boundary(journal, transport)
        transport.assert_not_called()
        with protocol.locked(self.state) as journal:
            with self.assertRaisesRegex(RuntimeError, 'outcome_uncertain'):
                self.boundary(journal, transport)
        transport.assert_not_called()

    def test_crash_after_confirmation_before_phase_completion_recovers_without_call(self):
        transport = Mock(return_value=True)
        with protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(journal, 'complete', side_effect=SystemExit(9)):
                with self.assertRaises(SystemExit): self.boundary(journal, transport)
        with protocol.locked(self.state) as journal:
            self.assertTrue(self.boundary(journal, transport)['reused'])
        transport.assert_called_once()

    def test_failed_confirmation_write_is_uncertain_on_recovery(self):
        transport = Mock(return_value=True); atomic = protocol.atomic
        def fail_confirmation(path, value):
            if value['telegram'] and value['telegram']['state'] == 'confirmed':
                raise OSError('disk full')
            return atomic(path, value)
        with protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(protocol, 'atomic', side_effect=fail_confirmation):
                with self.assertRaises(OSError): self.boundary(journal, transport)
        with protocol.locked(self.state) as journal:
            with self.assertRaisesRegex(RuntimeError, 'outcome_uncertain'):
                self.boundary(journal, transport)
        transport.assert_called_once()

    def test_exclusive_attempt_survives_older_journal_and_other_kernel_lock_visibility(self):
        transport = Mock(return_value=True)
        with protocol.locked(self.state) as journal:
            self.ready(journal)
            before = self.journal.read_bytes()
            self.boundary(journal, transport)
        # Model an independently locked process holding the pre-attempt document.
        # The never-replaced reservation is independent of that document and lock.
        self.journal.write_bytes(before)
        with protocol.locked(self.state) as journal:
            with self.assertRaisesRegex(RuntimeError, 'outcome_uncertain'):
                self.boundary(journal, transport)
        transport.assert_called_once()

    def test_reservation_flush_failure_does_not_send(self):
        transport = Mock(return_value=True)
        with protocol.locked(self.state) as journal:
            self.ready(journal)
            sync = protocol.sync_directory; calls = []
            def fail_reservation(path):
                calls.append(path)
                if len(calls) == 2: raise OSError('reservation fsync failed')
                sync(path)
            with patch.object(protocol, 'sync_directory', side_effect=fail_reservation):
                with self.assertRaises(OSError): self.boundary(journal, transport)
        transport.assert_not_called()
        with protocol.locked(self.state) as journal:
            with self.assertRaisesRegex(RuntimeError, 'outcome_uncertain'):
                self.boundary(journal, transport)
        transport.assert_not_called()

    def test_maintenance_generation_and_identity_checks_precede_request(self):
        transport = Mock(return_value=True)
        with protocol.locked(self.state) as journal:
            self.ready(journal)
            with self.assertRaisesRegex(RuntimeError, 'writer'):
                self.boundary(journal, transport, quiescent=Mock(side_effect=RuntimeError('writer')))
            with self.assertRaisesRegex(ValueError, 'generation_changed'):
                self.boundary(journal, transport, generation=lambda: str(uuid.uuid4()))
            marker = self.state / 'spool/.restore-inactive'; marker.unlink()
            with self.assertRaisesRegex(ValueError, 'inactive_fence'):
                self.boundary(journal, transport)
            marker.touch()
            self.assertIsNone(journal.value['telegram'])
            transport.assert_not_called()
            self.boundary(journal, transport)
            with self.assertRaisesRegex(ValueError, 'binding_changed'):
                journal.telegram_boundary('123456:another-synthetic-fixture-token', lambda: None, lambda: self.generation, transport)
            with self.assertRaisesRegex(ValueError, 'generation_changed'):
                self.boundary(journal, transport, generation=lambda: str(uuid.uuid4()))
        transport.assert_called_once()

    def test_new_writer_after_response_does_not_lose_confirmation_or_repeat_call(self):
        transport = Mock(return_value=True)
        with protocol.locked(self.state) as journal:
            self.ready(journal)
            quiescent = Mock(side_effect=[None, RuntimeError('new writer')])
            with self.assertRaisesRegex(RuntimeError, 'new writer'):
                self.boundary(journal, transport, quiescent=quiescent)
            self.assertEqual(journal.value['steps'][-1]['step'], 'empty_baseline')
        with protocol.locked(self.state) as journal:
            self.assertTrue(self.boundary(journal, transport)['reused'])
        transport.assert_called_once()

    def test_coordinators_exclude_other_processes_and_reject_replaced_lock(self):
        with protocol.locked(self.state) as journal:
            journal.create(self.preflight, self.generation)
            script = "from scripts.reset_protocol import locked; import sys\nwith locked(sys.argv[1]): pass"
            result = subprocess.run([sys.executable, '-c', script, str(self.state)], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0); self.assertIn('reset_coordinator_busy', result.stderr)
            lock = journal.directory / 'coordinator.lock'; lock.unlink(); lock.touch()
            with self.assertRaisesRegex(RuntimeError, 'identity_changed'):
                journal.complete('isolated_acceptance', 'a' * 64)
        with self.assertRaisesRegex(RuntimeError, 'lock_required'):
            journal.assert_current()

    def test_journal_creation_does_not_overwrite_another_kernel_coordinator(self):
        with protocol.locked(self.state) as journal:
            stale = protocol.ResetJournal(self.state, journal.directory, journal.lock)
            journal.create(self.preflight, self.generation)
            journal.complete('isolated_acceptance', 'a' * 64)
            with self.assertRaises(FileExistsError):
                stale.create(self.preflight, self.generation)
            self.assertEqual(json.loads(self.journal.read_text())['steps'][0]['step'], 'isolated_acceptance')

    def test_symlinks_hardlinks_changed_journal_and_invented_completion_are_rejected(self):
        with protocol.locked(self.state) as journal:
            self.ready(journal)
            changed = json.loads(self.journal.read_text()); changed['generation'] = str(uuid.uuid4())
            self.journal.write_text(json.dumps(changed))
            with self.assertRaisesRegex(RuntimeError, 'journal_changed'):
                journal.complete('telegram_boundary', 'a' * 64)
        saved = self.state / 'saved.json'; self.journal.rename(saved); self.journal.symlink_to(saved)
        with self.assertRaises(OSError):
            with protocol.locked(self.state): pass
        self.journal.unlink(); os.link(saved, self.journal)
        with self.assertRaisesRegex(ValueError, 'file_invalid'):
            with protocol.locked(self.state): pass
        self.journal.unlink(); saved.rename(self.journal)
        changed = json.loads(self.journal.read_text()); changed['steps'].append({
            'step': 'telegram_boundary', 'evidence_sha256': 'a' * 64, 'completed_at': protocol.now()})
        self.journal.write_text(json.dumps(changed))
        with self.assertRaisesRegex(ValueError, 'telegram_journal_invalid'):
            with protocol.locked(self.state): pass

    def test_preflight_ownership_and_phase_hashes_are_required(self):
        with protocol.locked(self.state) as journal:
            with self.assertRaisesRegex(ValueError, 'preflight_invalid'):
                journal.create({**self.preflight, 'blockers': ['foreign writer']}, self.generation)
            preflight = {**self.preflight, 'installation': {**self.preflight['installation'], 'state_anchor': {}}}
            with self.assertRaisesRegex(ValueError, 'installation_changed'):
                journal.create(preflight, self.generation)
            journal.create(self.preflight, self.generation)
            with self.assertRaisesRegex(ValueError, 'evidence_hash'):
                journal.complete('isolated_acceptance', 'not-evidence')

    def test_transport_has_one_fixed_https_destination_and_no_redirect_or_retry(self):
        for status, raw, accepted in (
                (200, b'{"ok":true,"result":true}', True),
                (302, b'', False), (500, b'sensitive body', False),
                (200, b'{"ok":true,"result":1}', False), (200, b'{"ok":false}', False),
                (200, b'not JSON', False), (200, b' ' * 8193, False)):
            with self.subTest(status=status, raw_size=len(raw)):
                response = Mock(status=status); response.read.return_value = raw
                connection = Mock(); connection.getresponse.return_value = response
                with patch.object(protocol.http.client, 'HTTPSConnection', return_value=connection) as factory:
                    if accepted: self.assertTrue(protocol.delete_telegram_backlog(self.token))
                    else:
                        with self.assertRaisesRegex(RuntimeError, '^reset_telegram_outcome_uncertain$'):
                            protocol.delete_telegram_backlog(self.token)
                factory.assert_called_once_with('api.telegram.org', timeout=20)
                connection.request.assert_called_once_with('POST', '/bot' + self.token + '/deleteWebhook',
                    body=b'{"drop_pending_updates":true}', headers={'Content-Type': 'application/json'})
                response.read.assert_called_once_with(8193); connection.close.assert_called_once()
        with patch.object(protocol.http.client, 'HTTPSConnection') as factory:
            with self.assertRaisesRegex(ValueError, 'token_invalid'):
                protocol.delete_telegram_backlog(self.token + '\r\nInjected: header')
            factory.assert_not_called()


if __name__ == '__main__': unittest.main()
