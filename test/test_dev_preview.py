"""Safety checks for the local Compose preview boundary."""

import tempfile
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import dev_preview


class DevPreviewTests(unittest.TestCase):
    def test_rejects_unmarked_existing_state(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            state = root / 'data/dev'
            state.mkdir(parents=True)
            (state / '.env').write_text('POSTGRES_PASSWORD=installation-secret\n')
            with patch.object(dev_preview, 'ROOT', root), patch.object(dev_preview, 'STATE', state), patch.object(dev_preview, 'MARKER', state / '.preview-owner'), patch.object(dev_preview.configuration, 'INSTALLATION_ROOT', root):
                with self.assertRaisesRegex(ValueError, 'no checkout ownership marker'):
                    dev_preview.assert_private_state()

    def test_allows_expected_plugin_links_and_rejects_storage_link(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            state = root / 'data/dev'
            state.mkdir(parents=True)
            (state / '.preview-owner').write_text(str(root) + '\n')
            integration = root / 'integrations/hermes'
            integration.mkdir(parents=True)
            plugin = state / 'hermes/plugins'
            plugin.mkdir(parents=True)
            (plugin / 'nocheh').symlink_to(integration)
            dashboard = state / 'admin/dashboard/home/plugins'
            dashboard.mkdir(parents=True)
            (dashboard / 'nocheh').symlink_to('/workspace/integrations/hermes')
            with patch.object(dev_preview, 'ROOT', root), patch.object(dev_preview, 'STATE', state), patch.object(dev_preview, 'MARKER', state / '.preview-owner'), patch.object(dev_preview.configuration, 'INSTALLATION_ROOT', root):
                dev_preview.assert_private_state()
                (state / 'files').symlink_to(root.parent)
                with self.assertRaisesRegex(ValueError, 'unexpected symlink'):
                    dev_preview.assert_private_state()

    def test_rejects_foreign_project_container(self):
        env = {'PATH': '/usr/bin'}
        foreign = {'Config': {'Labels': {'com.docker.compose.project.working_dir': '/elsewhere', 'com.docker.compose.service': 'nocheh-app'}}}
        with patch.object(dev_preview.subprocess, 'check_output', side_effect=['container-id\n', json.dumps([foreign])]):
            with self.assertRaisesRegex(ValueError, 'owned by another checkout'):
                dev_preview.inspect_project(env)

    def test_rejects_port_owned_by_other_process(self):
        with patch.object(dev_preview, 'port_available', side_effect=lambda port: port != 8783):
            with self.assertRaisesRegex(ValueError, '8783 is in use'):
                dev_preview.assert_ports([])

    def test_rejects_foreign_network(self):
        network = [{'Labels': {'com.docker.compose.project': 'other'}}]
        result = type('Result', (), {'returncode': 0, 'stdout': json.dumps(network)})()
        with patch.object(dev_preview.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'belongs to another project'):
                dev_preview.assert_networks({'PATH': '/usr/bin'})

    def test_shell_credentials_and_profiles_do_not_enter_compose(self):
        with patch.dict('os.environ', {'TELEGRAM_BOT_TOKEN': 'active-token', 'COMPOSE_PROFILES': 'honcho', 'NOCHEH_STATE_DIR': '/active', 'NOCHEH_PORT': '8780'}):
            env = dev_preview.docker_env({'TELEGRAM_ENABLED': 'false', 'TELEGRAM_BOT_TOKEN': ''})
        self.assertEqual(env['TELEGRAM_BOT_TOKEN'], '')
        self.assertEqual(env['COMPOSE_PROFILES'], 'honcho')
        self.assertEqual(env['NOCHEH_STATE_DIR'], str(dev_preview.STATE))
        self.assertEqual(env['NOCHEH_PORT'], '8780')
        self.assertEqual(env['NOCHEH_DASHBOARD_PORT'], '8783')
        self.assertEqual(env['NOCHEH_HONCHO_DATABASE_VOLUME'], 'nocheh-dev_honcho_database')

    def test_normal_services_are_selected_without_builder(self):
        self.assertEqual(dev_preview.PROJECT, 'nocheh-dev')
        self.assertEqual(len(dev_preview.SERVICES), 17)
        self.assertNotIn('nocheh-dev-builder', dev_preview.SERVICES)
        self.assertTrue({'hermes', 'nocheh-security', 'nocheh-executor', 'inngest-server',
                         'cliproxy-api', 'chatgpt-speech', 'honcho-api', 'honcho-deriver',
                         'honcho-provider-gateway', 'honcho-postgres', 'honcho-redis'}
                        .issubset(dev_preview.SERVICES))

    def test_rejects_foreign_fixed_name_volume(self):
        volume = [{'Labels': {'com.nocheh.dev.checkout': '/elsewhere'}}]
        result = type('Result', (), {'returncode': 0, 'stdout': json.dumps(volume)})()
        with patch.object(dev_preview.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'belongs to another checkout'):
                dev_preview.assert_volumes({'PATH': '/usr/bin'})

    def test_refuses_second_running_nocheh_stack(self):
        foreign = {'Config': {'Labels': {'com.docker.compose.project': 'nocheh',
                                         'com.docker.compose.service': 'nocheh-app'}}}
        with patch.object(dev_preview.subprocess, 'check_output', side_effect=['one\n', json.dumps([foreign])]):
            with self.assertRaisesRegex(ValueError, 'Another Nocheh Compose stack'):
                dev_preview.assert_single_running_stack({'PATH': '/usr/bin'})

    def test_refuses_second_stack_with_only_honcho_running(self):
        foreign = {'Config': {'Labels': {'com.docker.compose.project': 'nocheh',
                                         'com.docker.compose.service': 'honcho-api'}}}
        with patch.object(dev_preview.subprocess, 'check_output', side_effect=['one\n', json.dumps([foreign])]):
            with self.assertRaisesRegex(ValueError, 'Another Nocheh Compose stack'):
                dev_preview.assert_single_running_stack({'PATH': '/usr/bin'})

    def test_rejects_unpinned_runtime_base(self):
        result = type('Result', (), {'returncode': 0, 'stdout': 'wrong-revision\n'})()
        with patch.object(dev_preview.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(ValueError, 'wrong.*revision'):
                dev_preview.prepare_runtime_images({'PATH': '/usr/bin'})


if __name__ == '__main__':
    unittest.main()
