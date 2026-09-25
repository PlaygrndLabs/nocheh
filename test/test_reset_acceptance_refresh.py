import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import configuration, reset_acceptance, reset_acceptance_refresh as refresh, reset_protocol, settings


class Journal:
    def __init__(self, state):
        self.state = state
        self.directory = state / 'admin/reset'
        self.directory.mkdir(parents=True)
        self.value = {'reset_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                      'generation': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                      'steps': [{'step': 'earlier'} for _ in range(7)] + [{'step': 'telegram_boundary'}]}

    def assert_current(self):
        pass


class AcceptanceRefreshTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='nocheh-refresh-')
        self.state = Path(self.folder.name)
        configuration.initialize(self.state)
        values = configuration.load(self.state)
        values.update(TELEGRAM_OWNER_ID='100', TELEGRAM_GROUP_IDS='-200')
        configuration.write_env(configuration.env_path(self.state), values)
        self.journal = Journal(self.state)
        self.before = [{'service': name, 'id': name + '-old'} for name in
                       ('hermes', 'nocheh-app', 'nocheh-dashboard', 'nocheh-db', 'nocheh-security')]
        self.activation = {'format': reset_acceptance.FORMAT, 'stage': 'acceptance_running',
                           'reset_id': self.journal.value['reset_id'], 'generation': self.journal.value['generation'],
                           'plan': {'desired': [row['service'] for row in self.before],
                                    'initial_containers': {'nocheh-db': 'nocheh-db-old'}},
                           'containers': self.before}
        reset_protocol.atomic(self.journal.directory / 'acceptance-mode.json', self.activation, create=True)
        settings.save(self.state, {'TELEGRAM_GROUP_ACCESS': json.dumps({'-200': {'granted': ['300'], 'denied': []}})},
                      settings.view(self.state)['revision'])

    def tearDown(self):
        self.folder.cleanup()

    def test_exact_group_grant_rebinds_only_planned_healthy_containers(self):
        after = [{**row, 'id': row['service'] + '-new'} if row['service'] in refresh.SERVICES else row
                 for row in self.before]
        with patch.object(refresh, '_containers', return_value=self.before):
            self.assertEqual(refresh.prepare(self.journal, environment={})['stage'], 'prepared')
        with (patch.object(refresh, '_containers', return_value=after),
              patch.object(refresh, '_assert_environment')):
            self.assertEqual(refresh.finish(self.journal, environment={})['stage'], 'complete')
            self.assertEqual(refresh.finish(self.journal, environment={})['stage'], 'complete')
        self.assertEqual(reset_protocol.read(self.journal.directory / 'acceptance-mode.json')['containers'], after)
        self.assertEqual(reset_protocol.read(self.journal.directory / 'acceptance-refresh.json')['stage'], 'complete')
        self.assertEqual(settings.view(self.state)['apply_state'], 'current')

    def test_unexpected_replacement_fails_closed_without_rebinding(self):
        after = [{**row, 'id': row['service'] + '-new'} for row in self.before]
        with patch.object(refresh, '_containers', return_value=self.before):
            refresh.prepare(self.journal, environment={})
        with patch.object(refresh, '_containers', return_value=after):
            with self.assertRaisesRegex(RuntimeError, 'unexpected_container_replacement'):
                refresh.finish(self.journal, environment={})
        self.assertEqual(reset_protocol.read(self.journal.directory / 'acceptance-mode.json'), self.activation)
        self.assertEqual(settings.view(self.state)['apply_state'], 'unverified')

    def test_unrelated_configuration_change_fails_closed(self):
        values = configuration.load(self.state)
        values['NOCHEH_MODEL'] = 'different-model'
        configuration.write_env(configuration.env_path(self.state), values)
        with self.assertRaisesRegex(ValueError, 'unrelated_configuration_change'):
            refresh.prepare(self.journal, environment={})
        self.assertFalse((self.journal.directory / 'acceptance-refresh.json').exists())


if __name__ == '__main__':
    unittest.main()
