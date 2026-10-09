import unittest
from .provenance import DESCENDANTS_SQL, ancestry, failed_queue_items, session_descendants


class ProvenanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_queue_items_is_scoped_and_returns_no_error_content(self):
        class Result:
            def __init__(self, failed): self.failed=failed
            def scalar_one(self): return self.failed
        class Database:
            def __init__(self): self.calls=[];self.failed=True
            async def execute(self, statement, values):
                self.calls.append((str(statement),values));return Result(self.failed)
        db=Database()
        self.assertTrue(await failed_queue_items('owned-workspace',db))
        sql,values=db.calls[-1]
        self.assertEqual(values,{'workspace':'owned-workspace'})
        self.assertIn('processed AND error IS NOT NULL',sql)
        db.failed=False
        self.assertFalse(await failed_queue_items('owned-workspace',db))

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


class SessionDescendantTests(unittest.IsolatedAsyncioTestCase):
    async def test_descendants_are_bounded_and_report_more(self):
        calls = []
        async def load(session, limit):
            calls.append((session, limit))
            return [str(i).zfill(21) for i in range(limit)]
        result = await session_descendants({'session_id': 'a'*64, 'limit': 2}, load)
        self.assertEqual(calls, [('a'*64, 3)])
        self.assertEqual(result, {'ids': ['0'*21, '0'*20+'1'], 'truncated': True})

    async def test_invalid_requests_never_reach_the_store(self):
        async def load(session, limit): self.fail('invalid request reached the store')
        for body in [{'session_id': 'short'}, {'session_id': 'a'*64, 'limit': 101}, {'session_id': 'a'*64, 'limit': True},
                     {'session_id': 'a'*64, 'other': 1}, []]:
            with self.assertRaises(ValueError):
                await session_descendants(body, load)

    async def test_query_excludes_the_session_itself_and_deleted_conclusions(self):
        self.assertIn('session_name IS DISTINCT FROM :session', DESCENDANTS_SQL)
        self.assertIn('deleted_at IS NULL', DESCENDANTS_SQL)
        self.assertIn('tree.depth<8', DESCENDANTS_SQL)
