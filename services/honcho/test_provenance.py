import unittest
from .provenance import (COVERAGE_SQL, DESCENDANTS_SQL, DOCUMENTS_SQL, MESSAGES_SQL, ancestry, citation_coverage, fact_batches, failed_learning_count,
    failed_queue_items, provenance, retry_failed_learning, session_descendants)


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
        from datetime import datetime, timezone
        since=datetime(2026,10,18,tzinfo=timezone.utc)
        await failed_queue_items('owned-workspace',db,since)
        sql,values=db.calls[-1]
        self.assertEqual(values,{'workspace':'owned-workspace','since':since})
        self.assertIn('created_at > :since',sql,'failures Nocheh already saw no longer hold the workspace')

    async def test_failed_learning_is_counted_and_returned_to_the_queue_only_for_its_workspace(self):
        class Result:
            rowcount=3
            def scalar_one(self): return 3
        class Database:
            def __init__(self): self.calls=[];self.commits=0
            async def execute(self, statement, values):
                self.calls.append((' '.join(str(statement).split()),values));return Result()
            async def commit(self): self.commits+=1
        db=Database()
        self.assertEqual(await failed_learning_count('owned-workspace',db),3)
        self.assertEqual(await retry_failed_learning('owned-workspace',db),3)
        self.assertEqual(db.commits,1)
        for sql,values in db.calls:
            self.assertEqual(values,{'workspace':'owned-workspace'})
            self.assertIn('workspace_name=:workspace',sql)
            self.assertIn("task_type IN ('representation','summary','dream') AND processed AND error IS NOT NULL",sql)
        retry=db.calls[-1][0]
        self.assertTrue(retry.startswith('UPDATE queue SET processed=false, error=NULL'),'a retried task is unprocessed again, with no error kept')
        self.assertNotIn('messages',retry,'retrying never changes or resends a saved message')

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
        self.assertEqual([n['exact_citations'] for n in result['nodes']], [None, False], 'a parent-only node brings no messages; a batch is not a citation')
        self.assertIn('ancestry_is_not_an_exact_citation', result['limitations'])
        self.assertFalse(result['exact_citations'])

    async def test_cited_messages_replace_the_batch_per_conclusion_and_come_first(self):
        root, parent, other = 'r'*21, 'p'*21, 'o'*21
        rows = {root: {'id': root, 'source_ids': [parent], 'cited_ids': [5,3], 'message_ids': [3,4,5,6]},
                parent: {'id': parent, 'deleted': True, 'cited_ids': None, 'message_ids': [7]},
                other: {'id': other, 'cited_ids': [], 'message_ids': [8]}}
        async def documents(ids): return [rows[v] for v in ids if v in rows]
        loads = []
        async def messages(ids):
            loads.append(ids)
            return [{'id':v,'public_id':str(v).zfill(21),'receipt_id':str(v)*64} for v in reversed(ids)]
        result = await ancestry([root], documents, messages)
        self.assertEqual(loads, [[5,3,7]], 'a cited conclusion brings only the messages it cites, in citation order, before any batch')
        self.assertEqual([m['message_id'] for m in result['messages']], ['5'.zfill(21),'3'.zfill(21),'7'.zfill(21)])
        self.assertEqual(result['nodes'], [{'id':root,'parents':[parent],'deleted':False,'exact_citations':True},
                                           {'id':parent,'parents':[],'deleted':True,'exact_citations':False}], 'a deleted ancestor still counts')
        self.assertIn('ancestry_is_not_an_exact_citation', result['limitations'])
        self.assertFalse(result['exact_citations'], 'one uncited conclusion makes the chain inexact')
        rows[parent] = {'id': parent, 'source_ids': [], 'cited_ids': [7], 'message_ids': [7,9]}
        result = await ancestry([root], documents, messages)
        self.assertTrue(result['exact_citations'])
        self.assertNotIn('ancestry_is_not_an_exact_citation', result['limitations'])
        rows[root]['cited_ids'] = None
        rows[parent] = {'id': parent, 'cited_ids': [7]}
        self.assertFalse((await ancestry([root], documents, messages))['exact_citations'], 'an older conclusion without citations keeps its batch')
        result = await ancestry([other], documents, messages)
        self.assertEqual((result['nodes'][0]['exact_citations'], result['exact_citations'], loads[-1]), (False, False, [8]), 'no cited rows falls back')
        rows[root] = {'id': root, 'source_ids': [parent]}
        result = await ancestry([root], documents, messages)
        self.assertEqual([n['exact_citations'] for n in result['nodes']], [None, True])
        self.assertTrue(result['exact_citations'], 'a derived conclusion is exact through cited parents')

    async def test_cited_messages_win_the_message_limit(self):
        root, parent = 'r'*21, 'p'*21
        rows = {root: {'id': root, 'source_ids': [parent], 'message_ids': [1,2]}, parent: {'id': parent, 'cited_ids': [9]}}
        async def documents(ids): return [rows[v] for v in ids if v in rows]
        loads = []
        async def messages(ids): loads.append(ids); return []
        result = await ancestry([root], documents, messages, max_messages=2)
        self.assertEqual(loads, [[9,1]])
        self.assertIn('message_limit', result['limitations'])

    def test_documents_query_reads_citations_within_the_conclusions_tenant_and_workspace(self):
        sql = ' '.join(DOCUMENTS_SQL.split())
        self.assertIn('FROM documents d WHERE d.workspace_name=:workspace AND d.id=ANY(:ids)', sql)
        self.assertIn('FROM conclusion_source_messages s JOIN messages m ON m.tenant_id=s.tenant_id AND m.public_id=s.message_id', sql)
        self.assertIn('WHERE s.tenant_id=d.tenant_id AND s.conclusion_id=d.id ORDER BY s.position', sql)
        self.assertIn('d.deleted_at IS NOT NULL AS deleted', sql, 'deleted ancestors are reported, not hidden')

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


