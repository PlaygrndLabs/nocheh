import unittest
from .provenance import ancestry


class ProvenanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_ancestry_follows_parents_deduplicates_cycles_and_reports_missing_evidence(self):
        a, b, c = 'a'*21, 'b'*21, 'c'*21
        rows = {a: {'id': a, 'source_ids': [b,c]}, b: {'id': b, 'source_ids': [a], 'message_ids': [1,2]}}
        reads = []

        async def documents(ids):
            reads.extend(ids)
            return [rows[v] for v in ids if v in rows]

        async def messages(ids):
            self.assertEqual(ids, [1,2])
            return [{'id':1,'public_id':'m'*21,'receipt_id':'f'*64}]

        result = await ancestry([a], documents, messages)
        self.assertEqual(reads, [a,b,c])
        self.assertEqual(result['messages'], [{'message_id':'m'*21,'receipt_id':'f'*64}])
        self.assertIn('conclusion_unavailable', result['limitations'])
        self.assertIn('message_unavailable', result['limitations'])
        self.assertFalse(result['exact_citations'])

    async def test_depth_node_queue_and_message_limits_are_bounded(self):
        reads = []
        async def documents(ids):
            reads.extend(ids)
            return [{'id':ids[0], 'source_ids':[str(i).zfill(21) for i in range(1,1000)], 'message_ids':list(range(1,1000))}]
        async def messages(ids):
            self.assertLessEqual(len(ids), 3)
            return []
        result = await ancestry(['0'*21], documents, messages, max_nodes=2, max_depth=1, max_messages=3)
        self.assertEqual(len(reads), 2)
        self.assertIn('ancestry_limit', result['limitations'])
        self.assertIn('depth_limit', result['limitations'])
        self.assertIn('message_limit', result['limitations'])

    async def test_no_message_metadata_is_an_explicit_limitation(self):
        async def documents(ids): return [{'id':ids[0]}]
        async def messages(ids): self.fail('no fabricated message lookup')
        result = await ancestry(['a'*21], documents, messages)
        self.assertEqual(result['messages'], [])
        self.assertIn('message_links_unavailable', result['limitations'])
        with self.assertRaises(ValueError):
            await ancestry(['invalid'], documents, messages)


if __name__ == '__main__': unittest.main()
