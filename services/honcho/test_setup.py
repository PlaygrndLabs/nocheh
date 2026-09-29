"""Production Honcho setup keeps acceptance and spending policy explicit."""
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
