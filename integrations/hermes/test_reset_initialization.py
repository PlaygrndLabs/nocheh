import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from integrations.hermes import preference_transfer
from scripts import (configuration, reset_baseline, reset_boundary, reset_initialization, reset_inventory,
                     reset_protocol, reset_quiescence)


class FakeDocker:
    def __init__(self, root, state, project, compose_file, request_path):
        self.root, self.state, self.project = Path(root), Path(state), project
        self.compose_file, self.request_path = str(compose_file), Path(request_path)
        self.containers, self.volumes, self.setup_calls, self.baseline_calls = {}, {}, 0, 0
        self.state_calls, self.state_generation = 0, None
        self.redis_dirty = False
        self.fail_start_once = False
        self.rendered = {'name': project, 'services': {
            'nocheh-db': {'volumes': [{'type': 'volume', 'source': 'postgres_data',
                                              'target': '/var/lib/postgresql/data'}]},
            'inngest-redis': {'volumes': [{'type': 'bind', 'source': str(state / 'workflows/redis'),
                                           'target': '/data'}]},
            'nocheh-reset-setup': {}},
            'volumes': {'postgres_data': {'name': project + '_postgres_data'}}}

    def container(self, service, identifier):
        mounts = ([{'Type': 'volume', 'Name': self.project + '_postgres_data',
                    'Source': self.project + '_postgres_data', 'Destination': '/var/lib/postgresql/data', 'RW': True}]
                  if service == 'nocheh-db' else
                  [{'Type': 'bind', 'Source': str(self.state / 'workflows/redis'),
                    'Destination': '/data', 'RW': True}])
        return {'id': identifier, 'name': '/' + self.project + '-' + service + '-1',
                'image': 'sha256:' + identifier, 'restart_policy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0},
                'state': 'created', 'project': self.project, 'service': service,
                'working_dir': str(self.root), 'config_files': self.compose_file, 'mounts': mounts}

    def __call__(self, arguments, _environment):
        if arguments[:5] == ['docker', 'ps', '-a', '-q', '--no-trunc']:
            return '\n'.join(self.containers) + ('\n' if self.containers else '')
        if arguments[:4] == ['docker', 'volume', 'ls', '-q']:
            return '\n'.join(self.volumes) + ('\n' if self.volumes else '')
        if arguments[:3] == ['docker', 'volume', 'create']:
            name = arguments[-1]
            self.volumes[name] = {'name': name, 'created_at': 'new', 'driver': 'local',
                                  'options': {}, 'labels': {'nocheh.reset.id': arguments[-2].split('=', 1)[-1]}}
            return name + '\n'
        if arguments[:4] == ['docker', 'volume', 'inspect', '--format']:
            return json.dumps(self.volumes[arguments[-1]]) + '\n'
        if arguments[:3] == ['docker', 'inspect', '--format']:
            if arguments[3] == reset_inventory.CONTAINER_FORMAT:
                return '\n'.join(json.dumps(self.containers[value]) for value in arguments[4:]) + '\n'
            row = self.containers[arguments[-1]]
            return json.dumps({'Status': row['state'], 'Health': {'Status': 'healthy'}}) + '\n'
        if arguments[:2] == ['docker', 'update']:
            for identifier in arguments[3:]:
                self.containers[identifier]['restart_policy'] = {'Name': 'no', 'MaximumRetryCount': 0}
            return ''
        if arguments[:2] == ['docker', 'start']:
            for identifier in arguments[2:]:
                self.containers[identifier]['state'] = 'running'
            if self.fail_start_once:
                self.fail_start_once = False
                raise RuntimeError('synthetic_start_interruption')
            return ''
        if arguments[:2] == ['docker', 'exec']:
            if 'redis-cli' in arguments:
                return '# Keyspace\n' + ('db0:keys=1,expires=0,avg_ttl=0\n' if self.redis_dirty else '')
            if 'psql' in arguments:
                return '0\n'
        if 'config' in arguments and arguments[-3:] == ['config', '--format', 'json']:
            return json.dumps(self.rendered)
        if 'create' in arguments:
            if not self.containers:
                pg, redis = 'b' * 64, 'c' * 64
                self.containers[pg] = self.container('nocheh-db', pg)
                self.containers[redis] = self.container('inngest-redis', redis)
                self.volumes[self.project + '_postgres_data'] = {
                    'name': self.project + '_postgres_data', 'created_at': 'new', 'driver': 'local', 'options': {},
                    'labels': {'com.docker.compose.project': self.project,
                               'com.docker.compose.volume': 'postgres_data'}}
            return ''
        if 'run' in arguments and arguments[-1] == 'nocheh-reset-setup':
            request = json.loads(self.request_path.read_text()); self.setup_calls += 1
            self.state_generation = request['generation']
            value = {'event': 'reset_setup_restored', 'generation': request['generation'],
                     'binding': {'generation': request['generation'], 'epoch': 1, 'mode': 'on'},
                     'configuration_records': 4, 'projects': 0, 'assignments': 0,
                     'sharing_rules': 0, 'memory_access_settings': 1,
                     'profiles': len(request['profile_commands']),
                     'source_content_copied': False, 'history_copied': False}
            return json.dumps(value) + '\n'
        if 'run' in arguments and arguments[-1] == 'nocheh-reset-baseline':
            request = json.loads(self.request_path.read_text()); self.baseline_calls += 1
            value = {'event': 'reset_baseline_verified', 'generation': request['generation'],
                     'archive_rows': 0, 'derived_rows': 0, 'control_setup_rows': 16,
                     'archive_state_sha256': '1' * 64, 'derived_state_sha256': '2' * 64,
                     'control_state_sha256': '3' * 64,
                     'profiles': len(request['profile_commands']), 'setup_only': True,
                     'source_content_present': False, 'derivative_content_present': False,
                     'history_present': False}
            return json.dumps(value) + '\n'
        if 'run' in arguments and arguments[-1] == 'nocheh-reset-state':
            self.state_calls += 1
            return json.dumps({'event': 'reset_state_observed', 'generation': self.state_generation,
                'archive_rows': 0, 'derived_rows': 0, 'control_rows': 16,
                'archive_state_sha256': '1' * 64, 'derived_state_sha256': '2' * 64,
                'control_state_sha256': '3' * 64}) + '\n'
        raise AssertionError(arguments)


class ResetInitializationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve(); self.state = self.root / 'state'; self.state.mkdir()
        (self.root / 'memory').mkdir()
        (self.state / 'hermes').mkdir(); (self.state / 'spool').mkdir()
        self.values = dict(configuration.DEFAULTS)
        self.values.update(NOCHEH_STORAGE_LAYOUT='original-only-v1', TELEGRAM_ENABLED='false',
            TELEGRAM_OWNER_ID='42', POSTGRES_PASSWORD='1' * 64, SERVICE_TOKEN='2' * 64,
            INNGEST_EVENT_KEY='3' * 64, INNGEST_SIGNING_KEY='4' * 64,
            INNGEST_POSTGRES_PASSWORD='5' * 64, NOCHEH_ARCHIVE_PASSWORD='6' * 64,
            NOCHEH_DERIVED_PASSWORD='7' * 64, NOCHEH_CONTROL_PASSWORD='8' * 64)
        configuration.write_env(self.state / '.env', self.values)
        loaded = configuration.load(self.state); configuration.validate(loaded)
        metadata = self.state.stat(); self.project = 'reset-initialization-fixture'
        self.preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()),
            'executable': False, 'content_copied': False, 'blockers': [],
            'containers': [{'id': 'a' * 64}],
            'volumes': [{'name': self.project + '_postgres_data', 'created_at': 'old'}],
            'installation': {'root': str(self.root), 'state': str(self.state), 'memory_state': str(self.root / 'memory'),
                'project': self.project, 'storage_layout': 'original-only-v1', 'config_path': str(self.state / '.env'),
                'configuration_sha256': hashlib.sha256(reset_protocol.canonical(loaded)).hexdigest(),
                'state_anchor': {'device': metadata.st_dev, 'inode': metadata.st_ino, 'kind': 'directory'}}}
        self.generation = str(uuid.uuid4()); self.reset_id = self.preflight['id']
        self.policy = {'enabled': False, 'owner_id': '42', 'group_ids': []}
        snapshot = {'format': 'nocheh-reset-configuration-v1', 'layout': 'original-only-v1', 'configuration': {
            'security_policy': [{'document': {'version': 1, 'rules': []}}],
            'installation_generation': [{'generation': str(uuid.uuid4())}], 'guard_mode': [{'mode': 'on'}],
            'runtime_configuration': [{'name': 'assistant', 'document': self.policy}], 'projects': [],
            'project_assignments': [], 'sharing_rules': [],
            'memory_access_settings': [{'destination': '*', 'suggestions': 'related', 'notify_owner': True,
                                        'auto_followup': True, 'request_ttl_seconds': 86400,
                                        'default_grant_mode': 'one_time'}],
            'runtime_profiles': []}}
        preferences = preference_transfer.capture(self.state / 'hermes',
                                                  SimpleNamespace(owner='42', groups=[]), [])
        self.artifacts = {'receipt': {'format': 'fixture'},
            'configuration': {'snapshot_sha256': reset_protocol.fingerprint(snapshot), 'snapshot': snapshot},
            'preferences': {'snapshot_sha256': reset_protocol.fingerprint(preferences), 'snapshot': preferences}}
        self.command = ['docker', 'compose', '-f', str(self.root / 'compose.yml'), '-p', self.project]
        self.environment = {'NOCHEH_HONCHO_ENABLED': 'false', 'NOCHEH_MODEL': 'fixture-model'}

    def legacy(self):
        self.values['NOCHEH_STORAGE_LAYOUT'] = 'legacy'; configuration.write_env(self.state / '.env', self.values)
        loaded = configuration.load(self.state)
        self.preflight['installation']['storage_layout'] = 'legacy'
        self.preflight['installation']['configuration_sha256'] = hashlib.sha256(
            reset_protocol.canonical(loaded)).hexdigest()
        snapshot = {'format': 'nocheh-reset-configuration-v1', 'layout': 'legacy', 'configuration': {
            'security_policy': [{'document': {'version': 1, 'rules': []}}],
            'memory_spaces': [{'id': '-10', 'overrides': {'mode': 'filtered', 'sources': ['42']}}]}}
        self.artifacts['configuration'] = {'snapshot_sha256': reset_protocol.fingerprint(snapshot),
                                           'snapshot': snapshot}

    def ready(self, journal):
        journal.create(self.preflight, self.generation)
        for step in reset_protocol.STEPS[:4]:
            journal.complete(step, 'e' * 64)
        erasure = {'stage': 'volumes_removed'}
        reset_protocol.atomic(journal.directory / 'erasure.json', erasure, create=True)
        journal.complete('erased', reset_protocol.fingerprint(erasure))
        reset_quiescence.fence(self.state, journal.value['reset_id'])

    def test_interrupted_fresh_resource_start_retries_without_activating_runtime(self):
        fake = FakeDocker(self.root, self.state, self.project, self.command[3],
                          self.state / 'admin/reset/setup.json')
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); fake.fail_start_once = True
            with patch.object(reset_initialization.reset_preservation, 'assert_frozen', return_value=self.artifacts):
                with self.assertRaisesRegex(RuntimeError, 'synthetic_start_interruption'):
                    reset_initialization.initialize(journal, self.preflight, runner=fake,
                        environment=self.environment, command=self.command)
                self.assertEqual(reset_protocol.read(journal.directory / 'initialization.json')['stage'], 'resources_created')
                result = reset_initialization.initialize(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command)
                self.assertEqual(result['phase'], 'initialized')
                self.assertFalse(result['runtime_activated']); self.assertEqual(fake.setup_calls, 1)
                self.assertEqual(journal.value['steps'][-1]['step'], 'initialized')
                self.assertTrue((self.state / 'hermes/nocheh-policy.yaml').is_file())
                self.assertEqual(reset_initialization.initialize(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command), result)
                self.assertEqual(fake.setup_calls, 1)
        self.assertTrue(all(row['restart_policy']['Name'] == 'no' for row in fake.containers.values()))
        self.assertTrue(all(row['service'] in reset_initialization.DATABASE_SERVICES for row in fake.containers.values()))

    def test_old_resource_identity_blocks_before_fresh_creation(self):
        fake = FakeDocker(self.root, self.state, self.project, self.command[3],
                          self.state / 'admin/reset/setup.json')
        fake.containers['a' * 64] = fake.container('nocheh-db', 'a' * 64)
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(reset_initialization.reset_preservation, 'assert_frozen', return_value=self.artifacts):
                with self.assertRaisesRegex(RuntimeError, 'old_container_present'):
                    reset_initialization.initialize(journal, self.preflight, runner=fake,
                        environment=self.environment, command=self.command)
        self.assertEqual(fake.volumes, {}); self.assertEqual(fake.setup_calls, 0)

    def test_legacy_layout_transition_is_recorded_before_write_and_retryable(self):
        self.legacy(); fake = FakeDocker(self.root, self.state, self.project, self.command[3],
                                         self.state / 'admin/reset/setup.json')
        writer = configuration.write_env; interrupted = False

        def after_write(path, values):
            nonlocal interrupted
            writer(path, values)
            if not interrupted:
                interrupted = True; raise OSError('synthetic_layout_interruption')

        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(reset_initialization.reset_preservation, 'assert_frozen', return_value=self.artifacts), \
                 patch.object(reset_initialization.configuration, 'write_env', side_effect=after_write):
                with self.assertRaisesRegex(OSError, 'synthetic_layout_interruption'):
                    reset_initialization.initialize(journal, self.preflight, runner=fake,
                        environment=self.environment, command=self.command)
            self.assertEqual(reset_protocol.read(journal.directory / 'layout.json')['stage'], 'prepared')
            self.assertEqual(configuration.load(self.state)['NOCHEH_STORAGE_LAYOUT'], 'original-only-v1')
            with patch.object(reset_initialization.reset_preservation, 'assert_frozen', return_value=self.artifacts):
                result = reset_initialization.initialize(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command)
            request = reset_protocol.read(journal.directory / 'setup.json')
            self.assertEqual(result['phase'], 'initialized')
            self.assertEqual(request['snapshot']['layout'], 'original-only-v1')
            self.assertEqual(request['snapshot']['configuration']['sharing_rules'][0]['destination'], '-10')
            self.assertTrue(request['snapshot']['configuration']['sharing_rules'][0]['enabled'])

    def test_empty_baseline_retires_private_artifacts_and_rejects_cache_content(self):
        fake = FakeDocker(self.root, self.state, self.project, self.command[3],
                          self.state / 'admin/reset/setup.json')
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(reset_initialization.reset_preservation, 'assert_frozen', return_value=self.artifacts):
                reset_initialization.initialize(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command)
            directory = journal.directory
            for name in reset_baseline.PRIVATE:
                path = directory / name
                if path.exists():
                    continue
                value = ({'snapshot': self.artifacts['preferences']['snapshot']}
                         if name == 'preferences.json' else {'fixture': name})
                reset_protocol.atomic(path, value, create=True)
            fake.redis_dirty = True
            with self.assertRaisesRegex(RuntimeError, 'cache_not_empty'):
                reset_baseline.verify(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command)
            self.assertTrue((directory / 'setup.json').is_file())
            fake.redis_dirty = False
            result = reset_baseline.verify(journal, self.preflight, runner=fake,
                environment=self.environment, command=self.command)
            self.assertEqual(result['phase'], 'empty_baseline'); self.assertEqual(fake.baseline_calls, 2)
            self.assertEqual(journal.value['steps'][-1]['step'], 'empty_baseline')
            self.assertTrue(all(not (directory / name).exists() for name in reset_baseline.PRIVATE))
            self.assertEqual(reset_baseline.verify(journal, self.preflight, runner=fake,
                environment=self.environment, command=self.command), result)
            fake.redis_dirty = True
            with self.assertRaisesRegex(RuntimeError, 'cache_not_empty'):
                reset_baseline.verify(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command)

    def test_telegram_boundary_rechecks_current_baseline_and_generation_without_retry(self):
        fake = FakeDocker(self.root, self.state, self.project, self.command[3],
                          self.state / 'admin/reset/setup.json')
        calls = []
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with patch.object(reset_initialization.reset_preservation, 'assert_frozen', return_value=self.artifacts):
                reset_initialization.initialize(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command)
            for name in reset_baseline.PRIVATE:
                path = journal.directory / name
                if path.exists():
                    continue
                value = ({'snapshot': self.artifacts['preferences']['snapshot']}
                         if name == 'preferences.json' else {'fixture': name})
                reset_protocol.atomic(path, value, create=True)
            reset_baseline.verify(journal, self.preflight, runner=fake,
                                  environment=self.environment, command=self.command)
            result = reset_boundary.discard_backlog(journal, self.preflight,
                '123456:synthetic-reset-fixture-not-a-real-token', runner=fake,
                environment=self.environment, command=self.command,
                transport=lambda _token: calls.append(1) or True)
            self.assertEqual(result, {'phase': 'telegram_boundary', 'state': 'confirmed',
                                      'reused': False, 'runtime_activated': False})
            self.assertEqual(journal.value['steps'][-1]['step'], 'telegram_boundary')
            replay = reset_boundary.discard_backlog(journal, self.preflight,
                '123456:synthetic-reset-fixture-not-a-real-token', runner=fake,
                environment=self.environment, command=self.command,
                transport=lambda _token: calls.append(1) or True)
            self.assertTrue(replay['reused']); self.assertEqual(calls, [1])
            fake.state_generation = str(uuid.uuid4())
            with self.assertRaisesRegex(RuntimeError, 'state_changed'):
                reset_boundary.discard_backlog(journal, self.preflight,
                    '123456:synthetic-reset-fixture-not-a-real-token', runner=fake,
                    environment=self.environment, command=self.command,
                    transport=lambda _token: calls.append(1) or True)
            self.assertEqual(calls, [1])


if __name__ == '__main__':
    unittest.main()
