"""Live development must fail closed before touching operating state."""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.development import live_dev
from tools.operations.installation import configuration


class LiveDevTests(unittest.TestCase):
    def values(self):
        return {**configuration.DEFAULTS,
                'POSTGRES_PASSWORD': 'a' * 32, 'SERVICE_TOKEN': 'b' * 32,
                'NOCHEH_ARCHIVE_PASSWORD': 'c' * 64,
                'NOCHEH_DERIVED_PASSWORD': 'd' * 64,
                'NOCHEH_CONTROL_PASSWORD': 'e' * 64,
                'INNGEST_POSTGRES_PASSWORD': 'f' * 64,
                'INNGEST_EVENT_KEY': '1' * 64,
                'INNGEST_SIGNING_KEY': '2' * 64,
                'NOCHEH_STORAGE_LAYOUT': 'original-only-v1',
                'TELEGRAM_ENABLED': 'true', 'TELEGRAM_BOT_TOKEN': 'synthetic-token',
                'TELEGRAM_OWNER_ID': '12345', 'NOCHEH_HONCHO_ENABLED': 'true',
                'NOCHEH_HONCHO_STATE_DIR': '/synthetic/honcho',
                'NOCHEH_HONCHO_DATABASE_VOLUME': 'synthetic-honcho-db',
                'NOCHEH_HONCHO_REDIS_VOLUME': 'synthetic-honcho-redis'}

    def test_operating_config_requires_live_telegram_and_retained_honcho(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'data/local').mkdir(parents=True)
            values = self.values()
            configuration.write_env(root / '.env', values)
            self.assertEqual(live_dev.operating_config(root)['TELEGRAM_ENABLED'], 'true')
            values['TELEGRAM_ENABLED'] = 'false'
            configuration.write_env(root / '.env', values)
            with self.assertRaisesRegex(ValueError, 'Telegram must be enabled'):
                live_dev.operating_config(root)
            values['TELEGRAM_ENABLED'] = 'true'
            values['NOCHEH_HONCHO_DATABASE_VOLUME'] = ''
            configuration.write_env(root / '.env', values)
            with self.assertRaisesRegex(ValueError, 'volume identities are required'):
                live_dev.operating_config(root)

    def test_main_checkout_must_have_one_operating_env(self):
        with tempfile.TemporaryDirectory() as folder:
            main = Path(folder) / 'main'
            main.mkdir()
            (main / '.env').write_text('synthetic')
            output = f'worktree {main}\nHEAD abc\nbranch refs/heads/main\n'
            with patch.object(live_dev.subprocess, 'check_output', return_value=output):
                self.assertEqual(live_dev.operating_root(), main.resolve())
            with patch.object(live_dev.subprocess, 'check_output', return_value='worktree /other\nHEAD abc\nbranch refs/heads/topic\n'):
                with self.assertRaisesRegex(ValueError, 'one operating main checkout'):
                    live_dev.operating_root()

    def test_running_operating_stack_requires_stop_before_dev(self):
        production = {'State': {'Running': True},
                      'Config': {'Labels': {'com.docker.compose.project': 'nocheh',
                                            'com.docker.compose.service': 'nocheh-app'}}}
        with patch.object(live_dev.subprocess, 'check_output', side_effect=['one\n', json.dumps([production])]):
            with self.assertRaisesRegex(ValueError, 'unattended operating stack is running'):
                live_dev.assert_only_development_running([production], {'PATH': '/usr/bin'})
        production['Config']['Labels']['com.nocheh.runtime-mode'] = 'source-watched'
        with patch.object(live_dev.subprocess, 'check_output', side_effect=['one\n', json.dumps([production])]):
            live_dev.assert_only_development_running([production], {'PATH': '/usr/bin'})

    def test_partial_development_stack_can_be_stopped(self):
        database = {'State': {'Running': True},
                    'Config': {'Labels': {'com.docker.compose.project': 'nocheh',
                                          'com.docker.compose.service': 'nocheh-db'}}}
        app = {'State': {'Running': False},
               'Config': {'Labels': {'com.docker.compose.project': 'nocheh',
                                     'com.docker.compose.service': 'nocheh-app',
                                     'com.nocheh.runtime-mode': 'source-watched'}}}
        with patch.object(live_dev.subprocess, 'check_output', side_effect=['one\n', json.dumps([database])]):
            live_dev.assert_only_development_running([database, app], {'PATH': '/usr/bin'})

    def test_second_nocheh_project_is_rejected(self):
        isolated = {'State': {'Running': True},
                    'Config': {'Labels': {'com.docker.compose.project': 'nocheh-dev',
                                          'com.docker.compose.service': 'nocheh-app'}}}
        with patch.object(live_dev.subprocess, 'check_output', side_effect=['one\n', json.dumps([isolated])]):
            with self.assertRaisesRegex(ValueError, 'Another Nocheh stack'):
                live_dev.assert_only_development_running([], {'PATH': '/usr/bin'})

    def test_missing_or_foreign_operating_database_volume_is_rejected(self):
        env = self.values()
        with patch.object(live_dev.subprocess, 'run', return_value=type('Result', (), {'returncode': 1})()):
            with self.assertRaisesRegex(ValueError, 'Missing operating volume'):
                live_dev.assert_operating_volumes(env)
        foreign = [{'Labels': {'com.docker.compose.project': 'other',
                               'com.docker.compose.volume': 'postgres_data'}}]
        result = type('Result', (), {'returncode': 0, 'stdout': json.dumps(foreign)})()
        with patch.object(live_dev.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'unexpected ownership'):
                live_dev.assert_operating_volumes(env)

    def test_compose_mount_check_rejects_wrong_volume(self):
        env = self.values()
        env['NOCHEH_STATE_DIR'] = '/synthetic/state'
        env['NOCHEH_INSTALLATION_ROOT'] = '/synthetic/root'
        rendered = {'name': 'nocheh',
                    'volumes': {'postgres_data': {'name': 'wrong', 'external': True},
                                'honcho_database': {'name': 'synthetic-honcho-db', 'external': True},
                                'honcho_redis': {'name': 'synthetic-honcho-redis', 'external': True}},
                    'services': {'nocheh-db': {'volumes': []}}}
        with patch.object(live_dev.subprocess, 'check_output', return_value=json.dumps(rendered)):
            with self.assertRaisesRegex(ValueError, 'operating volumes'):
                live_dev.assert_compose_mounts(['docker', 'compose'], env)

    def test_compose_mount_check_rejects_gateway_parent_mount(self):
        env = self.values()
        env['NOCHEH_STATE_DIR'] = '/synthetic/state'
        env['NOCHEH_INSTALLATION_ROOT'] = '/synthetic/root'
        def mounts(items):
            return [{'source': source, 'target': target} for target, source in items.items()]
        rendered = {'name': 'nocheh',
                    'volumes': {'postgres_data': {'name': 'nocheh_postgres_data', 'external': True},
                                'honcho_database': {'name': 'synthetic-honcho-db', 'external': True},
                                'honcho_redis': {'name': 'synthetic-honcho-redis', 'external': True}},
                    'services': {
                        'nocheh-db': {'volumes': mounts({'/var/lib/postgresql/data': 'postgres_data'})},
                        'honcho-postgres': {'volumes': mounts({'/var/lib/postgresql/data': 'honcho_database'})},
                        'nocheh-app': {'volumes': mounts({'/data/files': '/synthetic/state/files',
                                                          '/app/src': str(live_dev.ROOT / 'src')})},
                        'hermes': {'volumes': mounts({'/workspace/data/local/hermes': '/synthetic/state/hermes'}),
                                   'environment': {'TELEGRAM_ENABLED': 'true',
                                                   'HOME': '/workspace/data/local/hermes'}},
                        'cliproxy-api': {'volumes': mounts({'/auth': '/synthetic/state/provider/auth'})},
                        'honcho-api': {'volumes': mounts({'/nocheh': str(live_dev.ROOT / 'services/honcho')})},
                        'honcho-provider-gateway': {'volumes': mounts({
                            '/workspace-honcho': str(live_dev.ROOT / 'services/honcho'),
                            '/workspace-provider': str(live_dev.ROOT / 'tools/operations/provider')})}}}
        with patch.object(live_dev.subprocess, 'check_output', side_effect=lambda *_, **__: json.dumps(rendered)):
            live_dev.assert_compose_mounts(['docker', 'compose'], env)
            rendered['services']['honcho-provider-gateway']['volumes'].append(
                {'source': str(live_dev.ROOT / 'services/honcho'), 'target': '/nocheh'})
            with self.assertRaisesRegex(ValueError, 'approved paths'):
                live_dev.assert_compose_mounts(['docker', 'compose'], env)
            rendered['services']['honcho-provider-gateway']['volumes'].pop()
            rendered['services']['hermes']['environment']['HOME'] = '/'
            with self.assertRaisesRegex(ValueError, 'writable home'):
                live_dev.assert_compose_mounts(['docker', 'compose'], env)

    def test_existing_images_start_without_rebuild(self):
        present = type('Result', (), {'returncode': 0})()
        missing = type('Result', (), {'returncode': 1})()
        with patch.object(live_dev.subprocess, 'run', return_value=present):
            self.assertFalse(live_dev.build_needed({'PATH': '/usr/bin'}))
        with patch.object(live_dev.subprocess, 'run', side_effect=[present, missing]):
            self.assertTrue(live_dev.build_needed({'PATH': '/usr/bin'}))
        with patch.dict('os.environ', {'NOCHEH_DEV_BUILD': '1'}):
            self.assertTrue(live_dev.build_needed({'PATH': '/usr/bin'}))


if __name__ == '__main__':
    unittest.main()
