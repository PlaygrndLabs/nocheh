"""Import › learning cost: a rough estimate before the owner turns learning on."""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from tools.operations.archive import learning_estimate
from tools.operations.installation.configuration import env_path, initialize, read_env, write_env
from services.hermes import usage
from services.honcho.meter import Ledger

DAY = datetime(2026, 10, 13, 12, tzinfo=timezone.utc).timestamp()


class LearningEstimateTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.state = Path(folder.name)
        initialize(self.state)
        values = read_env(env_path(self.state))
        values.update(NOCHEH_PROVIDER='anthropic', NOCHEH_REPLY_MODEL='reply-model', NOCHEH_MEMORY_MODEL='memory-model',
                      NOCHEH_GUARD_PROVIDER='anthropic', NOCHEH_GUARD_MODEL='guard-model')
        write_env(env_path(self.state), values)

    def test_without_history_typical_tokens_are_priced_for_memory(self):
        asked = []

        def call(path, body, timeout):
            asked.append(body['rows'])
            return {'costs': [0.3, 1.5, 0.25, 4.2]}
        estimate = learning_estimate.estimate(self.state, 1200, 90000, call=call, now=DAY, images=500)
        result = estimate['learning']
        check, memory, learned_check, images = asked[0]
        # Each message's words twice plus its other fields, in calls of up to 45,000 characters.
        self.assertEqual((check['model'], check['calls']), ('guard-model', 8))
        self.assertEqual(estimate['secret_check'], {'cost_usd': 0.3, 'calls': 8})
        # 90,000 characters are about 30 Honcho windows, plus a summary every 20 and every 60 messages.
        self.assertEqual((memory['model'], memory['calls']), ('memory-model', 30 + 60 + 20))
        # Imported history writes no memory notes and asks no learning question about each message.
        self.assertNotIn('reply-model', [row['model'] for row in asked[0]])
        # Learning secret-checks what each Honcho call wrote, about twice per call.
        self.assertEqual((learned_check['model'], learned_check['calls']), ('guard-model', 2 * 110))
        self.assertEqual((learned_check['input_tokens'], learned_check['output_tokens']), (220 * (200 + 300), 220 * 300))
        self.assertEqual(result['cost_usd'], 1.75)
        # Each image is read once with the Images model, here the main one.
        self.assertEqual((images['model'], images['calls'], images['input_tokens']), ('claude-sonnet-5-5', 500, 500 * 1800))
        self.assertEqual(estimate['images'], {'count': 500, 'model': 'claude-sonnet-5-5', 'cost_usd': 4.2})
        self.assertEqual([(part['part'], part['cost_usd'], part['measured']) for part in result['parts']],
                         [('memory', 1.5, False), ('guard', 0.25, False)])

    def test_recent_memory_calls_set_the_tokens_of_each_memory_call(self):
        ledger = Ledger(self.state / 'honcho/ledger/budget.sqlite')
        for _ in range(learning_estimate.HISTORY):
            with patch('services.honcho.meter.time.time', return_value=DAY):
                started = ledger.reserve('/v1/chat/completions', b'synthetic')
                ledger.finish(started, 200, .1, {'prompt_tokens': 2000, 'completion_tokens': 300}, 'response',
                              provider='anthropic', model='memory-model')
        asked = []

        def call(path, body, timeout):
            asked.append(body['rows'])
            return {'costs': [0.1, 0.75, 0.05, 0.0]}
        result = learning_estimate.estimate(self.state, 1000, 0, call=call, now=DAY)['learning']
        self.assertEqual((asked[0][1]['input_tokens'], asked[0][1]['output_tokens']), (2000 * 66, 300 * 66))
        # What memory calls wrote here sets what learning's secret check reads.
        self.assertEqual(asked[0][2]['input_tokens'], 2 * 66 * (150 + 300))
        self.assertEqual(result['cost_usd'], 0.8)
        # Without recent secret checks, their answers stay typical.
        self.assertEqual([part['measured'] for part in result['parts']], [True, False])
        hermes_usage = self.state / 'hermes/usage/usage.sqlite'
        hermes_usage.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(learning_estimate.HISTORY):
            usage.record('guard', {'input_tokens': 900, 'output_tokens': 20}, 'guard-model', provider='anthropic', path=hermes_usage, now=DAY)
        asked.clear()
        result = learning_estimate.estimate(self.state, 1000, 0, call=call, now=DAY)['learning']
        self.assertEqual((asked[0][0]['output_tokens'], asked[0][2]['output_tokens']), (20 * 4, 20 * 2 * 66))
        self.assertEqual([part['measured'] for part in result['parts']], [True, True])

    def test_with_the_secret_check_off_learning_runs_no_check_of_its_own(self):
        values = read_env(env_path(self.state))
        values.update(NOCHEH_GUARD_MODE='off')
        write_env(env_path(self.state), values)
        asked = []

        def call(path, body, timeout):
            asked.append(body['rows'])
            return {'costs': [0.3, 1.5, 0.0, 0.0]}
        estimate = learning_estimate.estimate(self.state, 1200, 90000, call=call, now=DAY)
        # The import itself is still checked; Honcho's requests are not.
        self.assertEqual((asked[0][0]['calls'], asked[0][2]['calls']), (8, 0))
        self.assertEqual([part['part'] for part in estimate['learning']['parts']], ['memory'])
        self.assertEqual(estimate['learning']['cost_usd'], 1.5)

    def test_voice_notes_are_priced_per_minute_once_their_provider_has_a_key(self):
        down = lambda *args, **kwargs: {'costs': [None, None, None, None]}
        archived = learning_estimate.estimate(self.state, 10, 500, call=down, now=DAY, voice_notes=3, voice_seconds=600)['voice']
        self.assertEqual(archived, {'configured': False, 'notes': 3, 'minutes': 10.0, 'cost_usd': None})
        values = read_env(env_path(self.state))
        values.update(OPENAI_API_KEY='synthetic-openai-key', NOCHEH_TRANSCRIPTION_MODEL='gpt-4o-mini-transcribe')
        write_env(env_path(self.state), values)
        priced = learning_estimate.estimate(self.state, 10, 500, call=down, now=DAY, voice_notes=400, voice_seconds=36000)['voice']
        self.assertEqual(priced, {'configured': True, 'notes': 400, 'minutes': 600.0, 'model': 'gpt-4o-mini-transcribe', 'cost_usd': 1.8})

    def test_no_price_means_no_estimate_rather_than_zero(self):
        result = learning_estimate.estimate(self.state, 10, 500, call=lambda *a, **k: {'costs': [0.01, 0.02, None, None]}, now=DAY)
        self.assertIsNone(result['learning']['cost_usd'])
        self.assertEqual(result['secret_check']['cost_usd'], 0.01)
        self.assertIsNone(result['images']['cost_usd'])

        def down(*args, **kwargs):
            raise OSError('hermes is down')
        unpriced = learning_estimate.estimate(self.state, 10, 500, call=down, now=DAY)
        self.assertIsNone(unpriced['learning']['cost_usd'])
        self.assertIsNone(unpriced['secret_check']['cost_usd'])
        with self.assertRaises(ValueError):
            learning_estimate.estimate(self.state, -1, 0, call=down, now=DAY)


if __name__ == '__main__':
    unittest.main()
