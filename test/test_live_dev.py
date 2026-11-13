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

    def test_fresh_setup_is_ready_for_live_development_once_telegram_is_on(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            state = root / 'data/local'
            with patch.object(configuration, 'INSTALLATION_ROOT', root), \
                    patch.object(configuration, 'DEFAULT_STATE', state):
                configuration.initialize(state)
            values = configuration.read_env(root / '.env')
            values.update(TELEGRAM_ENABLED='true', TELEGRAM_BOT_TOKEN='synthetic-token',
                          TELEGRAM_OWNER_ID='12345')
            configuration.write_env(root / '.env', values)
            operating = live_dev.operating_config(root)
            self.assertEqual(operating['NOCHEH_HONCHO_STATE_DIR'], str(state / 'honcho'))
            self.assertEqual((operating['NOCHEH_HONCHO_DATABASE_VOLUME'],
                              operating['NOCHEH_HONCHO_REDIS_VOLUME']),
                             ('nocheh_honcho_database', 'nocheh_honcho_redis'))
            # A saved folder, as `honcho runtime-up` writes it, is used as saved.
            values['NOCHEH_HONCHO_STATE_DIR'] = '/synthetic/memory'
            configuration.write_env(root / '.env', values)
            self.assertEqual(live_dev.operating_config(root)['NOCHEH_HONCHO_STATE_DIR'], '/synthetic/memory')

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

    def test_another_workspace_may_run_but_never_a_second_poller_of_the_bot(self):
        def bot(labels):
            return {'State': {'Running': True},
                    'Config': {'Labels': {'com.docker.compose.project': 'nocheh-acme',
                                          'com.docker.compose.service': 'nocheh-telegram', **labels}}}
        def check(other):
            with patch.object(live_dev.subprocess, 'check_output', side_effect=['one\n', json.dumps([other])]):
                live_dev.assert_only_development_running([], {'PATH': '/usr/bin'}, '1000001')
        # Another workspace with its own bot runs beside development (ADR-0245).
        check(bot({'com.nocheh.bot-id': '1000002'}))
        # A workspace with Telegram off, or with no bot yet, polls nothing.
        check(bot({'com.nocheh.bot-id': ''}))
        app = bot({}); app['Config']['Labels']['com.docker.compose.service'] = 'nocheh-app'
        check(app)
        # The same bot, or a bot started before the label, would be a second poller.
        for labels in ({'com.nocheh.bot-id': '1000001'}, {}, {'com.nocheh.bot-id': 'unknown'}):
            with self.assertRaisesRegex(ValueError, 'Another Nocheh stack'):
                check(bot(labels))

    def test_only_idle_fixture_networks_are_released_before_dev(self):
        def network(name, project, containers):
            return {'Name': name, 'Labels': {'com.docker.compose.project': project}, 'Containers': containers}
        networks = [network('nocheh-installation-0123456789ab_internal', 'nocheh-installation-0123456789ab', {}),
                    network('nocheh-installation-ba9876543210_internal', 'nocheh-installation-ba9876543210', {'c': {}}),
                    network('nocheh_default', 'nocheh', {}),
                    network('other_default', 'other', {})]
        with patch.object(live_dev.subprocess, 'check_output', side_effect=['a\nb\nc\nd\n', json.dumps(networks)]), \
                patch.object(live_dev.subprocess, 'run') as run:
            released = live_dev.release_idle_fixture_networks({'PATH': '/usr/bin'})
        self.assertEqual(released, ['nocheh-installation-0123456789ab_internal'])
        self.assertEqual(run.call_args.args[0], ['docker', 'network', 'rm', 'nocheh-installation-0123456789ab_internal'])

    def test_clean_volumes_are_created_but_foreign_ownership_is_rejected(self):
        env = self.values()
        with patch.object(live_dev.subprocess, 'run', return_value=type('Result', (), {'returncode': 1, 'stderr': 'No such volume'})()):
            live_dev.assert_operating_volumes(env)
        foreign = [{'Labels': {'com.docker.compose.project': 'other',
                               'com.docker.compose.volume': 'postgres_data'}}]
        result = type('Result', (), {'returncode': 0, 'stdout': json.dumps(foreign)})()
        with patch.object(live_dev.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'unexpected ownership'):
                live_dev.assert_operating_volumes(env)

    def test_volume_inspection_error_does_not_authorize_creation(self):
        result = type('Result', (), {'returncode': 1, 'stderr': 'Cannot connect to Docker'})()
        with patch.object(live_dev.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'Unable to inspect'):
                live_dev.assert_operating_volumes(self.values())

    def test_compose_mount_check_rejects_wrong_volume(self):
        env = self.values()
        env['NOCHEH_STATE_DIR'] = '/synthetic/state'
        env['NOCHEH_INSTALLATION_ROOT'] = '/synthetic/root'
        rendered = {'name': 'nocheh',
                    'volumes': {'postgres_data': {'name': 'wrong', 'external': False},
                                'honcho_database': {'name': 'synthetic-honcho-db', 'external': False},
                                'honcho_redis': {'name': 'synthetic-honcho-redis', 'external': False}},
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
                    'volumes': {'postgres_data': {'name': 'nocheh_postgres_data', 'external': False},
                                'honcho_database': {'name': 'synthetic-honcho-db', 'external': False},
                                'honcho_redis': {'name': 'synthetic-honcho-redis', 'external': False}},
                    'services': {
                        'nocheh-db': {'volumes': mounts({'/var/lib/postgresql/data': 'postgres_data'})},
                        'honcho-postgres': {'volumes': mounts({'/var/lib/postgresql/data': 'honcho_database'})},
                        'nocheh-app': {'volumes': mounts({'/data/files': '/synthetic/state/files',
                                                          '/app/src': str(live_dev.ROOT / 'src')})},
                        'hermes': {'volumes': mounts({'/workspace/data/local/hermes': '/synthetic/state/hermes'}),
                                   'environment': {'HOME': '/workspace/data/local/hermes'}},
                        'nocheh-telegram': {'volumes': mounts({'/telegram-state': '/synthetic/state/telegram'}),
                                            'environment': {'TELEGRAM_ENABLED': 'true'}},
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
            rendered['services']['hermes']['environment']['HOME'] = '/workspace/data/local/hermes'
            # The poller is nocheh-telegram: Telegram on in Hermes alone is not enough.
            rendered['services']['hermes']['environment']['TELEGRAM_ENABLED'] = 'true'
            rendered['services']['nocheh-telegram']['environment']['TELEGRAM_ENABLED'] = 'false'
            with self.assertRaisesRegex(ValueError, 'Telegram'):
                live_dev.assert_compose_mounts(['docker', 'compose'], env)
            rendered['services']['nocheh-telegram']['environment']['TELEGRAM_ENABLED'] = 'true'
            rendered['services']['nocheh-telegram']['volumes'] = mounts({'/telegram-state': '/synthetic/state/hermes'})
            with self.assertRaisesRegex(ValueError, 'writable home'):
                live_dev.assert_compose_mounts(['docker', 'compose'], env)

    def test_root_development_override_and_operating_compose(self):
        root = Path('/synthetic/operating')
        command = live_dev.command(root)
        self.assertEqual(command[-4:], ['-f', str(live_dev.ROOT / 'docker-compose.dev.yml'), '-p', 'nocheh'])
        self.assertIn(str(live_dev.ROOT / 'docker-compose.yml'), command)
        self.assertIn(str(root), command)

    def test_development_services_come_back_after_docker_restarts(self):
        # A Mac or Docker restart must not leave the operating bot down; make dev-stop still stops it.
        policies, service = {}, None
        for line in (live_dev.ROOT / 'docker-compose.dev.yml').read_text().splitlines():
            if line.startswith('  ') and not line.startswith('   ') and line.rstrip().endswith(':'):
                service = line.strip()[:-1]
            elif line.strip().startswith('restart:'):
                policies[service] = line.split(':', 1)[1].strip()
        self.assertLessEqual({'hermes', 'nocheh-telegram'}, set(policies))
        self.assertEqual({name for name, policy in policies.items() if policy != 'unless-stopped'}, set())

    def test_a_brain_edit_never_restarts_the_telegram_poller(self):
        lines = (live_dev.ROOT / 'docker-compose.dev.yml').read_text().splitlines()
        start = lines.index('  nocheh-telegram:') + 1
        end = next(index for index in range(start, len(lines)) if lines[index].startswith('  ') and not lines[index].startswith('   '))
        command = next(line for line in lines[start:end] if line.strip().startswith('command:'))
        self.assertIn('/workspace/services/telegram,', command)
        self.assertNotIn('/workspace/services/hermes', command)
        self.assertIn('services.telegram.server', command)

    def test_rejects_occupied_development_port(self):
        with patch.object(live_dev, 'port_available', side_effect=lambda port: port != 8783), patch.object(live_dev.time, 'sleep'):
            with self.assertRaisesRegex(ValueError, '8783 is in use'):
                live_dev.assert_ports([])

    def test_waits_for_a_just_released_development_port(self):
        probes = []
        def available(port):
            probes.append(port)
            return port != 8783 or probes.count(8783) > 2
        with patch.object(live_dev, 'port_available', side_effect=available), patch.object(live_dev.time, 'sleep') as sleep:
            live_dev.assert_ports([])
        self.assertEqual(probes.count(8783), 3)
        self.assertEqual(sleep.call_count, 2)

    def runtime_images(self, revisions):
        """Fake Docker with image revisions keyed by tag; a build moves them to the pins."""
        pins = json.loads((live_dev.ROOT / 'deploy/upstreams.lock.json').read_text())['hermes']['revision']
        calls = []
        def run(arguments, **_):
            calls.append(arguments)
            if arguments[-1] == 'build':
                revisions.update(revisions.pop('after_build', {}))
                return type('Result', (), {'returncode': 0, 'stdout': ''})()
            if arguments[:3] == ['docker', 'image', 'inspect']:
                tag = arguments[-1]
                found = tag in revisions
                return type('Result', (), {'returncode': 0 if found else 1, 'stdout': (revisions.get(tag) or '') + '\n'})()
            return type('Result', (), {'returncode': 0, 'stdout': ''})()
        return pins, calls, run

    def test_moved_pin_builds_pinned_images_and_replaces_development_tags(self):
        honcho = 'nocheh-honcho:' + json.loads((live_dev.ROOT / 'services/honcho/upstreams.lock.json').read_text())['honcho']['revision'][:8]
        revisions = {'nocheh-hermes:local': 'old-revision', live_dev.DEV_IMAGES + ':hermes-base': 'old-revision'}
        pins, calls, run = self.runtime_images(revisions)
        revisions['after_build'] = {'nocheh-hermes:local': pins, honcho: ''}
        with patch.object(live_dev.subprocess, 'run', side_effect=run):
            live_dev.prepare_runtime_images({'PATH': '/usr/bin'}, Path('/synthetic/operating'))
        self.assertIn(['/synthetic/operating/bin/nocheh', 'build'], calls)
        self.assertIn(['docker', 'tag', 'nocheh-hermes:local', live_dev.DEV_IMAGES + ':hermes-base'], calls)
        self.assertIn(['docker', 'tag', honcho, live_dev.DEV_IMAGES + ':honcho'], calls)

    def test_current_pinned_images_start_without_building(self):
        honcho = 'nocheh-honcho:' + json.loads((live_dev.ROOT / 'services/honcho/upstreams.lock.json').read_text())['honcho']['revision'][:8]
        revisions = {}
        pins, calls, run = self.runtime_images(revisions)
        revisions.update({'nocheh-hermes:local': pins, honcho: ''})
        with patch.object(live_dev.subprocess, 'run', side_effect=run):
            live_dev.prepare_runtime_images({'PATH': '/usr/bin'}, Path('/synthetic/operating'))
        self.assertNotIn(['/synthetic/operating/bin/nocheh', 'build'], calls)

    def test_a_pinned_image_missing_a_library_is_rebuilt(self):
        honcho = 'nocheh-honcho:' + json.loads((live_dev.ROOT / 'services/honcho/upstreams.lock.json').read_text())['honcho']['revision'][:8]
        revisions = {}
        pins, calls, run = self.runtime_images(revisions)
        revisions.update({'nocheh-hermes:local': pins, honcho: ''})
        def checked(arguments, **options):
            if arguments[:2] == ['docker', 'run']:
                calls.append(arguments)
                built = ['/synthetic/operating/bin/nocheh', 'build'] in calls
                return type('Result', (), {'returncode': 0 if built or 'anthropic' not in arguments[-1] else 1})()
            return run(arguments, **options)
        with patch.object(live_dev.subprocess, 'run', side_effect=checked):
            live_dev.prepare_runtime_images({'PATH': '/usr/bin'}, Path('/synthetic/operating'))
        self.assertIn(['/synthetic/operating/bin/nocheh', 'build'], calls)
        checks = [arguments[-1] for arguments in calls if arguments[:2] == ['docker', 'run']]
        self.assertTrue(any('import' in check and 'anthropic' in check for check in checks))

    def test_rejects_a_runtime_base_still_unpinned_after_building(self):
        revisions = {'nocheh-hermes:local': 'wrong-revision', 'after_build': {}}
        _, calls, run = self.runtime_images(revisions)
        with patch.object(live_dev.subprocess, 'run', side_effect=run):
            with self.assertRaisesRegex(ValueError, 'wrong revision after ./bin/nocheh build'):
                live_dev.prepare_runtime_images({'PATH': '/usr/bin'}, Path('/synthetic/operating'))
        self.assertFalse(any(arguments[:2] == ['docker', 'tag'] for arguments in calls))

    def test_existing_images_start_without_rebuild(self):
        present = type('Result', (), {'returncode': 0})()
        missing = type('Result', (), {'returncode': 1, 'stderr': 'No such volume'})()
        with patch.object(live_dev.subprocess, 'run', return_value=present):
            self.assertFalse(live_dev.build_needed({'PATH': '/usr/bin'}))
        with patch.object(live_dev.subprocess, 'run', side_effect=[present, missing]):
            self.assertTrue(live_dev.build_needed({'PATH': '/usr/bin'}))
        with patch.dict('os.environ', {'NOCHEH_DEV_BUILD': '1'}):
            self.assertTrue(live_dev.build_needed({'PATH': '/usr/bin'}))


if __name__ == '__main__':
    unittest.main()
