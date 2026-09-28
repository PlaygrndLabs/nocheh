import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services.honcho.meter import Ledger
from tools.operations.memory.honcho_setup import monthly


class HonchoMonthlyCutoverTests(unittest.TestCase):
    def test_exhausted_pilot_can_enable_monthly_before_attachment(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);path=state/'honcho/ledger/budget.sqlite'
            path.parent.mkdir(parents=True)
            ledger=Ledger(path)
            with patch('tools.operations.archive.archive.API') as api:
                api.return_value.call.return_value={'connection':{'attached':False,'verified':False}}
                with self.assertRaisesRegex(ValueError,'exhausted_pilot_preflight'):
                    monthly(state)
                with sqlite3.connect(path) as db:
                    db.execute("INSERT INTO calls(route,digest,reserved,started) VALUES('/v1/embeddings','synthetic',5000000,0)")
                monthly(state)
                self.assertEqual(ledger.report()['mode'],'monthly')
                self.assertEqual(ledger.report()['lifetime_reserved_usd'],5)
                monthly(state)

    def test_partial_attachment_does_not_unlock_monthly_cutover(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);path=state/'honcho/ledger/budget.sqlite'
            path.parent.mkdir(parents=True)
            Ledger(path)
            with sqlite3.connect(path) as db:
                db.execute("INSERT INTO calls(route,digest,reserved,started) VALUES('/v1/embeddings','synthetic',5000000,0)")
            with patch('tools.operations.archive.archive.API') as api:
                api.return_value.call.return_value={'connection':{'attached':False,'verified':True}}
                with self.assertRaisesRegex(ValueError,'exhausted_pilot_preflight'):
                    monthly(state)


if __name__=='__main__':unittest.main()
