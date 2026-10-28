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
            old.execute(usage.SCHEMA.replace('refused INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, ', ''))
            old.execute("INSERT INTO usage_daily(day,part,provider,model,runs,failed) VALUES('2026-10-13','guard','anthropic','m',3,1)")
            old.commit()
            old.close()
            usage.record('guard', {'calls': 1}, 'm', failed=True, refused=True, provider='anthropic', path=path, now=DAY)
            usage.record('guard', {'calls': 1}, 'm', refused=True, provider='anthropic', path=path, now=DAY)
            usage.note_hidden('guard', 'm', provider='anthropic', path=path, now=DAY)
            row = usage.rows('2026-10-13', path)[0]
            self.assertEqual((row['runs'], row['failed'], row['refused'], row['hidden']), (5, 3, 2, 1),
                             'a refusal is always a failure; a hidden text is not a run')

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


if __name__ == '__main__':
    unittest.main()
