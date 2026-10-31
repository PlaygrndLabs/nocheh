"""Import › learning cost: a rough estimate before the owner turns learning on."""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from tools.operations.archive import learning_estimate
from tools.operations.installation.configuration import env_path, initialize, read_env, write_env
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

    def test_without_history_typical_tokens_are_priced_for_memory_and_each_message(self):
        asked = []

        def call(path, body, timeout):
            asked.append(body['rows'])
            return {'costs': [0.3, 1.5, 4.2, 38.4]}
        estimate = learning_estimate.estimate(self.state, 1200, 90000, call=call, now=DAY, images=500)
        result = estimate['learning']
        check, memory, images, learning = asked[0]
        # Each message's words twice plus its other fields, in calls of up to 45,000 characters.
        self.assertEqual((check['model'], check['calls']), ('guard-model', 8))
        self.assertEqual(estimate['secret_check'], {'cost_usd': 0.3, 'calls': 8})
        # 90,000 characters are about 30 Honcho windows, plus a summary every 20 and every 60 messages.
        self.assertEqual((memory['model'], memory['calls']), ('memory-model', 30 + 60 + 20))
        # Imported history writes no memory notes; long-term memory answers one learning question per message.
        self.assertEqual((learning['model'], learning['calls'], learning['input_tokens']), ('memory-model', 1200, 1200 * 20000))
        self.assertNotIn('reply-model', [row['model'] for row in asked[0]])
        self.assertEqual(result['cost_usd'], 39.9)
        # Each image is read once with the Images model, here the main one.
        self.assertEqual((images['model'], images['calls'], images['input_tokens']), ('claude-sonnet-5-5', 500, 500 * 1800))
        self.assertEqual(estimate['images'], {'count': 500, 'model': 'claude-sonnet-5-5', 'cost_usd': 4.2})
        self.assertEqual([(part['part'], part['measured']) for part in result['parts']], [('memory', False), ('learning', False)])

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
            return {'costs': [0.1, 0.75, 0.0, 2.5]}
        result = learning_estimate.estimate(self.state, 1000, 0, call=call, now=DAY)['learning']
        self.assertEqual((asked[0][1]['input_tokens'], asked[0][1]['output_tokens']), (2000 * 66, 300 * 66))
        self.assertEqual([part['cost_usd'] for part in result['parts']], [0.75, 2.5])
        self.assertEqual(result['cost_usd'], 3.25)
        self.assertEqual([part['measured'] for part in result['parts']], [True, False])

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
        result = learning_estimate.estimate(self.state, 10, 500, call=lambda *a, **k: {'costs': [0.01, None, None, 0.1]}, now=DAY)
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
