import copy
import json
import unittest
from unittest.mock import patch

from scripts import reset_erasure, reset_protocol
from . import test_reset_preservation


class DockerFixture:
    def __init__(self, preflight):
        self.containers = {row['id']: copy.deepcopy(row) for row in preflight['containers']}
        self.volumes = {row['name']: copy.deepcopy(row) for row in preflight['volumes']}
        self.calls = []; self.fail_stop_once = False; self.fail_volume_once = False

    def __call__(self, command, environment):
        self.calls.append(command)
        if environment != {'FIXTURE': 'synthetic'}:
            raise AssertionError('unexpected environment')
        if command == ['docker', 'ps', '-a', '-q', '--no-trunc']:
            return '\n'.join(self.containers)
        if command[:4] == ['docker', 'inspect', '--format', reset_erasure.reset_inventory.CONTAINER_FORMAT]:
            return '\n'.join(json.dumps(self.containers[item]) for item in command[4:] if item in self.containers)
        if command == ['docker', 'volume', 'ls', '-q']:
            return '\n'.join(self.volumes)
        if command[:5] == ['docker', 'volume', 'inspect', '--format', reset_erasure.reset_inventory.VOLUME_FORMAT]:
            return json.dumps(self.volumes[command[-1]])
        if command[:4] == ['docker', 'stop', '--time', '60']:
            for index, identifier in enumerate(command[4:]):
                self.containers[identifier]['state'] = 'exited'
                if self.fail_stop_once and index == 0:
                    self.fail_stop_once = False; raise RuntimeError('fixture stop interruption')
            return ''
        if command[:2] == ['docker', 'rm']:
            for identifier in command[2:]: self.containers.pop(identifier)
            return ''
        if command[:3] == ['docker', 'volume', 'rm']:
            for index, name in enumerate(command[3:]):
                self.volumes.pop(name)
                if self.fail_volume_once and index == 0:
                    self.fail_volume_once = False; raise RuntimeError('fixture volume interruption')
            return ''
        raise AssertionError('unexpected Docker command: ' + repr(command))


