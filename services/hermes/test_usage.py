import sqlite3
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from . import usage

DAY = datetime(2026, 10, 13, 12, tzinfo=timezone.utc).timestamp()


class UsageTests(unittest.TestCase):
    def test_hermes_turn_usage_keeps_counts_and_never_turns_an_unknown_cost_into_zero(self):
        priced = {'input_tokens': 100, 'output_tokens': 20, 'api_calls': 2, 'estimated_cost_usd': 0.004,
                  'cost_status': 'estimated', 'model': 'synthetic-model', 'final_response': 'private words'}
        unknown = {'input_tokens': 50, 'output_tokens': 5, 'api_calls': 1, 'estimated_cost_usd': None, 'cost_status': 'unknown'}
        included = {'input_tokens': 10, 'api_calls': 1, 'estimated_cost_usd': 0.3, 'cost_status': 'included'}
        self.assertEqual(usage.turn_usage(priced)['cost_usd'], 0.004)
        self.assertNotIn('private words', repr(usage.turn_usage(priced)))
        self.assertNotIn('cost_usd', usage.turn_usage(unknown))
        self.assertEqual(usage.turn_usage(included)['cost_usd'], 0.0, 'a subscription plan costs nothing per call')
        total = usage.combine([priced, unknown])
        self.assertEqual((total['input_tokens'], total['calls'], total['model']), (150, 3, 'synthetic-model'))
        self.assertNotIn('cost_usd', total, 'one unpriced run leaves the total cost unknown')
        self.assertIsNone(usage.combine([]))

    def test_record_adds_runs_to_one_daily_row_and_drops_rows_past_retention(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            usage.record('guard', {'calls': 1}, 'm', provider='custom-1', path=path, now=DAY - 401 * 86400)
            usage.record('reply', {'input_tokens': 10, 'calls': 1, 'cost_usd': 0.5}, 'm', provider='openai', path=path, now=DAY)
            usage.record('reply', {'input_tokens': 5, 'calls': 2}, 'm', failed=True, provider='openai', path=path, now=DAY)
            usage.record('unknown-part', {'calls': 1}, 'm', provider='openai', path=path, now=DAY)
            rows = usage.rows('2000-01-01', path)
            self.assertEqual(len(rows), 1, 'the old guard row was pruned and an unknown part is not counted')
            row = rows[0]
            self.assertEqual((row['day'], row['part'], row['runs'], row['failed'], row['calls'], row['input_tokens']),
                             ('2026-10-13', 'reply', 2, 1, 3, 15))
            self.assertEqual((row['cost_usd'], row['priced_runs']), (0.5, 1), 'the unpriced run stays visible as unpriced')

    def test_refusals_and_hidden_texts_are_counted_and_an_older_table_gains_their_columns(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            path.parent.mkdir()
            old = sqlite3.connect(str(path))
            old.execute(usage.SCHEMA.replace('refused INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, ', '')
                        .replace("reasons TEXT NOT NULL DEFAULT '{}', ", ''))
            old.execute("INSERT INTO usage_daily(day,part,provider,model,runs,failed) VALUES('2026-10-13','guard','anthropic','m',3,1)")
            old.commit()
            old.close()
            usage.record('guard', {'calls': 1}, 'm', failed=True, refused=True, provider='anthropic', path=path, now=DAY)
            usage.record('guard', {'calls': 1}, 'm', refused=True, provider='anthropic', path=path, now=DAY)
            usage.note_hidden('guard', 'm', provider='anthropic', path=path, now=DAY)
            row = usage.rows('2026-10-13', path)[0]
            self.assertEqual((row['runs'], row['failed'], row['refused'], row['hidden']), (5, 3, 2, 1),
                             'a refusal is always a failure; a hidden text is not a run')
            self.assertEqual(row['reasons'], {'refused': 2}, 'the older table gains the reasons too')

    def test_failed_runs_keep_why_they_failed_as_codes_only(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            for reason in ('timed_out', 'timed_out', 'refused', 'a provider message, not a code'):
                usage.record('memory_review', {'calls': 1}, 'm', failed=True, reason=reason, provider='anthropic', path=path, now=DAY)
            usage.record('memory_review', {'calls': 1}, 'm', reason='timed_out', provider='anthropic', path=path, now=DAY)
            row = usage.rows('2026-10-13', path)[0]
            self.assertEqual((row['failed'], row['refused']), (4, 1))
            self.assertEqual(row['reasons'], {'timed_out': 2, 'refused': 1, 'unknown': 1},
                             'an unknown code is kept as unknown, and a run that worked has no reason')

    def test_why_a_hermes_turn_or_a_direct_call_failed(self):
        cases = [
            ([{'failed': True, 'failure_reason': 'content_policy_blocked', 'error': 'private words'}], 'refused'),
            ([{'completed': True, 'turn_exit_reason': 'text_response(finish_reason=refusal)', 'final_response': ''}], 'refused'),
            ([{'failed': True, 'failure_reason': 'rate_limit'}], 'rate_limited'),
            ([{'failed': True, 'failure_reason': 'server_error'}], 'provider_error'),
            ([{'failed': True, 'failure_reason': 'timeout'}], 'timed_out'),
            ([{'completed': False, 'turn_exit_reason': 'max_iterations_reached(90/90)'}], 'too_long'),
            ([{'completed': False, 'interrupted': True}], 'interrupted'),
            ([{'completed': True, 'final_response': ' '}], 'empty_answer'),
            ([{'completed': True, 'final_response': 'fine'}, {'failed': True}], 'unknown'),
            ([], 'unknown'),
        ]
        for results, reason in cases:
            self.assertEqual(usage.failure_reason(results), reason, results)
        class Status(Exception):
            def __init__(self, status_code): self.status_code = status_code
        self.assertEqual([usage.error_reason(error) for error in (Status(429), Status(401), Status(503), TimeoutError(), ValueError())],
                         ['rate_limited', 'key_rejected', 'provider_error', 'timed_out', 'unknown'])

    def test_record_never_fails_the_work_it_measures(self):
        with tempfile.TemporaryDirectory() as root:
            # Outside a Hermes installation nothing is written.
            usage.record('reply', {'calls': 1}, 'm', path=Path(root) / 'missing/usage/usage.sqlite', now=DAY)
            self.assertFalse((Path(root) / 'missing').exists())
            # A broken database is skipped quietly.
            broken = Path(root) / 'usage'
            broken.mkdir()
            (broken / 'usage.sqlite').mkdir()
            usage.record('reply', {'calls': 1}, 'm', path=broken / 'usage.sqlite', now=DAY)

    def test_record_takes_the_part_provider_from_the_settings_route(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(
                'os.environ', {'NOCHEH_REPLY_ROUTE_PROVIDER': 'anthropic', 'NOCHEH_GUARD_ROUTE_PROVIDER': 'custom-1'}):
            path = Path(root) / 'usage/usage.sqlite'
            usage.record('schedule', {'calls': 1, 'model': 'turn-model'}, 'fallback', path=path, now=DAY)
            usage.record('guard', {'calls': 1}, 'guard-model', path=path, now=DAY)
            found = {(row['part'], row['provider'], row['model']) for row in usage.rows('2026-10-13', path)}
            self.assertEqual(found, {('schedule', 'anthropic', 'turn-model'), ('guard', 'custom-1', 'guard-model')})

    def test_parts(self):
        self.assertEqual(usage.part_of({'review': True, 'channel': 'telegram'}), 'memory_review')
        self.assertEqual(usage.part_of({'channel': 'scheduler'}), 'schedule')
        self.assertEqual(usage.part_of({'channel': 'browser'}), 'browser')
        self.assertEqual(usage.part_of({'channel': 'telegram'}), 'reply')

    def test_price_uses_hermes_pricing_and_leaves_unknown_prices_empty(self):
        class Cost:
            def __init__(self, amount, status): self.amount_usd, self.status = amount, status

        def estimate(model, canonical, provider, base_url):
            if model == 'broken':
                raise RuntimeError('no table')
            return {'known': Cost(canonical.input_tokens / 1e6, 'estimated'), 'plan': Cost(None, 'included')}.get(
                model, Cost(None, 'unknown'))

        pricing = types.SimpleNamespace(CanonicalUsage=types.SimpleNamespace, estimate_usage_cost=estimate)
        rows = [{'model': name, 'input_tokens': 2_000_000, 'output_tokens': 1} for name in ('known', 'plan', 'custom', 'broken')]
        with patch.dict(sys.modules, {'agent': types.ModuleType('agent'), 'agent.usage_pricing': pricing}):
            self.assertEqual(usage.price(rows), [2.0, 0.0, None, None])
            with self.assertRaises(ValueError):
                usage.price([{'model': 3}])

    def test_claude_is_priced_from_anthropic_list_prices(self):
        million = {'input_tokens': 1_000_000, 'output_tokens': 1_000_000, 'calls': 10}
        self.assertAlmostEqual(usage.claude_cost('claude-sonnet-5-5', million), 12.0)
        self.assertAlmostEqual(usage.claude_cost('anthropic/claude-opus-5.5', million), 24.0, msg='dotted and prefixed names')
        cached = {'input_tokens': 0, 'cache_read_tokens': 1_000_000, 'cache_write_tokens': 1_000_000, 'calls': 10}
        self.assertAlmostEqual(usage.claude_cost('claude-sonnet-5-5', cached), 0.2 + 2.5)
        self.assertAlmostEqual(usage.claude_cost('claude-haiku-5-5', million), 0.6)
        self.assertAlmostEqual(usage.claude_cost('claude-haiku-5-5', {**million, 'calls': 1}), 3.0, msg='a prompt over 100K tokens')
        self.assertIsNone(usage.claude_cost('synthetic-model', million))

    def test_record_prices_claude_on_the_anthropic_provider_only_when_hermes_did_not(self):
        spent = {'input_tokens': 1_000_000, 'output_tokens': 100_000, 'calls': 4, 'model': 'claude-sonnet-5-5'}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'usage/usage.sqlite'
            usage.record('reply', spent, 'fallback', provider='anthropic', path=path, now=DAY)
            usage.record('guard', {**spent, 'cost_usd': 0.5}, 'm', provider='anthropic', path=path, now=DAY)
            usage.record('memory_review', spent, 'fallback', provider='custom-1', path=path, now=DAY)
            usage.record('schedule', {'calls': 1}, 'claude-sonnet-5-5', provider='anthropic', path=path, now=DAY)
            found = {row['part']: (round(row['cost_usd'], 6), row['priced_runs']) for row in usage.rows('2026-10-13', path)}
        self.assertEqual(found['reply'], (3.0, 1))
        self.assertEqual(found['guard'], (0.5, 1), "Hermes's own price stays")
        self.assertEqual(found['memory_review'], (0.0, 0), 'a gateway may bill differently, so its cost stays unknown')
        self.assertEqual(found['schedule'], (0.0, 0), 'a run without token counts stays unknown')

    def test_price_falls_back_to_claude_prices_on_the_anthropic_provider(self):
        class Cost:
            amount_usd, status = None, 'unknown'

        pricing = types.SimpleNamespace(CanonicalUsage=types.SimpleNamespace, estimate_usage_cost=lambda *a, **k: Cost())
        row = {'model': 'claude-sonnet-5-5', 'input_tokens': 1_000_000, 'output_tokens': 1_000_000, 'calls': 2}
        with patch.dict(sys.modules, {'agent': types.ModuleType('agent'), 'agent.usage_pricing': pricing}):
            costs = usage.price([{**row, 'provider': 'anthropic'}, {**row, 'provider': 'custom'}, row])
        self.assertEqual(costs, [12.0, None, None])


if __name__ == '__main__':
    unittest.main()