def message_rows(ids):
    return [{'id': v, 'public_id': str(v).zfill(21), 'receipt_id': ('%02d' % (v % 100)) * 32} for v in reversed(ids)]


def public(*ids):
    return [{'message_id': str(v).zfill(21), 'receipt_id': ('%02d' % (v % 100)) * 32} for v in ids]


class FactBatchTests(unittest.IsolatedAsyncioTestCase):
    """Facts mode: one node per conclusion with its own messages, never a parent's."""

    async def run_batches(self, rows, roots, **body):
        reads, loads = [], []
        async def documents(ids):
            reads.append(list(ids))
            return [rows[v] for v in ids if v in rows]
        async def messages(ids, limit=256):
            loads.append((list(ids), limit))
            return message_rows(ids)
        result = await provenance({'conclusion_ids': roots, 'depth': 0, 'per_node': True, **body}, documents, messages)
        return result, reads, loads

    async def test_each_conclusion_brings_its_own_messages(self):
        cited, uncited, parent = 'c'*21, 'u'*21, 'p'*21
        rows = {cited: {'id': cited, 'source_ids': [parent], 'cited_ids': [5, 3], 'message_ids': [3, 4, 5]},
                uncited: {'id': uncited, 'cited_ids': None, 'message_ids': [7, 8, 7]}}
        result, reads, loads = await self.run_batches(rows, [uncited, cited, uncited])
        self.assertEqual(reads, [[uncited, cited]], 'one read for every conclusion, and parents are never followed')
        self.assertEqual(loads, [([7, 8, 5, 3], 4)], 'one read for every message')
        self.assertEqual(result['roots'], [uncited, cited])
        self.assertEqual(result['nodes'], [
            {'id': uncited, 'parents': [], 'deleted': False, 'exact_citations': False, 'messages': public(7, 8), 'messages_truncated': False},
            {'id': cited, 'parents': [parent], 'deleted': False, 'exact_citations': True, 'messages': public(5, 3), 'messages_truncated': False}])
        self.assertNotIn('messages', result, 'facts mode never flattens messages across conclusions')
        self.assertIn('ancestry_is_not_an_exact_citation', result['limitations'])

    async def test_a_batch_brings_its_first_messages_and_says_it_left_some_out(self):
        root = 'r'*21
        rows = {root: {'id': root, 'message_ids': list(range(1, 13))}}
        result, _, loads = await self.run_batches(rows, [root])
        self.assertEqual(loads, [(list(range(1, 9)), 8)])
        self.assertEqual((result['nodes'][0]['messages'], result['nodes'][0]['messages_truncated']), (public(*range(1, 9)), True))
        self.assertIn('message_limit', result['limitations'])
        rows[root] = {'id': root, 'message_ids': [1, 2], 'messages_truncated': True}
        result, _, _ = await self.run_batches(rows, [root])
        self.assertTrue(result['nodes'][0]['messages_truncated'], 'a batch the store already cut is not complete')

    async def test_old_shape_conclusions_and_missing_rows(self):
        old, bare, gone, odd = 'o'*21, 'b'*21, 'g'*21, 'x'*21
        rows = {old: {'id': old, 'message_ids': [4]}, bare: {'id': bare}, odd: {'id': odd, 'cited_ids': [], 'message_ids': 'not a list'}}
        result, _, _ = await self.run_batches(rows, [old, bare, gone, odd])
        self.assertEqual([(n['id'], n['exact_citations'], n['messages'], n['messages_truncated']) for n in result['nodes']], [
            (old, False, public(4), False), (bare, None, [], False), (odd, None, [], False)],
            'a conclusion from before citations keeps its batch; one with no links brings nothing; a missing one has no node')
        self.assertIn('conclusion_unavailable', result['limitations'])
        self.assertIn('message_links_unavailable', result['limitations'])

    async def test_unreadable_messages_are_left_out_and_counted(self):
        root = 'r'*21
        rows = {root: {'id': root, 'message_ids': [1, 2, 3]}}
        async def documents(ids): return [rows[root]]
        async def messages(ids, limit=256): return [{'id': 1, 'public_id': '1'.zfill(21), 'receipt_id': 'not a receipt'}, *message_rows([3])]
        result = await fact_batches({'conclusion_ids': [root], 'depth': 0, 'per_node': True}, documents, messages)
        self.assertEqual(result['nodes'][0]['messages'], public(3))
        self.assertTrue(result['nodes'][0]['messages_truncated'])
        self.assertTrue({'message_unavailable', 'ingestion_reference_unavailable'} <= set(result['limitations']))
        async def missing(ids, limit=256): return message_rows([1, 3])
        result = await fact_batches({'conclusion_ids': [root], 'depth': 0, 'per_node': True}, documents, missing)
        self.assertEqual((result['nodes'][0]['messages'], result['nodes'][0]['messages_truncated']), (public(1, 3), True),
                         'a message Honcho no longer has makes the list incomplete')
        async def stray(ids, limit=256): return message_rows([99])
        with self.assertRaises(ValueError):
            await fact_batches({'conclusion_ids': [root], 'depth': 0, 'per_node': True}, documents, stray)

    async def test_invalid_requests_never_reach_the_store(self):
        async def documents(ids): self.fail('invalid request reached the store')
        async def messages(ids, limit=256): self.fail('invalid request reached the store')
        root = 'r'*21
        for body in [{'conclusion_ids': [root], 'depth': 1, 'per_node': True}, {'conclusion_ids': [root], 'depth': False, 'per_node': True},
                     {'conclusion_ids': [root], 'per_node': 'yes'}, {'conclusion_ids': [root], 'per_node': True, 'other': 1},
                     {'conclusion_ids': [], 'per_node': True}, {'conclusion_ids': ['short'], 'per_node': True},
                     {'conclusion_ids': [str(i).zfill(21) for i in range(129)], 'per_node': True}]:
            with self.assertRaises(ValueError, msg=str(body)):
                await provenance(body, documents, messages)
        rows = {str(i).zfill(21): {'id': str(i).zfill(21)} for i in range(128)}
        result, _, _ = await self.run_batches(rows, list(rows))
        self.assertEqual(len(result['nodes']), 128, 'facts mode takes up to 128 conclusions, more than the trace\'s 32')

    async def test_without_facts_mode_the_route_keeps_the_flat_trace(self):
        root = 'r'*21
        async def documents(ids): return [{'id': root, 'cited_ids': [2]}]
        async def messages(ids, limit=256): return message_rows(ids)
        result = await provenance({'conclusion_ids': [root]}, documents, messages)
        self.assertEqual(result['messages'], public(2))
        self.assertNotIn('messages', result['nodes'][0])

    def test_message_query_is_bounded_by_its_caller(self):
        self.assertIn('LIMIT :limit', MESSAGES_SQL)
        self.assertIn('workspace_name=:workspace', MESSAGES_SQL)


