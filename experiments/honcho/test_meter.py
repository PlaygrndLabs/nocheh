import concurrent.futures
import io
import json
import tempfile
import unittest
from pathlib import Path
from .meter import Egress, Ledger, Rejected, validate


class Response(io.BytesIO):
    status=200
    headers={'Content-Type':'application/json'}


class Transport:
    def __init__(self, fail=False): self.calls=[];self.fail=fail
    def open(self,request,timeout):
        self.calls.append(request)
        if self.fail: raise TimeoutError()
        return Response(b'{"data":[],"usage":{"prompt_tokens":10,"total_tokens":10}}')


class BudgetTests(unittest.TestCase):
    def test_concurrent_budget_restart_and_zero_egress(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');transport=Transport()
            # Reserve 499 calls, then race the final dollar-cent across threads.
            for _ in range(499): ledger.reserve('/v1/embeddings',b'fixture')
            egress=Egress(ledger,'internal','temporary',transport)
            def send(_):
                try: return egress.send('/v1/embeddings',{'model':'text-embedding-3-small','input':'fixture'})[0]
                except Rejected: return 'blocked'
            with concurrent.futures.ThreadPoolExecutor(8) as pool: results=list(pool.map(send,range(16)))
            self.assertEqual(results.count(200),1);self.assertEqual(len(transport.calls),1)
            restored=Ledger(Path(root)/'budget.sqlite')
            self.assertEqual(restored.report()['reserved_usd'],5)
            with self.assertRaises(Rejected): restored.reserve('/v1/embeddings',b'new')

    def test_timeout_reservation_and_missing_key(self):
        with tempfile.TemporaryDirectory() as root:
            ledger=Ledger(Path(root)/'budget.sqlite');transport=Transport(True)
            payload={'model':'text-embedding-3-small','input':['hello']}
            with self.assertRaises(Rejected): Egress(ledger,'internal','',transport).send('/v1/embeddings',payload)
            self.assertEqual(ledger.report()['reserved_usd'],0);self.assertEqual(len(transport.calls),0)
            self.assertEqual(Egress(ledger,'internal','temporary',transport).send('/v1/embeddings',payload)[0],502)
            self.assertEqual(ledger.report()['reserved_usd'],.01)

    def test_route_model_bounds_and_subscription_only_reasoning(self):
        for route,payload in [('/v1/responses',{}),('/v1/embeddings',{'model':'expensive','input':'x'}),('/v1/embeddings',{'model':'text-embedding-3-small','input':'x'*131073}),('/v1/chat/completions',{'model':'other','messages':[]})]:
            with self.assertRaises(Rejected): validate(route,payload)
        with tempfile.TemporaryDirectory() as root:
            transport=Transport();ledger=Ledger(Path(root)/'budget.sqlite')
            Egress(ledger,'internal','temporary',transport).send('/v1/chat/completions',{'model':'gpt-5.6-sol','messages':[]})
            self.assertEqual(transport.calls[0].full_url,'http://bridge:8317/v1/chat/completions')
            self.assertEqual(transport.calls[0].get_header('Authorization'),'Bearer internal')
            self.assertEqual(ledger.report()['reserved_usd'],0)


if __name__=='__main__': unittest.main()
