"""Images read by Hermes's own vision tool for Nocheh's preparation step."""
import base64
import json
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from services.hermes import image_text, prompts, usage

ROUTE = {'NOCHEH_IMAGE_ROUTE_URL': 'https://images.example.test/v1', 'NOCHEH_IMAGE_ROUTE_KEY': 'synthetic-image-key',
         'NOCHEH_IMAGE_ROUTE_MODEL': 'vision-model', 'NOCHEH_IMAGE_ROUTE_PROVIDER': 'gateway'}


def hermes(result, spent=None):
    """Stand-ins for Hermes's vision tool and its usage accounting."""
    accounting = types.ModuleType('agent.aux_accounting')
    tools = types.ModuleType('tools.vision_tools')
    holder = {}
    accounting.set_accounting_context = lambda ledger, session: holder.update(ledger=ledger)
    tools.calls = []

    async def analyze(path, prompt):
        tools.calls.append((Path(path).read_bytes(), prompt))
        if spent:
            holder['ledger'].record_auxiliary_usage('nocheh-image', 'vision', model='vision-model', **spent)
        return json.dumps(result)
    tools.vision_analyze_tool = analyze
    return {'agent.aux_accounting': accounting, 'tools.vision_tools': tools}, tools


class ImageTextTests(unittest.TestCase):
    def read(self, result, spent=None):
        modules, tools = hermes(result, spent)
        with patch.dict(sys.modules, modules):
            return image_text.read(b'synthetic image', {'prompt': 'Read it.'}), tools.calls

    def test_the_text_and_tokens_of_one_reading_come_back(self):
        found, calls = self.read({'success': True, 'analysis': 'GARDEN CLUB\nA made-up sign.'},
                                 {'input_tokens': 1500, 'output_tokens': 40, 'estimated_cost_usd': 0.005})
        self.assertEqual(found, {'state': 'done', 'text': 'GARDEN CLUB\nA made-up sign.',
                                 'usage': {'input_tokens': 1500, 'output_tokens': 40, 'cache_read_tokens': 0,
                                           'cache_write_tokens': 0, 'reasoning_tokens': 0, 'model': 'vision-model', 'cost_usd': 0.005}})
        self.assertEqual(calls, [(b'synthetic image', 'Read it.')])

    def test_failures_say_whether_a_retry_can_help(self):
        busy = self.read({'success': False, 'error': 'Error analyzing image: Error code: 529 - overloaded'}, {'input_tokens': 0})[0]
        self.assertEqual((busy['state'], busy['reason']), ('failed', 'provider_error'))
        refused = self.read({'success': False, 'error': 'Error analyzing image: content_policy violation'}, {'input_tokens': 10})[0]
        self.assertEqual(refused['reason'], 'refused')
        self.assertEqual(self.read({'success': False, 'error': 'Error analyzing image: cannot identify image file'})[0], {'state': 'unreadable'})

    def test_without_a_provider_images_are_kept_only(self):
        with patch.dict('os.environ', {**ROUTE, 'NOCHEH_IMAGE_ROUTE_KEY': ''}), patch.object(image_text.subprocess, 'run') as run:
            self.assertEqual(image_text.read_image({'bytes_base64': ''}), {'state': 'not_configured'})
            run.assert_not_called()

    def test_a_child_with_its_own_hermes_home_and_only_the_image_key_reads_the_owner_instruction(self):
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode(), 'prompts': {'images.read': 'Only the text, please.'}}
        seen = {}

        def run(command, **options):
            seen.update(env=options['env'], config=json.loads(Path(options['env']['HERMES_HOME'], 'config.yaml').read_text()),
                        hint=json.loads(command[-1]))
            return subprocess.CompletedProcess(command, 0, json.dumps({'state': 'done', 'text': 'Synthetic',
                                                                       'usage': {'input_tokens': 1200, 'output_tokens': 30}}).encode(), b'')
        with tempfile.TemporaryDirectory() as state, patch.dict('os.environ', {**ROUTE, 'SERVICE_TOKEN': 'synthetic-service-token'}), \
                patch.object(image_text.subprocess, 'run', side_effect=run), patch.object(usage, 'price', return_value=[0.004]):
            target = Path(state) / 'hermes/usage/usage.sqlite'
            target.parent.mkdir(parents=True)
            with patch.object(usage, 'DATABASE', target):
                self.assertEqual(image_text.read_image(body), {'state': 'done', 'text': 'Synthetic'})
                rows = usage.rows('2000-01-01', target)
        self.assertNotIn('SERVICE_TOKEN', seen['env'])
        self.assertEqual(seen['env'][image_text.KEY], 'synthetic-image-key')
        self.assertEqual(seen['config']['auxiliary']['vision'], {'provider': 'custom', 'model': 'vision-model',
                         'base_url': 'https://images.example.test/v1', 'api_key': '${env:' + image_text.KEY + '}'})
        self.assertEqual(seen['hint'], {'prompt': 'Only the text, please.'})
        self.assertEqual([(row['part'], row['provider'], row['input_tokens'], row['cost_usd'], row['priced_runs']) for row in rows],
                         [('image', 'gateway', 1200, 0.004, 1)], 'a cost Hermes did not report is priced from its table')
        with patch.dict('os.environ', ROUTE), patch.object(image_text.subprocess, 'run', side_effect=run):
            image_text.read_image({'bytes_base64': body['bytes_base64']})
        self.assertEqual(seen['hint'], {'prompt': prompts.DEFAULTS['images.read']})

    def test_a_hung_child_is_a_failure_to_retry(self):
        body = {'bytes_base64': base64.b64encode(b'synthetic').decode()}
        with patch.dict('os.environ', ROUTE), patch.object(image_text.subprocess, 'run', side_effect=subprocess.TimeoutExpired('image', 1)):
            self.assertEqual(image_text.read_image(body), {'state': 'failed', 'reason': 'timed_out'})


if __name__ == '__main__':
    unittest.main()
