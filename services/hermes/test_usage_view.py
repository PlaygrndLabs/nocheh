"""System › Usage: every part's model use, from Hermes and Honcho, in one list."""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from tools.operations.installation.configuration import env_path, initialize, read_env, write_env
from tools.operations.provider import usage as view_usage
from services.hermes import usage as hermes_usage
from services.honcho.meter import Ledger

DAY = datetime(2026, 10, 13, 12, tzinfo=timezone.utc).timestamp()
GATEWAY = {'id': 'custom-1', 'name': 'Synthetic gateway', 'url': 'https://gateway.example.test/v1'}


class UsageViewTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.state = Path(folder.name)
        initialize(self.state)
        values = read_env(env_path(self.state))
        values['NOCHEH_PROVIDERS'] = json.dumps([GATEWAY])
        write_env(env_path(self.state), values)

    def honcho(self, route, status, usage, provider, model):
        ledger = Ledger(self.state / 'honcho/ledger/budget.sqlite')
        with patch('services.honcho.meter.time.time', return_value=DAY):
            call = ledger.reserve(route, b'synthetic')
            ledger.finish(call, status, .1, usage, 'response', provider=provider, model=model)

    def test_one_list_holds_hermes_and_honcho_parts_with_unknown_costs_left_unknown(self):
        hermes = self.state / 'hermes/usage/usage.sqlite'
        hermes_usage.record('reply', {'input_tokens': 100, 'output_tokens': 10, 'calls': 2, 'cost_usd': 0.01}, 'reply-model',
                            provider='openai', path=hermes, now=DAY)
        hermes_usage.record('guard', {'calls': 1}, 'guard-model', provider='custom-1', path=hermes, now=DAY)
        hermes_usage.record('reply', {'calls': 1}, 'reply-model', provider='openai', path=hermes, now=DAY - 40 * 86400)
        self.honcho('/v1/embeddings', 200, {'prompt_tokens': 1000, 'total_tokens': 1000}, 'openai', 'text-embedding-3-small')
        self.honcho('/v1/chat/completions', 200, {'prompt_tokens': 300, 'completion_tokens': 30}, 'custom-1', 'memory-model')
        asked = []

        def call(path, body, timeout):
            asked.append(body)
            return {'costs': [None]}

        result = view_usage.view(self.state, 30, call=call, now=DAY)
        self.assertEqual((result['since'], result['today']), ('2026-09-14', '2026-10-13'))
        rows = {row['part']: row for row in result['rows']}
        self.assertEqual(set(rows), {'reply', 'guard', 'embedding', 'memory'}, 'the 40-day-old row is outside the period')
        self.assertEqual((rows['reply']['label'], rows['reply']['service'], rows['reply']['provider_name']),
                         ('Telegram replies', 'Hermes', 'OpenAI'))
        self.assertEqual((rows['reply']['cost_usd'], rows['reply']['cost_complete']), (0.01, True))
        self.assertIsNone(rows['guard']['cost_usd'], 'a run without a price is unknown, not free')
        self.assertEqual(rows['guard']['provider_name'], 'Synthetic gateway')
        self.assertEqual((rows['embedding']['service'], rows['embedding']['input_tokens']), ('Honcho', 1000))
        self.assertTrue(rows['embedding']['cost_complete'])
        self.assertEqual((rows['memory']['model'], rows['memory']['output_tokens']), ('memory-model', 30))
        self.assertIsNone(rows['memory']['cost_usd'])
        # Memory tokens go to Hermes's price list with the provider's kind and address, never a key.
        self.assertEqual(asked, [{'rows': [{'model': 'memory-model', 'provider': 'custom', 'base_url': GATEWAY['url'],
                                            'calls': 1, 'input_tokens': 300, 'output_tokens': 30}]}])
        self.assertEqual(result['sources'], {'hermes': 'ok', 'honcho': 'ok', 'pricing': 'ok'})

    def test_memory_is_priced_when_hermes_knows_the_model_and_unknown_when_hermes_is_down(self):
        self.honcho('/v1/chat/completions', 200, {'prompt_tokens': 300, 'completion_tokens': 30}, 'openai', 'memory-model')
        priced = view_usage.view(self.state, 1, call=lambda *a, **k: {'costs': [0.25]}, now=DAY)
        self.assertEqual((priced['rows'][0]['cost_usd'], priced['rows'][0]['cost_complete']), (0.25, True))

        def down(*args, **kwargs):
            raise OSError('hermes is down')
        unavailable = view_usage.view(self.state, 1, call=down, now=DAY)
        self.assertIsNone(unavailable['rows'][0]['cost_usd'])
        self.assertEqual(unavailable['sources'], {'hermes': 'empty', 'honcho': 'ok', 'pricing': 'unavailable'})

    def test_a_fresh_installation_has_an_empty_view_and_rejects_odd_periods(self):
        result = view_usage.view(self.state, 7, call=lambda *a, **k: self.fail('nothing to price'), now=DAY)
        self.assertEqual(result['rows'], [])
        self.assertEqual([part['id'] for part in result['parts']],
                         ['reply', 'browser', 'schedule', 'memory_review', 'guard', 'memory', 'embedding'])
        self.assertEqual(result['sources'], {'hermes': 'empty', 'honcho': 'empty', 'pricing': 'not_needed'})
        for days in (0, 401, '7', 1.5, True):
            with self.assertRaises(ValueError):
                view_usage.view(self.state, days, call=lambda *a, **k: {}, now=DAY)


if __name__ == '__main__':
    unittest.main()
