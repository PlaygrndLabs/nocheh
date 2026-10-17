"""The trusted detector prompt must distinguish ordinary markers from credentials."""

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from .subscription import BROKER_URL, DetectorContractError, SubscriptionCredentials, detect_literals


def response(output):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(output)))])


class DetectorTests(unittest.TestCase):
    def test_harmless_marker_is_not_described_as_a_credential(self):
        credentials=SubscriptionCredentials('synthetic-token')
        with patch('services.hermes.subscription._call_subscription',return_value=response({'literals':[]})) as call:
            self.assertEqual(detect_literals('My test marker is blue kite.',credentials,'model'),[])
        system,user=call.call_args.args[2]
        self.assertIn('test marker',system['content'])
        self.assertIn('explicitly used for authentication',system['content'])
        self.assertEqual(user['content'],'My test marker is blue kite.')

    def test_explicit_password_still_masks_and_unmatched_literal_fails_closed(self):
        credentials=SubscriptionCredentials('synthetic-token',BROKER_URL)
        with patch('services.hermes.subscription._call_subscription',return_value=response({'literals':['juniper-ONLY-7642']})):
            self.assertEqual(detect_literals('Password: juniper-ONLY-7642',credentials,'model'),['juniper-ONLY-7642'])
        with patch('services.hermes.subscription._call_subscription',return_value=response({'literals':['not-present']})):
            with self.assertRaises(DetectorContractError):
                detect_literals('Password: juniper-ONLY-7642',credentials,'model')

    def test_detector_rejects_rewrites_and_invalid_contracts(self):
        text='Aws pass: abC123 سلام';credentials=SubscriptionCredentials('synthetic-token')
        for output in ({'literals':['ABC123']},{'literals':['']},{'literals':[3]},
                       {'literals':'abC123'},{'literals':[],'rewritten':text},[]):
            with self.subTest(output=output),patch('services.hermes.subscription._call_subscription',return_value=response(output)):
                with self.assertRaises(ValueError):
                    detect_literals(text,credentials,'test-model')

    def test_one_json_code_fence_is_accepted_and_other_wrapping_fails_closed(self):
        text='Password: juniper-ONLY-7642';credentials=SubscriptionCredentials('synthetic-token')
        fenced=lambda content:SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])
        body=json.dumps({'literals':['juniper-ONLY-7642']})
        for content in ('```json\n'+body+'\n```','```\n'+body+'\n```\n'):
            with self.subTest(content=content),patch('services.hermes.subscription._call_subscription',return_value=fenced(content)):
                self.assertEqual(detect_literals(text,credentials,'model'),['juniper-ONLY-7642'])
        for content in ('Here it is: ```json\n'+body+'\n```','```json\n'+body+'\n``` and more','```json\n```'):
            with self.subTest(content=content),patch('services.hermes.subscription._call_subscription',return_value=fenced(content)):
                with self.assertRaises(DetectorContractError):
                    detect_literals(text,credentials,'model')

    def test_transport_cannot_be_redirected_and_hides_its_key(self):
        for url,provider,mode in (('https://untrusted.example/v1','openai','chat_completions'),
                                  ('https://chatgpt.com/backend-api/codex','openai-codex','codex_responses'),
                                  (BROKER_URL,'openai-codex','codex_responses')):
            with self.subTest(url=url),self.assertRaises(ValueError):
                SubscriptionCredentials('token',url,provider,mode)
        self.assertNotIn('synthetic-token',repr(SubscriptionCredentials('synthetic-token')))


if __name__=='__main__':unittest.main()
