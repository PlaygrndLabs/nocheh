import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.operations.installation import operations
from tools.operations.installation.configuration import read_env, write_env


class ActivationTests(unittest.TestCase):
    """A restored final snapshot becomes the running installation only when safe."""

    def restored(self, folder, **report):
        state = Path(folder)
        for hold in operations.HOLDS:
            (state / hold).parent.mkdir(parents=True, exist_ok=True)
            (state / hold).touch()
        (state / 'reports').mkdir()
        (state / 'honcho').mkdir()
        (state / 'honcho/internal_token').write_text('synthetic-memory-token\n')
        write_env(state / 'restored.env', {'TELEGRAM_ENABLED': 'true', 'NOCHEH_HONCHO_ENABLED': 'true'})
        write_env(state / '.env', {'TELEGRAM_ENABLED': 'false', 'NOCHEH_HONCHO_ENABLED': 'false',
                                   'NOCHEH_MEMORY_TOKEN': '', 'COMPOSE_PROJECT_NAME': 'nocheh-server'})
        record = {'status': 'restored_inactive', 'final_snapshot': True,
                  'memory_connection': {'attached': True, 'verified': True}, **report}
        (state / 'reports/restore.json').write_text(json.dumps(record))
        return state

    def activate(self, state, source_stopped=True):
        with patch.object(operations, 'compose', return_value=['compose']), \
             patch.object(operations, 'environment', return_value={}), \
             patch.object(operations, 'load', side_effect=lambda s: read_env(Path(s) / '.env')), \
             patch.object(operations, 'env_path', side_effect=lambda s: Path(s) / '.env'), \
             patch.object(operations.subprocess, 'run') as run, \
             patch('tools.operations.installation.store_recovery.StoreRecovery.query') as query:
            result = operations.activate(state, source_stopped)
        return result, run, query

    def test_final_snapshot_returns_to_the_sources_saved_state(self):
        with tempfile.TemporaryDirectory() as folder:
            state = self.restored(folder)
            result, run, query = self.activate(state)
            config = read_env(state / '.env')
            self.assertEqual((config['TELEGRAM_ENABLED'], config['NOCHEH_HONCHO_ENABLED'], config['NOCHEH_MEMORY_TOKEN']),
                             ('true', 'true', 'synthetic-memory-token'))
            self.assertFalse(any((state / hold).exists() for hold in operations.HOLDS))
            query.assert_called_once_with('control', 'UPDATE memory_engine_connection SET attached=true,verified=true WHERE singleton')
            self.assertEqual(json.loads((state / 'reports/restore.json').read_text())['status'], 'activated')
            self.assertEqual(result['status'], 'activated')
            # A second activation is refused: the installation already runs.
            with self.assertRaisesRegex(ValueError, 'activation_requires_inactive_restore'):
                self.activate(state)

    def test_unsafe_activations_change_nothing(self):
        cases = ((dict(final_snapshot=False), True, 'activation_requires_final_snapshot'),
                 ({}, False, 'activation_requires_stopped_source'),
                 (dict(memory_connection={'attached': 'yes', 'verified': True}), True, 'restored_memory_connection_invalid'))
        for report, stopped, error in cases:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as folder:
                state = self.restored(folder, **report)
                with self.assertRaisesRegex(ValueError, error):
                    self.activate(state, stopped)
                # Holds stay and the memory connection is untouched until every check passes.
                self.assertTrue(all((state / hold).exists() for hold in operations.HOLDS))
                self.assertEqual(read_env(state / '.env')['TELEGRAM_ENABLED'], 'false')
                self.assertEqual(json.loads((state / 'reports/restore.json').read_text())['status'], 'restored_inactive')
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'activation_requires_restored_installation'):
                self.activate(Path(folder))


if __name__ == '__main__':
    unittest.main()