class ResetErasureTests(unittest.TestCase):
    def setUp(self):
        self.fixture = test_reset_preservation.ResetPreservationTests('test_complete_gate_is_durable_content_free_and_retryable')
        self.fixture.setUp(); self.addCleanup(self.fixture.doCleanups)
        self.state = self.fixture.state; self.preflight = self.fixture.preflight; self.recovery = self.fixture.recovery
        volume_rows = []
        containers = []
        for index, service in enumerate(('nocheh-db', 'inngest-postgres'), 1):
            volume = {'name': 'fixture-volume-' + str(index), 'created_at': '2026-09-18T00:00:00Z',
                      'driver': 'local', 'options_count': 0, 'project': 'fixture', 'compose_volume': 'database' + str(index),
                      'service': service, 'target': '/var/lib/postgresql/data', 'configured_name': 'fixture-volume-' + str(index),
                      'authority': 'explicit_configuration_and_installation_mount'}
            volume_rows.append(volume)
            containers.append({'id': format(index, '064x'), 'name': 'fixture-' + service,
                'image': 'sha256:' + str(index) * 64, 'project': 'fixture', 'service': service,
                'working_dir': str(self.fixture.root), 'config_files': str(self.fixture.root / 'docker-compose.yml'),
                'mounts': [{'Type': 'volume', 'Name': volume['name'], 'Destination': volume['target'], 'RW': True}],
                'state': 'running', 'restart_policy': {'Name': 'no', 'MaximumRetryCount': 0}})
        containers.append({'id': 'f' * 64, 'name': 'fixture-app', 'image': 'sha256:' + 'f' * 64,
            'project': 'fixture', 'service': 'nocheh-app', 'working_dir': str(self.fixture.root),
            'config_files': str(self.fixture.root / 'docker-compose.yml'),
            'mounts': [{'Type': 'bind', 'Source': str(self.state / 'files'), 'Destination': '/data/files', 'RW': True}],
            'state': 'exited', 'restart_policy': {'Name': 'no', 'MaximumRetryCount': 0}})
        self.preflight['containers'] = containers; self.preflight['volumes'] = volume_rows
        self.docker = DockerFixture(self.preflight)

    def preserve(self, journal):
        self.fixture.ready(journal); return self.fixture.freeze(journal)

    def erase(self, journal):
        return reset_erasure.erase(journal, self.preflight, self.recovery, self.fixture.ownership(),
            inspect=lambda: self.preflight, runner=self.docker, environment={'FIXTURE': 'synthetic'})

    def test_scoped_erasure_removes_content_containers_and_volumes_but_retains_setup(self):
        with reset_protocol.locked(self.state) as journal:
            self.preserve(journal); result = self.erase(journal)
            self.assertEqual(result['phase'], 'erased'); self.assertEqual(result['containers_removed'], 3)
            self.assertEqual(result['volumes_removed'], 2); self.assertEqual(self.docker.containers, {})
            self.assertEqual(self.docker.volumes, {}); self.assertFalse((self.state / 'files').exists())
            self.assertFalse((self.state / 'spool/observation').exists())
            self.assertTrue((self.state / 'spool/.restore-inactive').exists())
            self.assertEqual((self.state / 'hermes/auth.json').read_text(), 'PRIVATE PROVIDER LOGIN')
            self.assertEqual((self.fixture.memory / 'ledger/spend').read_text(), 'RETAINED SPENDING')
            before = (journal.directory / 'erasure.json').read_bytes()
            self.assertEqual(self.erase(journal), result)
            self.assertEqual((journal.directory / 'erasure.json').read_bytes(), before)

    def test_interrupted_file_erasure_resumes_the_same_manifest(self):
        with reset_protocol.locked(self.state) as journal:
            self.preserve(journal); unlink = reset_erasure.reset_files.os.unlink; count = 0
            def interrupted(name, **options):
                nonlocal count
                unlink(name, **options)
                if 'dir_fd' in options:
                    count += 1
                    if count == 1: raise RuntimeError('fixture file interruption')
            with patch('scripts.reset_files.os.unlink', side_effect=interrupted):
                with self.assertRaisesRegex(RuntimeError, 'file interruption'): self.erase(journal)
            self.assertEqual(reset_protocol.read(journal.directory / 'erasure.json')['stage'], 'file_erase_intent')
        with reset_protocol.locked(self.state) as journal:
            self.assertEqual(self.erase(journal)['phase'], 'erased')

    def test_database_stop_and_volume_removal_interruptions_resume_without_maintenance(self):
        self.docker.fail_stop_once = True
        with reset_protocol.locked(self.state) as journal:
            self.preserve(journal)
            with self.assertRaisesRegex(RuntimeError, 'stop interruption'): self.erase(journal)
            self.assertEqual(reset_protocol.read(journal.directory / 'erasure.json')['stage'], 'database_stop_intent')
            self.recovery.assert_maintenance.side_effect = RuntimeError('old database unavailable')
        with reset_protocol.locked(self.state) as journal:
            self.docker.fail_volume_once = True
            with self.assertRaisesRegex(RuntimeError, 'volume interruption'): self.erase(journal)
            self.assertEqual(reset_protocol.read(journal.directory / 'erasure.json')['stage'], 'volume_remove_intent')
        with reset_protocol.locked(self.state) as journal:
            self.assertEqual(self.erase(journal)['phase'], 'erased')

    def test_recreated_volume_and_foreign_mount_fail_closed(self):
        with reset_protocol.locked(self.state) as journal:
            self.preserve(journal)
            foreign = {'id': 'e' * 64, 'name': 'foreign', 'image': 'sha256:' + 'e' * 64,
                'project': 'foreign', 'service': 'writer', 'working_dir': '/foreign', 'config_files': '/foreign/compose.yml',
                'mounts': [{'Type': 'volume', 'Name': self.preflight['volumes'][0]['name'], 'Destination': '/data', 'RW': True}],
                'state': 'exited', 'restart_policy': {'Name': 'no', 'MaximumRetryCount': 0}}
            self.docker.containers[foreign['id']] = foreign
            with self.assertRaisesRegex(RuntimeError, 'foreign_volume_reference'): self.erase(journal)
            self.assertTrue((self.state / 'files/original').exists()); self.docker.containers.pop(foreign['id'])
            self.docker.fail_volume_once = True
            with self.assertRaisesRegex(RuntimeError, 'volume interruption'): self.erase(journal)
            removed = self.preflight['volumes'][0]; replacement = {**removed, 'created_at': '2026-09-19T00:00:00Z'}
            self.docker.volumes[removed['name']] = replacement
        with reset_protocol.locked(self.state) as journal:
            with self.assertRaisesRegex(RuntimeError, 'volume_changed'): self.erase(journal)
            self.assertIn(removed['name'], self.docker.volumes)

    def test_foreign_writable_bind_fails_before_deletion(self):
        with reset_protocol.locked(self.state) as journal:
            self.preserve(journal)
            foreign = {'id': 'd' * 64, 'name': 'foreign-writer', 'image': 'sha256:' + 'd' * 64,
                'project': 'foreign', 'service': 'writer', 'working_dir': '/foreign',
                'config_files': '/foreign/compose.yml',
                'mounts': [{'Type': 'bind', 'Source': str(self.state / 'files'),
                            'Destination': '/data', 'RW': True}],
                'state': 'exited', 'restart_policy': {'Name': 'no', 'MaximumRetryCount': 0}}
            self.docker.containers[foreign['id']] = foreign
            with self.assertRaisesRegex(RuntimeError, 'foreign_state_writer'):
                self.erase(journal)
            self.assertTrue((self.state / 'files/original').exists())

    def test_changed_preservation_receipt_blocks_before_deletion(self):
        with reset_protocol.locked(self.state) as journal:
            self.preserve(journal); path = journal.directory / 'files.json'; value = json.loads(path.read_text())
            value['manifest_sha256'] = '0' * 64; path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, 'artifact_changed'):
                self.erase(journal)
            self.assertTrue((self.state / 'files/original').exists())

    def test_changed_component_receipt_shape_blocks_before_deletion(self):
        with reset_protocol.locked(self.state) as journal:
            self.preserve(journal); path = journal.directory / 'configuration.json'
            value = json.loads(path.read_text()); value['unbound'] = True; path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, 'artifact_changed'):
                self.erase(journal)
            self.assertTrue((self.state / 'files/original').exists())

    def test_changed_erasure_receipt_blocks_before_deletion(self):
        with reset_protocol.locked(self.state) as journal:
            self.preserve(journal)
            path, _ = reset_erasure._record(journal, self.preflight, reset_erasure.reset_preservation.assert_frozen(journal, self.preflight))
            value = json.loads(path.read_text()); value['file_entries'] += 1; path.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, 'receipt_changed'):
                self.erase(journal)
            self.assertTrue((self.state / 'files/original').exists())


if __name__ == '__main__': unittest.main()