class CoverageTests(unittest.IsolatedAsyncioTestCase):
    async def test_coverage_is_counts_of_live_explicit_conclusions(self):
        class Result:
            def mappings(self): return self
            def one(self): return {'explicit': 10, 'cited': 6, 'batch_only': 3}
        class Database:
            def __init__(self): self.calls = []
            async def execute(self, statement, values):
                self.calls.append((' '.join(str(statement).split()), values)); return Result()
        db = Database()
        self.assertEqual(await citation_coverage('owned-workspace', db), {'explicit': 10, 'cited': 6, 'batch_only': 3, 'none': 1})
        sql, values = db.calls[0]
        self.assertEqual(values, {'workspace': 'owned-workspace'})
        self.assertIn("d.workspace_name=:workspace AND d.level='explicit' AND d.deleted_at IS NULL", sql)
        self.assertIn('AND NOT EXISTS (SELECT 1 FROM sessions x WHERE x.tenant_id=d.tenant_id AND x.workspace_name=d.workspace_name '
                      'AND x.name=d.session_name AND x.deleted_at IS NOT NULL)', sql, 'conclusions of a deleted session are not counted')
        self.assertIn('count(*) FILTER (WHERE NOT cited AND batch) AS batch_only', sql)
        self.assertIn("AND d.observer NOT LIKE 'scope.%'", sql, 'a memory wall\'s copies are not counted again')
        self.assertNotIn('content', COVERAGE_SQL, 'counts only, never a conclusion\'s text')


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
