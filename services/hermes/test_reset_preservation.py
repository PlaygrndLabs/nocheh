import copy
import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from tools.operations.installation import configuration
from tools.acceptance import reset_inventory
from tools.acceptance import reset_ownership
from tools.acceptance import reset_preservation
from tools.acceptance import reset_protocol
from tools.acceptance import reset_quiescence


class ResetPreservationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve(); self.state = self.root / 'state'; self.memory = self.root / 'memory'
        self.state.mkdir(); self.memory.mkdir()
        for relative in ('files', 'spool', 'workflows', 'admin/reset', 'admin/tools', 'hermes/profiles'):
            (self.state / relative).mkdir(parents=True)
        (self.state / 'files/original').write_text('PRIVATE ORIGINAL SOURCE')
        (self.state / 'spool/observation').write_text('PRIVATE INCOMING OBSERVATION')
        (self.state / 'hermes/auth.json').write_text('PRIVATE PROVIDER LOGIN')
        (self.memory / 'ledger').mkdir(); (self.memory / 'ledger/spend').write_text('RETAINED SPENDING')
        (self.memory / 'honcho.env').write_text('PRIVATE HONCHO SETUP')
        values = dict(configuration.DEFAULTS)
        values.update(NOCHEH_STORAGE_LAYOUT='original-only-v1', TELEGRAM_ENABLED='false',
                      TELEGRAM_OWNER_ID='42', NOCHEH_MODEL='fixture-model',
                      POSTGRES_PASSWORD='1' * 64, SERVICE_TOKEN='2' * 64,
                      INNGEST_EVENT_KEY='3' * 64, INNGEST_SIGNING_KEY='4' * 64,
                      INNGEST_POSTGRES_PASSWORD='5' * 64, NOCHEH_ARCHIVE_PASSWORD='6' * 64,
                      NOCHEH_DERIVED_PASSWORD='7' * 64, NOCHEH_CONTROL_PASSWORD='8' * 64,
                      NOCHEH_HONCHO_STATE_DIR=str(self.memory))
        self.config = self.state / '.env'; configuration.write_env(self.config, values)
        self.loaded = configuration.load(self.state); configuration.validate(self.loaded)
        blockers = []; paths = reset_inventory.files(self.state, self.memory, self.config, blockers)
        self.database = {name: [] for name in reset_preservation.reset_configuration.catalog('original-only-v1')}
        policy = {'enabled': False, 'owner_id': '42'}
        self.database.update(security_policy=[{'document': {'version': 1, 'rules': []}}],
                             installation_generation=[{'generation': '11111111-1111-4111-8111-111111111111'}],
                             guard_mode=[{'mode': 'on'}],
                             runtime_configuration=[{'name': 'assistant', 'document': policy}],
                             daily_messages=[{'daily_messages': 200}])
        self.preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()),
            'executable': False, 'content_copied': False, 'blockers': blockers,
            'containers': [], 'volumes': [], 'paths': paths, 'external_archives': [],
            'installation': {'root': str(self.root), 'state': str(self.state), 'memory_state': str(self.memory),
                'project': 'fixture', 'storage_layout': 'original-only-v1', 'config_path': str(self.config),
                'configuration_sha256': hashlib.sha256(reset_protocol.canonical(self.loaded)).hexdigest(),
                'state_anchor': reset_inventory.entry(self.state, 'retain_root', 'fixture')}}
        self.recovery = Mock(spec=['assert_maintenance', 'query'])
        self.recovery.query.return_value = json.dumps(self.database)

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

    def freeze(self, journal, ownership=None):
        return reset_preservation.freeze(journal, self.preflight, self.recovery,
            self.ownership() if ownership is None else ownership, inspect=lambda: self.preflight)

    def test_complete_gate_is_durable_content_free_and_retryable(self):
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); result = self.freeze(journal)
            self.assertEqual(journal.value['steps'][-1]['step'], 'preservation_frozen')
            self.assertFalse(result['content_backup_created']); self.assertFalse(result['source_content_copied'])
            for forbidden in ('PRIVATE', 'RETAINED SPENDING'):
                self.assertNotIn(forbidden, json.dumps(result))
            self.assertTrue((self.state / 'files/original').exists())
            self.assertTrue((self.state / 'spool/observation').exists())
            for name in ('configuration.json', 'preferences.json', 'preserved.json',
                         'ownership.json', 'files.json', 'preservation.json'):
                path = journal.directory / name
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertNotIn(b'PRIVATE ORIGINAL SOURCE', path.read_bytes())
                self.assertNotIn(b'PRIVATE INCOMING OBSERVATION', path.read_bytes())
            before = {path.name: path.read_bytes() for path in journal.directory.iterdir() if path.is_file()}
            self.assertEqual(self.freeze(journal), result)
            self.assertEqual(before, {path.name: path.read_bytes() for path in journal.directory.iterdir() if path.is_file()})

    def test_preferences_follow_the_chats_the_configuration_snapshot_records(self):
        # ADR-0252: a configuration snapshot with chat records names each chat by its Nocheh id: the owner's chat, a group
        # Telegram upgraded (old id '-10', now '-1010'), a group first seen after step 2b, and their topics.
        new, topic, other = 'b' * 64, 'c' * 64, 'd' * 64
        # ADR-0253: the groups kept are the ones Nocheh is on in, by their current ids; one it is off in or left is not.
        new, topic, other = 'b' * 64, 'c' * 64, 'd' * 64
        rows = [{'id': '42', 'app': 'telegram', 'kind': 'private', 'parent_id': None, 'state': 'active'},
                {'id': '-10', 'app': 'telegram', 'kind': 'group', 'parent_id': None, 'state': 'active'},
                {'id': new, 'app': 'telegram', 'kind': 'group', 'parent_id': None, 'state': 'active'},
                {'id': topic, 'app': 'telegram', 'kind': 'topic', 'parent_id': '-10', 'state': 'active'},
                {'id': other, 'app': 'telegram', 'kind': 'topic', 'parent_id': '-99', 'state': 'off'},
                {'id': '-99', 'app': 'telegram', 'kind': 'group', 'parent_id': None, 'state': 'off'},
                {'id': '-98', 'app': 'telegram', 'kind': 'group', 'parent_id': None, 'state': 'left'}]
        ids = [{'app': 'telegram', 'external_id': external, 'chat_id': chat, 'state': state, 'reason': None}
               for external, chat, state in (('42', '42', 'current'), ('-10', '-10', 'old'), ('-1010', '-10', 'current'),
                                             ('-30', new, 'current'), ('-99', '-99', 'current'), ('-98', '-98', 'current'))]
        served = reset_preservation._served({'chats': rows, 'chat_ids': ids})
        self.assertEqual(served, ['-1010', '-30'])
        chats = reset_preservation._chats({'chats': rows, 'chat_ids': ids}, '42', served)
        self.assertEqual(chats, {'owner': '42', 'groups': {'-10': ['-10', '-1010'], new: ['-30']}, 'topics': {topic: '-10'}})
        self.assertEqual(reset_preservation._served({'projects': []}), [], 'a snapshot from before step 2b keeps no group on')
        self.assertIsNone(reset_preservation._chats({'projects': []}, '42', []), 'a snapshot from before step 2b')
        with self.assertRaisesRegex(ValueError, 'scope_changed'):
            reset_preservation._chats({'chats': rows, 'chat_ids': ids}, '42', ['-1010', '42'])

    def test_incomplete_ownership_review_blocks_before_preservation_mutation(self):
        external = self.root / 'data/backups'; external.mkdir(parents=True); (external / 'unknown').write_text('UNKNOWN OWNER')
        self.preflight['external_archives'] = [reset_inventory.entry(external, 'review_archive', 'review')]
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); review = reset_ownership.prepare(self.preflight)
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                self.freeze(journal, review)
            self.assertEqual(len(journal.value['steps']), 3)
            self.assertFalse((journal.directory / 'preserved.json').exists())

    def test_preferences_keep_the_groups_nocheh_is_on_in(self):
        # Which groups Nocheh is on in is each chat's state in the snapshot, not the setup (ADR-0253).
        row = lambda id, kind, state: {'id': id, 'app': 'telegram', 'kind': kind, 'parent_id': None, 'topic_key': None, 'app_type': None,
                                       'title': None, 'title_source': None, 'is_forum': False, 'state': state}
        self.database.update(chats=[row('-10', 'group', 'active'), row('-20', 'group', 'off'), row('-30', 'group', 'left'), row('42', 'private', 'active')],
                             chat_ids=[{'app': 'telegram', 'external_id': id, 'chat_id': id, 'state': 'current', 'reason': None}
                                       for id in ('-10', '-20', '-30', '42')])
        self.recovery.query.return_value = json.dumps(self.database)
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); self.freeze(journal)
            snapshot = json.loads((journal.directory / 'preferences.json').read_text())['snapshot']
        self.assertEqual(snapshot['groups'], ['-10'])
        self.assertEqual(snapshot['chats']['groups'], {'-10': ['-10']})

    def test_database_policy_mismatch_blocks_completion(self):
        self.database['runtime_configuration'][0]['document']['enabled'] = True
        self.recovery.query.return_value = json.dumps(self.database)
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with self.assertRaisesRegex(ValueError, 'runtime_configuration_mismatch'):
                self.freeze(journal)
            self.assertEqual(len(journal.value['steps']), 3)

    def test_preserved_spending_drift_blocks_before_the_preserved_snapshot(self):
        ledger = self.memory / 'ledger'; prior = self.root / 'prior-ledger'
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); ledger.rename(prior); ledger.mkdir(); (ledger / 'spend').write_text('CHANGED SPENDING')
            with self.assertRaisesRegex(ValueError, 'identity_changed'):
                self.freeze(journal)
            self.assertEqual(len(journal.value['steps']), 3)
            self.assertFalse((journal.directory / 'preserved.json').exists())

    def test_changed_erasure_tree_cannot_reuse_completed_preservation(self):
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); self.freeze(journal)
            (self.state / 'files/late').write_text('LATE SOURCE')
            with self.assertRaisesRegex(ValueError, 'artifact_changed|manifest_changed'):
                self.freeze(journal)

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

    def test_interruption_before_phase_record_reuses_frozen_artifacts(self):
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); complete = journal.complete
            journal.complete = lambda step, evidence: (_ for _ in ()).throw(RuntimeError('fixture interruption')) if step == 'preservation_frozen' else complete(step, evidence)
            with self.assertRaisesRegex(RuntimeError, 'fixture interruption'):
                self.freeze(journal)
            self.assertEqual(len(journal.value['steps']), 3)
        with reset_protocol.locked(self.state) as journal:
            result = self.freeze(journal)
            self.assertEqual(result['phase'], 'preservation_frozen')

    def test_crash_before_preserved_receipt_retries_safely(self):
        original = reset_preservation._immutable
        def interrupted(path, value):
            if path.name == 'preserved.json':
                raise OSError('fixture receipt interruption')
            return original(path, value)
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(reset_preservation, '_immutable', side_effect=interrupted):
                with self.assertRaisesRegex(OSError, 'receipt interruption'):
                    self.freeze(journal)
            self.assertFalse((journal.directory / 'preserved.json').exists())
        with reset_protocol.locked(self.state) as journal:
            self.assertEqual(self.freeze(journal)['phase'], 'preservation_frozen')

    def test_lost_maintenance_after_preserved_snapshot_never_completes_phase(self):
        original = reset_preservation._snapshot_preserved
        def snapshot(*args):
            result = original(*args)
            self.recovery.assert_maintenance.side_effect = RuntimeError('maintenance lost')
            return result
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(reset_preservation, '_snapshot_preserved', side_effect=snapshot):
                with self.assertRaisesRegex(RuntimeError, 'maintenance lost'):
                    self.freeze(journal)
            self.assertEqual(len(journal.value['steps']), 3)


if __name__ == '__main__': unittest.main()
