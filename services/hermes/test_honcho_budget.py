import tempfile
import unittest
import uuid
from pathlib import Path

from services.honcho.meter import Ledger
from tools.operations.memory.honcho_budget import update, view


class HonchoBudgetOperationTests(unittest.TestCase):
    def test_owner_change_requires_accepted_attachment_and_monthly_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);request={'limit_cents':700,'expected_revision':0,'operation_id':str(uuid.uuid4())}
            (state/'honcho/ledger').mkdir(parents=True)
            for connection in ({'attached':False,'verified':True},{'attached':True,'verified':False}):
                with self.assertRaisesRegex(ValueError,'honcho_budget_requires_accepted_memory'):
                    update(request,state,connection)
            with self.assertRaisesRegex(ValueError,'monthly_budget_not_enabled'):
                update(request,state,{'attached':True,'verified':True})
            Ledger(state/'honcho/ledger/budget.sqlite').enable_monthly()
            self.assertEqual(update(request,state,{'attached':True,'verified':True})['limit_usd'],7)
            self.assertEqual(view(state)['revision'],1)
            with self.assertRaisesRegex(ValueError,'invalid_budget_request'):
                update({**request,'unexpected':True},state,{'attached':True,'verified':True})


if __name__=='__main__': unittest.main()
