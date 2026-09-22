import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import reset_inventory as inventory


class ResetInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.state = self.root / 'data/local'; self.memory = self.root / 'data/honcho'
        self.state.mkdir(parents=True); self.memory.mkdir()
        self.config = self.root / '.env'; self.config.write_text('SYNTHETIC_CREDENTIAL_NOT_FOR_MANIFEST')
        for relative in ('files', 'spool', 'hermes/profiles', 'provider/auth', 'provider/monitor', 'admin/restores', 'admin/reset'):
            (self.state / relative).mkdir(parents=True)
        (self.state / 'hermes/auth.json').write_text('LOGIN_MUST_NOT_BE_READ_OR_COPIED')
        (self.state / 'files/original.bin').write_bytes(b'PRIVATE_ORIGINAL_MUST_NOT_BE_COPIED')
        (self.state / 'provider/monitor/usage.sqlite').write_bytes(b'ACCOUNTING_NOT_TOUCHED')
        (self.state / 'admin/applied.json').write_text('STALE_REVISION_MUST_NOT_BE_COPIED')
        (self.state / 'admin/settings.lock').touch()
        (self.memory / 'ledger').mkdir()
        (self.root / 'data/backups').mkdir()
        self.values = {'NOCHEH_STORAGE_LAYOUT': 'legacy', 'NOCHEH_HONCHO_ENABLED': 'true', 'SERVICE_TOKEN': 'SECRET_NEVER_SERIALIZED'}
        self.environment = {'NOCHEH_HONCHO_STATE_DIR': str(self.memory)}
        self.command = ['docker', 'compose', '-f', str(self.root / 'docker-compose.yml')]
        self.rendered = {'name': 'nocheh-fixture', 'services': {}, 'volumes': {}, 'secret_config': 'DO_NOT_SERIALIZE_RENDERED_CONFIG'}
        self.containers = []; self.volumes = {}
        for index, (service, target) in enumerate(inventory.VOLUME_TARGETS.items()):
            logical = 'volume' + str(index); name = 'fixture-' + logical
            self.rendered['volumes'][logical] = {'name': name}
            self.rendered['services'][service] = {'volumes': [{'type': 'volume', 'source': logical, 'target': target}]}
            self.containers.append({'id': str(index) * 64, 'name': service, 'image': 'sha256:' + 'a' * 64,
                'project': 'nocheh-fixture', 'service': service, 'state': 'running', 'working_dir': str(self.root),
                'config_files': str(self.root / 'docker-compose.yml'),
                'mounts': [{'Type': 'volume', 'Name': name, 'Destination': target, 'RW': True}]})
            # Adopted native volumes can have historical Compose labels; explicit
            # current configuration plus exclusive current mounts establish scope.
            self.volumes[name] = {'name': name, 'created_at': '2026-09-18T00:00:00Z', 'driver': 'local', 'options_count': 0, 'project': 'old-native-project'}
        self.calls = []
        for name, result in (('load', self.values), ('compose_environment', self.environment),
                             ('compose_command', self.command), ('env_path', self.config)):
            mocked = patch.object(inventory, name, return_value=result)
            mocked.start(); self.addCleanup(mocked.stop)

    def runner(self, arguments, environment):
        self.calls.append(arguments)
        if arguments == self.command + ['config', '--format', 'json']:
            return json.dumps(self.rendered)
        if arguments == ['docker', 'ps', '-a', '-q', '--no-trunc']:
            return '\n'.join(item['id'] for item in self.containers)
        if arguments[:4] == ['docker', 'inspect', '--format', inventory.CONTAINER_FORMAT]:
            return '\n'.join(json.dumps(item) for item in self.containers if item['id'] in arguments[4:])
        if arguments[:5] == ['docker', 'volume', 'inspect', '--format', inventory.VOLUME_FORMAT]:
            return json.dumps(self.volumes[arguments[-1]])
        raise AssertionError('unexpected or mutating command')

    def inspect(self):
        return inventory.inspect(self.state, root=self.root, runner=self.runner)

    def test_exact_inventory_has_no_content_or_credentials_and_is_not_executable(self):
        before = {str(path): path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        manifest = self.inspect()
        self.assertFalse(manifest['executable']); self.assertFalse(manifest['content_copied'])
        self.assertEqual(manifest['blockers'], [])
        self.assertEqual(len(manifest['volumes']), 4)
        text = json.dumps(manifest)
        for forbidden in ('SECRET_NEVER_SERIALIZED', 'DO_NOT_SERIALIZE', 'LOGIN_MUST', 'PRIVATE_ORIGINAL', 'ACCOUNTING_NOT_TOUCHED', 'STALE_REVISION_MUST_NOT_BE_COPIED'):
            self.assertNotIn(forbidden, text)
        actions = {item['path']: item['action'] for item in manifest['paths']}
        self.assertEqual(actions[str(self.state / 'files')], 'erase')
        self.assertEqual(actions[str(self.state / 'hermes/auth.json')], 'preserve')
        self.assertEqual(actions[str(self.state / 'hermes/profiles')], 'snapshot_preferences_then_erase')
        self.assertEqual(actions[str(self.state / 'provider/monitor/usage.sqlite')], 'sanitize_accounting')
        self.assertEqual(actions[str(self.memory / 'ledger')], 'preserve')
        self.assertEqual(actions[str(self.state / 'admin/restores')], 'review_restore')
        self.assertEqual(actions[str(self.state / 'admin/applied.json')], 'erase')
        self.assertEqual(actions[str(self.state / 'admin/settings.lock')], 'preserve')
        self.assertEqual(manifest['external_archives'][0]['action'], 'review_archive')
        self.assertIn('settle_external_effects', manifest['pending'])
        self.assertEqual(before, {str(path): path.read_bytes() for path in self.root.rglob('*') if path.is_file()})

    def test_stopped_foreign_container_and_parent_state_mount_are_ownership_conflicts(self):
        foreign = {'id': 'f' * 64, 'project': 'unrelated', 'state': 'exited',
                   'mounts': [{'Type': 'volume', 'Name': 'fixture-volume0'}, {'Type': 'bind', 'Source': str(self.root), 'RW': True}]}
        self.containers.append(foreign)
        codes = {item['code'] for item in self.inspect()['blockers']}
        self.assertIn('volume_has_another_container_owner', codes)
        self.assertIn('state_has_another_writer', codes)
        self.assertNotIn(foreign, self.inspect()['containers'])

    def test_changed_configuration_and_mount_identity_cannot_grant_volume_ownership(self):
        self.containers[0]['working_dir'] = str(self.root / 'another-installation')
        self.containers[1]['mounts'][0]['Name'] = 'another-database'
        manifest = self.inspect(); codes = {item['code'] for item in manifest['blockers']}
        self.assertIn('container_installation_binding_changed', codes)
        self.assertIn('database_volume_binding_changed', codes)
        self.assertNotIn('another-database', [item['name'] for item in manifest['volumes']])

    def test_unknown_paths_and_external_volume_options_require_review(self):
        (self.state / 'unknown-state').mkdir()
        self.volumes['fixture-volume0']['options_count'] = 1
        codes = {item['code'] for item in self.inspect()['blockers']}
        self.assertIn('unclassified_state_path', codes)
        self.assertIn('external_volume_driver_requires_review', codes)

    def test_symlink_anchors_and_overlapping_memory_roots_are_rejected(self):
        linked = self.root / 'linked-state'; linked.symlink_to(self.state, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'state_symlink'):
            inventory.inspect(linked, root=self.root, runner=self.runner)
        self.environment['NOCHEH_HONCHO_STATE_DIR'] = str(self.root)
        with self.assertRaisesRegex(ValueError, 'memory_state_overlap'):
            self.inspect()
        self.environment['NOCHEH_HONCHO_STATE_DIR'] = str(self.memory)
        auth = self.state / 'hermes/auth.json'; auth.unlink(); auth.symlink_to(self.config)
        self.assertIn('preserved_or_transformed_path_symlink', {item['code'] for item in self.inspect()['blockers']})

    def test_private_manifest_is_exclusive_durable_and_credential_free(self):
        manifest = self.inspect(); path = self.root / 'review/manifest.json'
        result = inventory.write_manifest(path, manifest)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(result['executable'])
        self.assertEqual(json.loads(path.read_text()), manifest)
        with self.assertRaises(FileExistsError):
            inventory.write_manifest(path, manifest)
        self.assertNotIn('SECRET_NEVER_SERIALIZED', path.read_text())

    def test_inactive_memory_stores_are_still_included_when_present_in_composition(self):
        self.values['NOCHEH_HONCHO_ENABLED'] = 'false'
        self.assertEqual(len(self.inspect()['volumes']), 4)

    def test_docker_mount_order_does_not_change_container_identity(self):
        self.containers[0]['mounts'].append({
            'Type': 'bind', 'Source': str(self.state / 'files'),
            'Destination': '/data/files', 'RW': False})
        first = self.inspect()['containers']
        for row in self.containers:
            row['mounts'].reverse()
        second = self.inspect()['containers']
        self.assertEqual(first, second)


if __name__ == '__main__':
    unittest.main()
