import copy
import hashlib
import json
import copy
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scripts import (configuration, reset_inventory, reset_ownership,
                     reset_preservation, reset_protocol, reset_quiescence)


class ResetPreservationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve(); self.state = self.root / 'state'; self.memory = self.root / 'memory'
        self.state.mkdir(); self.memory.mkdir()
        for relative in ('files', 'spool', 'workflows', 'admin/reset', 'admin/tools', 'hermes/profiles',
                         'provider/auth', 'provider/monitor'):
            (self.state / relative).mkdir(parents=True)
        (self.state / 'files/original').write_text('PRIVATE ORIGINAL SOURCE')
        (self.state / 'spool/observation').write_text('PRIVATE INCOMING OBSERVATION')
        (self.state / 'hermes/auth.json').write_text('PRIVATE PROVIDER LOGIN')
        (self.state / 'provider/auth/token').write_text('PRIVATE EXTERNAL CREDENTIAL')
        self.accounting = self.state / 'provider/monitor/usage.sqlite'; self.accounting.write_text('PRIVATE ACCOUNTING DIAGNOSTIC')
        (self.memory / 'ledger').mkdir(); (self.memory / 'ledger/spend').write_text('RETAINED SPENDING')
        (self.memory / 'honcho.env').write_text('PRIVATE HONCHO SETUP')
        values = dict(configuration.DEFAULTS)
        values.update(NOCHEH_STORAGE_LAYOUT='original-only-v1', TELEGRAM_ENABLED='false',
                      TELEGRAM_OWNER_ID='42', TELEGRAM_GROUP_IDS='-10', NOCHEH_MODEL='fixture-model',
                      POSTGRES_PASSWORD='1' * 64, SERVICE_TOKEN='2' * 64,
                      INNGEST_EVENT_KEY='3' * 64, INNGEST_SIGNING_KEY='4' * 64,
                      INNGEST_POSTGRES_PASSWORD='5' * 64, NOCHEH_ARCHIVE_PASSWORD='6' * 64,
                      NOCHEH_DERIVED_PASSWORD='7' * 64, NOCHEH_CONTROL_PASSWORD='8' * 64,
                      NOCHEH_HONCHO_STATE_DIR=str(self.memory))
        self.config = self.state / '.env'; configuration.write_env(self.config, values)
        self.loaded = configuration.load(self.state); configuration.validate(self.loaded)
        blockers = []; paths = reset_inventory.files(self.state, self.memory, self.config, blockers)
        self.database = {name: [] for name in reset_preservation.reset_configuration.catalog('original-only-v1')}
        policy = {'enabled': False, 'owner_id': '42', 'group_ids': ['-10']}
        self.database.update(security_policy=[{'document': {'version': 1, 'rules': []}}],
                             installation_generation=[{'generation': '11111111-1111-4111-8111-111111111111'}],
                             guard_mode=[{'mode': 'on'}],
                             runtime_configuration=[{'name': 'assistant', 'document': policy}])
        self.preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()),
            'executable': False, 'content_copied': False, 'blockers': blockers,
            'containers': [], 'volumes': [], 'paths': paths, 'external_archives': [],
            'installation': {'root': str(self.root), 'state': str(self.state), 'memory_state': str(self.memory),
                'project': 'fixture', 'storage_layout': 'original-only-v1', 'config_path': str(self.config),
                'configuration_sha256': hashlib.sha256(reset_protocol.canonical(self.loaded)).hexdigest(),
                'state_anchor': reset_inventory.entry(self.state, 'retain_root', 'fixture')}}
        self.recovery = Mock(spec=['assert_maintenance', 'query'])
        self.recovery.query.return_value = json.dumps(self.database)
        self.sanitize_calls = 0

    def ready(self, journal):
        journal.create(self.preflight, str(uuid.uuid4()))
        for step in reset_protocol.STEPS[:3]:
            journal.complete(step, 'a' * 64)
        reset_quiescence.fence(self.state, journal.value['reset_id'])

    def ownership(self):
        review = reset_ownership.prepare(self.preflight)
        for root in review['roots']:
            for row in root['entries']:
                row['disposition'] = 'preserve-unrelated'
        return review

    def sanitize(self, path):
        self.assertEqual(Path(path), self.accounting); self.sanitize_calls += 1
        self.accounting.write_text('SANITIZED ACCOUNTING ONLY')
        Path(str(path) + '.manager.lock').touch()
        return {'accounting_preserved': True, 'erased_rows': {'content_log': 2},
                'compacted': True, 'backup_created': False}

    def freeze(self, journal, ownership=None):
        return reset_preservation.freeze(journal, self.preflight, self.recovery,
            self.ownership() if ownership is None else ownership, inspect=lambda: self.preflight,
            sanitize=self.sanitize)

    def test_complete_gate_is_durable_content_free_and_retryable(self):
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); result = self.freeze(journal)
            self.assertEqual(journal.value['steps'][-1]['step'], 'preservation_frozen')
            self.assertEqual(self.sanitize_calls, 1); self.assertTrue(result['accounting_preserved'])
            self.assertFalse(result['content_backup_created']); self.assertFalse(result['source_content_copied'])
            for forbidden in ('PRIVATE', 'RETAINED SPENDING', str(self.accounting)):
                self.assertNotIn(forbidden, json.dumps(result))
            self.assertTrue((self.state / 'files/original').exists())
            self.assertTrue((self.state / 'spool/observation').exists())
            for name in ('configuration.json', 'preferences.json', 'accounting.json', 'preserved.json',
                         'ownership.json', 'files.json', 'preservation.json'):
                path = journal.directory / name
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn(b'PRIVATE ORIGINAL SOURCE', path.read_bytes())
                self.assertNotIn(b'PRIVATE INCOMING OBSERVATION', path.read_bytes())
            before = {path.name: path.read_bytes() for path in journal.directory.iterdir() if path.is_file()}
            self.assertEqual(self.freeze(journal), result); self.assertEqual(self.sanitize_calls, 1)
            self.assertEqual(before, {path.name: path.read_bytes() for path in journal.directory.iterdir() if path.is_file()})

    def test_incomplete_ownership_review_blocks_before_preservation_mutation(self):
        external = self.root / 'data/backups'; external.mkdir(parents=True); (external / 'unknown').write_text('UNKNOWN OWNER')
        self.preflight['external_archives'] = [reset_inventory.entry(external, 'review_archive', 'review')]
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); review = reset_ownership.prepare(self.preflight)
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                self.freeze(journal, review)
            self.assertEqual(self.sanitize_calls, 0); self.assertEqual(len(journal.value['steps']), 3)
            self.assertEqual(self.accounting.read_text(), 'PRIVATE ACCOUNTING DIAGNOSTIC')

    def test_database_policy_mismatch_blocks_accounting_and_completion(self):
        self.database['runtime_configuration'][0]['document']['group_ids'] = ['-99']
        self.recovery.query.return_value = json.dumps(self.database)
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with self.assertRaisesRegex(ValueError, 'runtime_configuration_mismatch'):
                self.freeze(journal)
            self.assertEqual(self.sanitize_calls, 0); self.assertEqual(len(journal.value['steps']), 3)

    def test_preserved_credential_drift_blocks_before_accounting_mutation(self):
        credentials = self.state / 'provider/auth'; prior = self.root / 'prior-auth'
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); credentials.rename(prior); credentials.mkdir(); (credentials / 'token').write_text('CHANGED CREDENTIAL')
            with self.assertRaisesRegex(ValueError, 'identity_changed'):
                self.freeze(journal)
            self.assertEqual(self.sanitize_calls, 0); self.assertEqual(len(journal.value['steps']), 3)

    def test_changed_erasure_tree_cannot_reuse_completed_preservation(self):
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); self.freeze(journal)
            (self.state / 'files/late').write_text('LATE SOURCE')
            with self.assertRaisesRegex(ValueError, 'artifact_changed|manifest_changed'):
                self.freeze(journal)
            self.assertEqual(self.sanitize_calls, 1)

    def test_native_status_replaced_during_shutdown_is_rebound_once(self):
        status=self.state/'hermes/gateway_state.json';status.write_text('running status')
        self.preflight['paths'].append(reset_inventory.entry(status,'erase','native status'))
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            old=self.root/'old-status';status.rename(old);status.write_text('stopped status')
            result=self.freeze(journal)
            self.assertEqual(result['phase'],'preservation_frozen')
            self.assertEqual(self.freeze(journal),result)
            replaced=self.root/'replaced-status';status.rename(replaced);status.write_text('later status')
            with self.assertRaisesRegex(ValueError,'artifact_changed|manifest_changed'):
                self.freeze(journal)

    def test_frozen_manifest_accepts_only_stopped_redis_aof_metadata_drift(self):
        redis=self.state/'workflows/redis/appendonlydir';redis.mkdir(parents=True)
        aof=redis/'appendonly.aof.23.incr.aof';aof.write_bytes(b'old cache')
        frozen=reset_preservation.reset_files.freeze(self.preflight,[])
        receipt={'format':'nocheh-reset-files-receipt-v1','reset_id':'fixture',
                 'preflight_sha256':'a'*64,'ownership_sha256':'b'*64,
                 'manifest_sha256':reset_protocol.fingerprint(frozen),'manifest':frozen}
        journal=SimpleNamespace(directory=self.state/'admin/reset',
                                value={'steps':[{}]*4})
        reset_protocol.atomic(journal.directory/'files.json',receipt,create=True)
        aof.write_bytes(b'new cache content after stop')
        current=reset_preservation.reset_files.freeze(self.preflight,[])
        updated={**receipt,'manifest_sha256':reset_protocol.fingerprint(current),'manifest':current}
        stopped=lambda:{'containers':[{'service':'inngest-redis','state':'exited'}]}
        with patch.object(reset_quiescence,'verify_quiescent'):
            self.assertEqual(reset_preservation._frozen_files(journal,self.preflight,stopped,updated),receipt)
            running=lambda:{'containers':[{'service':'inngest-redis','state':'running'}]}
            with self.assertRaisesRegex(ValueError,'artifact_changed'):
                reset_preservation._frozen_files(journal,self.preflight,running,updated)
            replaced=copy.deepcopy(updated)
            replaced['manifest']['targets'][-1]['tree']['metadata']['inode'] += 1
            replaced['manifest_sha256']=reset_protocol.fingerprint(replaced['manifest'])
            with self.assertRaisesRegex(ValueError,'artifact_changed'):
                reset_preservation._frozen_files(journal,self.preflight,stopped,replaced)

    def test_interruption_before_phase_record_reuses_sanitized_accounting(self):
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); complete = journal.complete
            journal.complete = lambda step, evidence: (_ for _ in ()).throw(RuntimeError('fixture interruption')) if step == 'preservation_frozen' else complete(step, evidence)
            with self.assertRaisesRegex(RuntimeError, 'fixture interruption'):
                self.freeze(journal)
            self.assertEqual(self.sanitize_calls, 1); self.assertEqual(len(journal.value['steps']), 3)
        with reset_protocol.locked(self.state) as journal:
            result = self.freeze(journal)
            self.assertEqual(result['phase'], 'preservation_frozen'); self.assertEqual(self.sanitize_calls, 1)

    def test_crash_after_sanitization_before_receipt_retries_safely(self):
        original = reset_preservation._immutable
        def interrupted(path, value):
            if path.name == 'accounting.json':
                raise OSError('fixture receipt interruption')
            return original(path, value)
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(reset_preservation, '_immutable', side_effect=interrupted):
                with self.assertRaisesRegex(OSError, 'receipt interruption'):
                    self.freeze(journal)
            self.assertEqual(self.sanitize_calls, 1); self.assertFalse((journal.directory / 'accounting.json').exists())
        with reset_protocol.locked(self.state) as journal:
            self.assertEqual(self.freeze(journal)['phase'], 'preservation_frozen')
            self.assertEqual(self.sanitize_calls, 2)

    def test_lost_maintenance_after_sanitization_never_completes_phase(self):
        def sanitize(path):
            result = self.sanitize(path)
            self.recovery.assert_maintenance.side_effect = RuntimeError('maintenance lost')
            return result
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with self.assertRaisesRegex(RuntimeError, 'maintenance lost'):
                reset_preservation.freeze(journal, self.preflight, self.recovery, self.ownership(),
                    inspect=lambda: self.preflight, sanitize=sanitize)
            self.assertEqual(len(journal.value['steps']), 3)


if __name__ == '__main__': unittest.main()
