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


    def test_owner_turns_the_thinking_limit_on_and_off(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);(state/'honcho/ledger').mkdir(parents=True)
            accepted={'attached':True,'verified':True}
            self.assertIsNone(view(state)['thinking_limit_usd'])
            request={'thinking_limit_cents':4000,'expected_revision':0,'operation_id':str(uuid.uuid4())}
            with self.assertRaisesRegex(ValueError,'honcho_budget_requires_accepted_memory'):
                update(request,state,{'attached':False,'verified':True})
            turned_on=update(request,state,accepted)
            self.assertEqual((turned_on['thinking_limit_usd'],turned_on['thinking_limit_cents'],turned_on['revision']),(40,4000,1))
            turned_off=update({'thinking_limit_cents':None,'expected_revision':1,'operation_id':str(uuid.uuid4())},state,accepted)
            self.assertIsNone(turned_off['thinking_limit_usd'])
            with self.assertRaisesRegex(ValueError,'invalid_budget_request'):
                update({**request,'limit_cents':700},state,accepted)


if __name__=='__main__': unittest.main()
