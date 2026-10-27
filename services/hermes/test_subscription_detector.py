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

    def test_the_one_answer_inside_a_fence_or_sentence_is_used_and_anything_else_fails_closed(self):
        text='Password: juniper-ONLY-7642';credentials=SubscriptionCredentials('synthetic-token')
        fenced=lambda content:SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])
        body=json.dumps({'literals':['juniper-ONLY-7642']})
        for content in ('```json\n'+body+'\n```','```\n'+body+'\n```\n','Here it is: ```json\n'+body+'\n```',
                        '```json\n'+body+'\n``` and more','I found one password.\n\n'+body,body+'\nThat is the only secret.',
                        'Answer: '+body+' Repeated: '+body):
            with self.subTest(content=content),patch('services.hermes.subscription._call_subscription',return_value=fenced(content)):
                self.assertEqual(detect_literals(text,credentials,'model'),['juniper-ONLY-7642'])
        for content in ('```json\n```','No secrets here.','{"literals":[]} or maybe '+body,
                        'Here: {"literals":["juniper-ONLY-7642"],"note":"x"}','Here: {"literals":["absent"]}',None):
            with self.subTest(content=content),patch('services.hermes.subscription._call_subscription',return_value=fenced(content)):
                with self.assertRaises(DetectorContractError):
                    detect_literals(text,credentials,'model')

    def test_a_rejected_reply_is_described_by_its_shape_not_its_content(self):
        text='Password: juniper-ONLY-7642';credentials=SubscriptionCredentials('synthetic-token')
        content='The password is juniper-ONLY-7642 but I cannot format it'
        cut=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content),finish_reason='length')])
        with patch('services.hermes.subscription._call_subscription',return_value=cut):
            with self.assertRaises(DetectorContractError) as raised:
                detect_literals(text,credentials,'model')
        self.assertEqual(str(raised.exception),'detector_json_rejected')
        self.assertEqual(raised.exception.shape,{'length':len(content),'fence':False,'object':False,'prose_before':True,
                                                 'prose_after':False,'finish_reason':'length'})
        self.assertNotIn('juniper',json.dumps(raised.exception.shape))
        empty=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None),finish_reason='stop')])
        with patch('services.hermes.subscription._call_subscription',return_value=empty):
            with self.assertRaises(DetectorContractError) as raised:
                detect_literals(text,credentials,'model')
        self.assertEqual(raised.exception.shape,{'type':'NoneType','finish_reason':'stop'})

    def test_a_safety_filter_decline_is_reported_as_a_refusal(self):
        text='Password: juniper-ONLY-7642';credentials=SubscriptionCredentials('synthetic-token')
        for content in ('',None,json.dumps({'literals':[]})):
            declined=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content),finish_reason='content_filter')])
            with self.subTest(content=content),patch('services.hermes.subscription._call_subscription',return_value=declined):
                with self.assertRaises(DetectorContractError) as raised:
                    detect_literals(text,credentials,'model')
                self.assertEqual(str(raised.exception),'detector_refused')
                self.assertEqual(raised.exception.shape['finish_reason'],'content_filter')

    def test_transport_cannot_be_redirected_and_hides_its_key(self):
        for url,provider,mode in (('https://untrusted.example/v1','openai','chat_completions'),
                                  ('https://chatgpt.com/backend-api/codex','openai-codex','codex_responses'),
                                  (BROKER_URL,'openai-codex','codex_responses')):
            with self.subTest(url=url),self.assertRaises(ValueError):
                SubscriptionCredentials('token',url,provider,mode)
        self.assertNotIn('synthetic-token',repr(SubscriptionCredentials('synthetic-token')))


if __name__=='__main__':unittest.main()
