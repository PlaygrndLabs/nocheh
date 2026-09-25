import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import configuration, reset_acceptance, reset_acceptance_code_refresh as refresh, reset_protocol


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


class CodeRefreshTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='nocheh-code-refresh-')
        self.state = Path(self.folder.name)
        configuration.initialize(self.state)
        self.journal = Journal(self.state)
        self.before = [{'service': name, 'id': name + '-old'} for name in
                       ('hermes', 'nocheh-app', 'nocheh-db')]
        self.after = [{**row, 'id': row['service'] + '-new'} if row['service'] == refresh.SERVICE else row
                      for row in self.before]
        self.activation = {'format': reset_acceptance.FORMAT, 'stage': 'acceptance_running',
                           'reset_id': self.journal.value['reset_id'], 'generation': self.journal.value['generation'],
                           'plan': {'desired': [row['service'] for row in self.before],
                                    'initial_containers': {'nocheh-db': 'nocheh-db-old'}},
                           'containers': self.before}
        reset_protocol.atomic(self.journal.directory / 'acceptance-mode.json', self.activation, create=True)
        self.old_image = 'sha256:' + 'a' * 64
        self.new_image = 'sha256:' + 'b' * 64

    def tearDown(self):
        self.folder.cleanup()

    def _prepare(self):
        with (patch.object(refresh, '_current', return_value=(self.activation, self.before, 'config')),
              patch.object(refresh, '_image', return_value=self.old_image)):
            return refresh.prepare(self.journal, self.new_image, environment={})

    def test_one_app_replacement_rebinds_idempotently(self):
        self._prepare()
        with (patch.object(refresh, '_current', side_effect=[(self.activation, self.after, 'config'),
                                                              ({**self.activation, 'containers': self.after}, self.after, 'config')]),
              patch.object(refresh, '_image', return_value=self.new_image)):
            self.assertEqual(refresh.finish(self.journal, environment={})['stage'], 'complete')
            self.assertEqual(refresh.finish(self.journal, environment={})['stage'], 'complete')
        self.assertEqual(reset_protocol.read(self.journal.directory / 'acceptance-mode.json')['containers'], self.after)
        self.assertEqual(reset_protocol.read(self.journal.directory / refresh.NAME)['stage'], 'complete')

    def test_other_service_replacement_fails_closed(self):
        self._prepare()
        wrong = [{**row, 'id': row['service'] + '-new'} for row in self.before]
        with patch.object(refresh, '_current', return_value=(self.activation, wrong, 'config')):
            with self.assertRaisesRegex(RuntimeError, 'unexpected_container_replacement'):
                refresh.finish(self.journal, environment={})
        self.assertEqual(reset_protocol.read(self.journal.directory / 'acceptance-mode.json'), self.activation)

    def test_wrong_image_or_configuration_fails_closed(self):
        self._prepare()
        with (patch.object(refresh, '_current', return_value=(self.activation, self.after, 'config')),
              patch.object(refresh, '_image', return_value=self.old_image)):
            with self.assertRaisesRegex(RuntimeError, 'unexpected_image'):
                refresh.finish(self.journal, environment={})
        with patch.object(refresh, '_current', return_value=(self.activation, self.after, 'changed')):
            with self.assertRaisesRegex(ValueError, 'intent_changed'):
                refresh.finish(self.journal, environment={})
        self.assertEqual(reset_protocol.read(self.journal.directory / 'acceptance-mode.json'), self.activation)


if __name__ == '__main__':
    unittest.main()
