"""Production Honcho setup keeps acceptance and spending policy explicit."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import honcho_setup


class HonchoSetupTests(unittest.TestCase):
    def test_monthly_cutover_requires_live_acceptance_and_attachment(self):
        with tempfile.TemporaryDirectory() as folder:
            ledger = Path(folder) / 'ledger/budget.sqlite'
            with patch.object(honcho_setup, 'STATE', Path(folder)),                  patch('scripts.archive.API') as api,                  patch('integrations.honcho.meter.Ledger') as metered:
                for connection in (
                    {'verified': False, 'attached': False},
                    {'verified': True, 'attached': False},
                ):
                    api.return_value.call.return_value = {'connection': connection}
                    with self.assertRaisesRegex(ValueError, 'requires_accepted_attached'):
                        honcho_setup.monthly()
                metered.assert_not_called()
                api.return_value.call.return_value = {
                    'connection': {'verified': True, 'attached': True}
                }
                honcho_setup.monthly()
                metered.assert_called_once_with(ledger)
                metered.return_value.enable_monthly.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
