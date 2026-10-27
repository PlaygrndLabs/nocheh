import json
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from . import prompts
from .async_runs import AsyncRuns, identity
from .privacy import filter_knowledge
from .request_boundary import Boundary, install
from .subscription import DetectorContractError, SubscriptionCredentials, detect_literals


def reply(value):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(value)))],
                           usage=None)


class PromptTests(unittest.TestCase):
    def test_owner_text_replaces_only_its_own_part_and_bad_values_use_the_default(self):
        mine = {'reply.owner': '  Answer the owner in Persian.  '}
        self.assertEqual(prompts.reply(mine, True), prompts.DEFAULTS['reply.common'] + ' Answer the owner in Persian.')
        self.assertEqual(prompts.reply(mine, False), prompts.DEFAULTS['reply.common'] + ' ' + prompts.DEFAULTS['reply.group'])
        self.assertIn('[NO_REPLY]', prompts.reply({}, False))
        for value in (None, '', '   ', 7, 'x' * (prompts.LIMIT + 1)):
            self.assertEqual(prompts.text({'reply.group': value}, 'reply.group'), prompts.DEFAULTS['reply.group'])
        self.assertEqual(prompts.text(None, 'memory.limited'), prompts.DEFAULTS['memory.limited'])

    def test_management_reports_the_defaults_for_the_dashboard(self):
        from .management import dispatch
        self.assertEqual(dispatch('/nonexistent', 'model', None, {'action': 'prompts'}),
                         {'defaults': prompts.DEFAULTS, 'limit': prompts.LIMIT})

    def test_provider_call_sends_no_empty_tools_list(self):
        import sys
        from .subscription import _call_subscription
        sent = {}

        class Completions:
            def create(self, **kwargs):
                sent.update(kwargs)
                return reply({'literals': []})

        class Client:
            def __init__(self, **kwargs):
                self.chat = SimpleNamespace(completions=Completions())

            def __enter__(self):
                return self

            def __exit__(self, *error):
                return False

        fakes = {'openai': SimpleNamespace(OpenAI=Client), 'httpx': SimpleNamespace(Client=lambda **kwargs: None)}
        with patch.dict(sys.modules, fakes):
            _call_subscription(SubscriptionCredentials('synthetic-token'), 'model',
                               [{'role': 'user', 'content': 'hello'}])
        self.assertNotIn('tools', sent)
        self.assertEqual(sent['messages'], [{'role': 'user', 'content': 'hello'}])

    def test_secret_check_uses_the_owner_text_and_keeps_its_contract(self):
        credentials, mine = SubscriptionCredentials('synthetic-token'), {'guard.secret_check': 'Find only passwords. Return {"literals":[]}.'}
        with patch('services.hermes.subscription._call_subscription', return_value=reply({'literals': []})) as call:
            self.assertEqual(detect_literals('Password: kite', credentials, 'model', mine), [])
        self.assertEqual(call.call_args.args[2][0]['content'], mine['guard.secret_check'])
        with patch('services.hermes.subscription._call_subscription', return_value=reply({'literals': ['absent']})):
            with self.assertRaises(DetectorContractError):
                detect_literals('Password: kite', credentials, 'model', mine)

    def test_secret_check_retries_once_when_a_waking_provider_refuses(self):
        credentials = SubscriptionCredentials('synthetic-token')
        class Waking(Exception):
            status_code = 503
        class Refused(Exception):
            status_code = 401
        with patch('services.hermes.subscription.RETRY_SECONDS', 0), \
                patch('services.hermes.usage.record') as record:
            with patch('services.hermes.subscription._call_subscription', side_effect=[Waking(), reply({'literals': ['kite']})]) as call:
                self.assertEqual(detect_literals('Password: kite', credentials, 'model'), ['kite'])
            self.assertEqual(call.call_count, 2)
            self.assertEqual([entry.args[3] for entry in record.call_args_list], [True, False], 'each attempt is counted')
            with patch('services.hermes.subscription._call_subscription', side_effect=[Waking(), Waking(), reply({'literals': []})]) as call:
                with self.assertRaises(Waking):
                    detect_literals('Password: kite', credentials, 'model')
            self.assertEqual(call.call_count, 2, 'a provider still failing goes back to the workflow')
            with patch('services.hermes.subscription._call_subscription', side_effect=[Refused(), reply({'literals': []})]) as call:
                with self.assertRaises(Refused):
                    detect_literals('Password: kite', credentials, 'model')
            self.assertEqual(call.call_count, 1, 'a refused key is not retried')
            with patch('services.hermes.subscription._call_subscription', side_effect=[reply({'literals': ['absent']}), reply({'literals': []})]) as call:
                with self.assertRaises(DetectorContractError):
                    detect_literals('Password: kite', credentials, 'model')
            self.assertEqual(call.call_count, 1, 'a bad answer is not retried')

    def test_group_filter_uses_the_owner_text_and_still_adds_privacy_rules(self):
        restore = install(Boundary('on', transform=lambda url, payload: payload))
        try:
            def call(credentials, model, messages):
                self.assertEqual(messages[0]['content'], 'Share only recipes. Additional owner privacy rules: No names.')
                return reply({'items': []})
            with patch('services.hermes.privacy._call_subscription', side_effect=call):
                filter_knowledge(SimpleNamespace(provider='openai', api_mode='chat_completions'), 'model',
                                 {'candidates': [], 'instructions': 'No names.', 'prompts': {'sharing.group_filter': 'Share only recipes.'}})
        finally:
            restore()

    def test_a_retried_run_keeps_its_first_texts(self):
        with tempfile.TemporaryDirectory() as folder:
            runs = AsyncRuns(folder, lambda body: {'state': 'done'}, lambda run: None)
            body = {'channel': 'browser', 'event_id': 'a' * 64, 'attempt': 1, 'prompts': {'reply.owner': 'First'}}
            with patch.object(AsyncRuns, '_launch'):
                runs.start(body)
                runs.start({**body, 'prompts': {'reply.owner': 'Changed later'}})
                with self.assertRaisesRegex(ValueError, 'run_identity_conflict'):
                    runs.start({**body, 'text': 'different'})
            saved = json.loads(runs._path(identity(body), '.request').read_text())
            self.assertEqual(saved['prompts'], {'reply.owner': 'First'})

if __name__ == '__main__':
    unittest.main()
