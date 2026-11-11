"""Production Honcho setup keeps acceptance and spending policy explicit."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.operations.memory import honcho_setup


class HonchoSetupTests(unittest.TestCase):
    def test_default_installation_root_is_repository(self):
        repository = Path(__file__).resolve().parents[2]
        environment = os.environ.copy()
        environment.pop('NOCHEH_INSTALLATION_ROOT', None)
        result = subprocess.check_output(
            [sys.executable, '-c', 'from tools.operations.memory.honcho_setup import ROOT; print(ROOT)'],
            cwd=repository, env=environment, text=True,
        )
        self.assertEqual(Path(result.strip()), repository)

    def test_new_setup_uses_two_deriver_workers_without_changing_provider_limits(self):
        from tools.operations.installation.configuration import initialize, env_path, read_env
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            initialize(state)
            with patch('tools.operations.memory.honcho_setup.state_for', return_value=state / 'honcho'):
                honcho_setup.initialize(state)
            values = read_env(state / 'honcho/honcho.env')
            self.assertEqual(values['DERIVER_WORKERS'], '2')
            self.assertEqual(values['DERIVER_FLUSH_ENABLED'], 'true')
            self.assertEqual(values['DERIVER_REPRESENTATION_BATCH_WORK_UNIT_TARGET_TOKENS'], '0')

    def test_setup_takes_the_longest_query_and_keeps_model_inputs_within_the_guard(self):
        from tools.operations.installation.configuration import initialize, read_env
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            initialize(state)
            with patch('tools.operations.memory.honcho_setup.state_for', return_value=state / 'honcho'):
                honcho_setup.initialize(state)
            values = read_env(state / 'honcho/honcho.env')
            # Honcho's own maximum query; its input budgets fill at most 480 KiB of the guard's 512 KiB at 8 bytes a token.
            self.assertEqual(values['DIALECTIC_MAX_QUERY_LENGTH'], '200000')
            for name in ('DIALECTIC_MAX_INPUT_TOKENS', 'SUMMARY_MAX_INPUT_TOKENS'):
                self.assertLessEqual(int(values[name]) * 8 + 32 * 1024, 512 * 1024)
                # A summary needs room for twice its longest output (6,000 tokens), or Honcho does not start.
                self.assertGreaterEqual(int(values[name]), 12000)

    def test_setup_asks_every_dialectic_level_for_json_through_the_prompt(self):
        from tools.operations.installation.configuration import initialize, read_env
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            initialize(state)
            with patch('tools.operations.memory.honcho_setup.state_for', return_value=state / 'honcho'):
                honcho_setup.initialize(state)
            values = read_env(state / 'honcho/honcho.env')
            # Learning asks peer chat for a response_format; a json_schema sent alongside tools can be refused.
            for level in ('minimal', 'low', 'medium', 'high', 'max'):
                self.assertEqual(values[f'DIALECTIC_LEVELS__{level}__MODEL_CONFIG__STRUCTURED_OUTPUT_MODE'], 'json_object')

    def test_setup_keeps_peer_cards_and_dreams_off(self):
        from tools.operations.installation.configuration import initialize, read_env, write_env
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            initialize(state)
            with patch('tools.operations.memory.honcho_setup.state_for', return_value=state / 'honcho'):
                honcho_setup.initialize(state)
                path = state / 'honcho/honcho.env'
                values = read_env(path)
                self.assertEqual(values['PEER_CARD_ENABLED'], 'false')
                self.assertEqual(values['DREAM_ENABLED'], 'false')
                # A hand edit does not keep peer cards on: the next setup writes the file again.
                write_env(path, {**values, 'PEER_CARD_ENABLED': 'true'})
                self.assertEqual(read_env(path)['PEER_CARD_ENABLED'], 'true')
                honcho_setup.initialize(state)
                self.assertEqual(read_env(path)['PEER_CARD_ENABLED'], 'false')

    def test_build_images_are_pinned_and_a_missing_one_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            root, state = Path(folder) / 'root', Path(folder) / 'state'
            (root / 'services/honcho').mkdir(parents=True)
            (root / 'data/compat/upstreams/honcho').mkdir(parents=True)
            state.mkdir()
            (root / 'services/honcho/upstreams.lock.json').write_text(json.dumps({'build_images': {
                'base:1': 'base:1@sha256:' + 'a' * 64, 'tool:2': 'tool:2@sha256:' + 'b' * 64}}))
            dockerfile = root / 'data/compat/upstreams/honcho/Dockerfile'
            dockerfile.write_text('# syntax=docker/dockerfile:1\nFROM base:1 AS builder\nCOPY --from=tool:2 /tool /bin/tool\nFROM base:1\n')
            with patch.object(honcho_setup, 'ROOT', root), patch.object(honcho_setup, 'STATE', state):
                honcho_setup.sources()
                # Inside the build context, so Compose's Bake build needs no extra file-read permission.
                target = root / 'data/compat/upstreams/honcho/nocheh.Dockerfile'
                built = target.read_text()
                self.assertEqual(list(state.iterdir()), [])
                self.assertEqual(built.count('base:1@sha256:' + 'a' * 64), 2)
                self.assertIn('COPY --from=tool:2@sha256:' + 'b' * 64 + ' /tool', built)
                self.assertNotIn('# syntax=', built)
                # Upstream moved to another tool tag: the lock no longer matches, so nothing is written.
                dockerfile.write_text('FROM base:1\nCOPY --from=tool:3 /tool /bin/tool\n')
                with self.assertRaisesRegex(SystemExit, 'tool:2: build image is not in the Honcho Dockerfile'):
                    honcho_setup.sources()
                self.assertFalse(target.exists())
                # Upstream added another image: every FROM and COPY --from must still carry a digest.
                dockerfile.write_text('FROM base:1 AS builder\nCOPY --from=tool:2 /tool /bin/tool\nFROM other:1\nCOPY --from=builder /app /app\n')
                with self.assertRaisesRegex(SystemExit, 'other:1: Honcho build image is not pinned'):
                    honcho_setup.sources()
                self.assertFalse(target.exists())

    def test_monthly_cutover_requires_live_acceptance_and_attachment(self):
        with tempfile.TemporaryDirectory() as folder:
            ledger = Path(folder) / 'ledger/budget.sqlite'
            with patch('tools.operations.memory.honcho_setup.state_for', return_value=Path(folder)), \
                    patch('tools.operations.archive.archive.API') as api, \
                    patch('services.honcho.meter.Ledger') as metered:
                metered.return_value.report.return_value = {'mode': 'pilot', 'reserved_usd': 0, 'limit_usd': 5}
                for connection in (
                    {'verified': False, 'attached': False},
                    {'verified': True, 'attached': False},
                ):
                    api.return_value.call.return_value = {'connection': connection}
                    with self.assertRaisesRegex(ValueError, 'requires_accepted_memory_or_exhausted_pilot_preflight'):
                        honcho_setup.monthly()
                metered.return_value.enable_monthly.assert_not_called()
                metered.reset_mock()
                api.return_value.call.return_value = {
                    'connection': {'verified': True, 'attached': True}
                }
                honcho_setup.monthly()
                metered.assert_called_once_with(ledger)
                metered.return_value.enable_monthly.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
