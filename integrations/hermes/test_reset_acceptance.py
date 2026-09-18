import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from scripts import (reset_acceptance, reset_initialization, reset_inventory,
                     reset_protocol, reset_quiescence)


class FakeDocker:
    def __init__(self, root, project):
        self.root = str(root); self.project = project
        self.files = str(root / 'compose.yml')
        self.fail_start_once = False; self.start_calls = []
        self.rendered = {'name': project, 'services': {
            'nocheh-postgres': {}, 'inngest-redis': {},
            'nocheh-store-bootstrap': {'depends_on': {
                'nocheh-postgres': {'condition': 'service_healthy'}}},
            'nocheh-app': {'depends_on': {
                'nocheh-store-bootstrap': {'condition': 'service_completed_successfully'},
                'inngest-redis': {'condition': 'service_healthy'}}},
            'hermes-runtime': {'depends_on': {
                'nocheh-app': {'condition': 'service_healthy'}}},
            'nocheh-reset-state': {'profiles': ['reset']},
        }}
        self.containers = {}
        self.add('nocheh-postgres', 'b' * 64, 'running')
        self.add('inngest-redis', 'c' * 64, 'running')

    def add(self, service, identifier, state):
        self.containers[identifier] = {
            'id': identifier, 'name': self.project + '-' + service + '-1',
            'image': 'fixture', 'restart_policy': {'Name': 'no', 'MaximumRetryCount': 0},
            'state': state, 'project': self.project, 'service': service,
            'working_dir': self.root, 'config_files': self.files, 'mounts': []}

    def state(self, row):
        exited = row['service'] == 'nocheh-store-bootstrap' and row['state'] == 'exited'
        value = {'Status': row['state'], 'ExitCode': 0 if exited else None}
        if row['service'] != 'nocheh-store-bootstrap':
            value['Health'] = {'Status': 'healthy'}
        return value

    def __call__(self, arguments, _environment):
        if 'config' in arguments and arguments[-3:] == ['config', '--format', 'json']:
            return json.dumps(self.rendered)
        if arguments[:5] == ['docker', 'ps', '-a', '-q', '--no-trunc']:
            return '\n'.join(self.containers) + '\n'
        if arguments[:3] == ['docker', 'inspect', '--format']:
            if arguments[3] == reset_inventory.CONTAINER_FORMAT:
                return '\n'.join(json.dumps(self.containers[value]) for value in arguments[4:]) + '\n'
            return json.dumps(self.state(self.containers[arguments[-1]])) + '\n'
        if 'create' in arguments:
            existing = {row['service'] for row in self.containers.values()}
            for marker, service in zip(('d', 'e', 'f'),
                                       ('nocheh-store-bootstrap', 'nocheh-app', 'hermes-runtime')):
                if service not in existing:
                    self.add(service, marker * 64, 'created')
            return ''
        if arguments[:2] == ['docker', 'update']:
            for identifier in arguments[3:]:
                self.containers[identifier]['restart_policy'] = {'Name': 'no', 'MaximumRetryCount': 0}
            return ''
        if arguments[:2] == ['docker', 'start']:
            identifier = arguments[2]; row = self.containers[identifier]
            self.start_calls.append(row['service'])
            if self.fail_start_once and row['service'] == 'nocheh-app':
                self.fail_start_once = False
                raise RuntimeError('synthetic_acceptance_start_interruption')
            row['state'] = 'exited' if row['service'] == 'nocheh-store-bootstrap' else 'running'
            return ''
        raise AssertionError(arguments)


class ResetAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve(); self.state = self.root / 'state'
        self.state.mkdir(); (self.root / 'memory').mkdir()
        metadata = self.state.stat(); self.project = 'acceptance-fixture'
        self.preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()),
            'executable': False, 'content_copied': False, 'blockers': [],
            'containers': [
                {'id': '1' * 64, 'service': 'nocheh-postgres'},
                {'id': '2' * 64, 'service': 'inngest-redis'},
                {'id': '3' * 64, 'service': 'nocheh-store-bootstrap'},
                {'id': '4' * 64, 'service': 'nocheh-app'},
                {'id': '5' * 64, 'service': 'hermes-runtime'}],
            'volumes': [], 'installation': {'root': str(self.root), 'state': str(self.state),
                'memory_state': str(self.root / 'memory'), 'project': self.project,
                'storage_layout': 'original-only-v1', 'config_path': str(self.state / '.env'),
                'configuration_sha256': 'a' * 64,
                'state_anchor': {'device': metadata.st_dev, 'inode': metadata.st_ino, 'kind': 'directory'}}}
        self.command = ['docker', 'compose', '-f', str(self.root / 'compose.yml'), '-p', self.project]
        self.environment = {'NOCHEH_HONCHO_ENABLED': 'false'}

    def ready(self, journal):
        journal.create(self.preflight, str(uuid.uuid4()))
        initialization = {'format': reset_initialization.FORMAT,
            'reset_id': journal.value['reset_id'], 'stage': reset_initialization.STAGES[-1],
            'resources': {'containers': [
                {'service': 'nocheh-postgres', 'id': 'b' * 64},
                {'service': 'inngest-redis', 'id': 'c' * 64}], 'volumes': []}}
        for index, step in enumerate(reset_protocol.STEPS[:7]):
            evidence = reset_protocol.fingerprint(initialization) if step == 'initialized' else str(index + 1) * 64
            journal.complete(step, evidence)
        telegram = {'binding': '8' * 64, 'state': 'confirmed',
                    'attempted_at': '2026-09-18T00:00:00+00:00',
                    'confirmed_at': '2026-09-18T00:00:01+00:00'}
        journal.save({**journal.value, 'telegram': telegram})
        journal.complete('telegram_boundary', reset_protocol.fingerprint(telegram))
        receipt = {'format': 'nocheh-reset-quiescence-v1', 'reset_id': journal.value['reset_id'],
            'preflight_sha256': journal.value['preflight_sha256'], 'binding_sha256': '9' * 64,
            'fences_absent_at_start': True, 'containers': [
                {'id': row['id'], 'service': row['service'],
                 'state': 'exited' if row['service'] == 'nocheh-store-bootstrap' else 'running',
                 'restart_policy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}}
                for row in self.preflight['containers']]}
        reset_protocol.atomic(journal.directory / 'quiescence.json', receipt, create=True)
        reset_protocol.atomic(journal.directory / 'initialization.json', initialization, create=True)
        reset_quiescence.fence(self.state, journal.value['reset_id'])
        return initialization

    def test_interrupted_start_retries_with_restart_disabled(self):
        fake = FakeDocker(self.root, self.project)
        with reset_protocol.locked(self.state) as journal:
            initialization = self.ready(journal); fake.fail_start_once = True
            with patch.object(reset_acceptance.reset_baseline, 'verify', return_value={'phase': 'empty_baseline'}), \
                 patch.object(reset_acceptance.reset_initialization, 'assert_initialized', return_value=initialization):
                with self.assertRaisesRegex(RuntimeError, 'synthetic_acceptance_start_interruption'):
                    reset_acceptance.activate(journal, self.preflight, runner=fake,
                        environment=self.environment, command=self.command, timeout=0)
                value = reset_protocol.read(journal.directory / 'acceptance-mode.json')
                self.assertEqual(value['stage'], 'fences_release_intent')
                self.assertTrue(all(not (self.state / name).exists() for name in reset_quiescence.FENCES))
                self.assertTrue(all(row['restart_policy']['Name'] == 'no' for row in fake.containers.values()))
                result = reset_acceptance.activate(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command, timeout=0)
                self.assertEqual(result['phase'], 'acceptance_running')
                self.assertFalse(result['restart_ownership']); self.assertFalse(result['fresh_acceptance'])
                self.assertEqual(len(journal.value['steps']), 8)
                self.assertEqual(reset_acceptance.activate(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command, timeout=0), result)
        self.assertEqual(fake.start_calls.count('nocheh-store-bootstrap'), 1)
        self.assertEqual(fake.start_calls.count('nocheh-app'), 2)

    def test_changed_recorded_plan_is_rejected(self):
        fake = FakeDocker(self.root, self.project)
        with reset_protocol.locked(self.state) as journal:
            initialization = self.ready(journal)
            with patch.object(reset_acceptance.reset_baseline, 'verify', return_value={'phase': 'empty_baseline'}), \
                 patch.object(reset_acceptance.reset_initialization, 'assert_initialized', return_value=initialization):
                reset_acceptance.activate(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command, timeout=0)
            path = journal.directory / 'acceptance-mode.json'; value = reset_protocol.read(path)
            value['plan']['desired'].remove('hermes-runtime'); reset_protocol.atomic(path, value)
            with self.assertRaisesRegex(ValueError, 'plan_changed'):
                reset_acceptance.activate(journal, self.preflight, runner=fake,
                    environment=self.environment, command=self.command, timeout=0)


if __name__ == '__main__':
    unittest.main()
