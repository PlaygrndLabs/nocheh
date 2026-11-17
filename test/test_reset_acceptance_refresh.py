import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.acceptance import reset_acceptance
from tools.acceptance import reset_acceptance_refresh as refresh
from tools.acceptance import reset_protocol


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


class AcceptanceActivationTests(unittest.TestCase):
    """What a runtime image replacement rebinds during reset acceptance (reset_acceptance_code_refresh). A member change
    needs none: members are live, and no setting names who may talk in a group (step 3)."""

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='nocheh-refresh-')
        self.state = Path(self.folder.name)
        self.journal = Journal(self.state)
        self.containers = {name: {'id': name + '-old', 'restart_policy': {'Name': 'no', 'MaximumRetryCount': 0}}
                           for name in ('hermes', 'nocheh-app', 'nocheh-db', 'nocheh-telegram')}
        self.activation = {'format': reset_acceptance.FORMAT, 'stage': 'acceptance_running',
                           'reset_id': self.journal.value['reset_id'], 'generation': self.journal.value['generation'],
                           'plan': {'desired': sorted(self.containers), 'initial_containers': {'nocheh-db': 'nocheh-db-old'}},
                           'containers': [{'service': name, 'id': row['id']} for name, row in sorted(self.containers.items())]}
        reset_protocol.atomic(self.journal.directory / 'acceptance-mode.json', self.activation, create=True)

    def tearDown(self):
        self.folder.cleanup()

    def test_the_activation_is_this_resets_running_acceptance(self):
        self.assertEqual(refresh._activation(self.journal), self.activation)
        self.journal.value['steps'] = self.journal.value['steps'][:7]
        with self.assertRaisesRegex(ValueError, 'reset_refresh_phase_required'):
            refresh._activation(self.journal)
        self.journal.value['steps'].append({'step': 'telegram_boundary'})
        for change in ({'stage': 'prepared'}, {'reset_id': 'c' * 36}, {'generation': 'd' * 36}):
            with self.subTest(change=change):
                reset_protocol.atomic(self.journal.directory / 'acceptance-mode.json', {**self.activation, **change})
                with self.assertRaisesRegex(ValueError, 'reset_refresh_activation_changed'):
                    refresh._activation(self.journal)

    def test_the_containers_are_running_healthy_unfenced_and_never_restarted_by_docker(self):
        states = {row['id']: {'Status': 'running', 'Health': {'Status': 'healthy'}} for row in self.containers.values()}

        def current(changes=None, fences=0):
            with (patch.object(reset_acceptance, '_owned', return_value=self.containers),
                  patch.object(reset_acceptance, '_state', side_effect=lambda identifier, runner, environment: {**states[identifier], **(changes or {}).get(identifier, {})}),
                  patch.object(reset_acceptance, '_fence_state', return_value=fences)):
                return refresh._containers(self.journal, self.activation, None, {})

        self.assertEqual(current(), self.activation['containers'])
        with self.assertRaisesRegex(RuntimeError, 'reset_refresh_service_not_healthy'):
            current({'hermes-old': {'Health': {'Status': 'starting'}}})
        with self.assertRaisesRegex(RuntimeError, 'reset_refresh_service_not_healthy'):
            current({'nocheh-app-old': {'Status': 'exited'}})
        with self.assertRaisesRegex(RuntimeError, 'reset_refresh_fence_changed'):
            current(fences=3)
        self.containers['nocheh-telegram']['restart_policy'] = {'Name': 'unless-stopped', 'MaximumRetryCount': 0}
        with self.assertRaisesRegex(RuntimeError, 'reset_acceptance_restart_owner_enabled'):
            current()


if __name__ == '__main__':
    unittest.main()
