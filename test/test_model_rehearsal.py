"""Causal reply matching for real-model observations with late deliveries."""
import unittest
from unittest.mock import patch
from tools.acceptance.model_rehearsal import main, replies_to, retire_synthetic_name_sources, selected_cases, validate_paid_egress


class ModelRehearsalReplyTests(unittest.TestCase):
    def test_real_embedding_fixture_requires_one_nonpublic_egress(self):
        valid={'networks':{'honcho-egress':{'internal':False},'existing-model':{'external':True},
                           'default':{'internal':True}},'services':{
            'honcho-provider-gateway':{'networks':{'honcho-egress':None}},
            'fixture-real-provider':{'networks':{'existing-model':None}},
            'hermes':{'networks':{'default':None}}}}
        validate_paid_egress(valid)
        for changed in (
            {**valid,'networks':{'honcho-egress':{'internal':True}}},
            {**valid,'services':{**valid['services'],'hermes':{'networks':{'honcho-egress':None}}}},
            {**valid,'services':{**valid['services'],'hermes':{'networks':{'existing-model':None}}}},
            {**valid,'networks':{**valid['networks'],'default':{'internal':False}}},
            {**valid,'services':{**valid['services'],'hermes':{'ports':['8781:8781']}}},
        ):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                validate_paid_egress(changed)

    def test_focused_topic_window_excludes_restart_and_retirement(self):
        self.assertEqual(selected_cases('topic_isolation', 'topic_isolation'), ('topic_isolation',))
        self.assertNotIn('retired_fact', selected_cases('topic_isolation', 'topic_isolation'))

    def test_late_and_unrelated_replies_do_not_become_the_current_answer(self):
        late = {'parameters': {'reply_parameters': '{"message_id":7}'}, 'message': {'text': 'earlier answer', 'chat': {'id': 123}}}
        current = {'parameters': {'reply_parameters': {'message_id': 8}}, 'message': {'text': 'current answer', 'chat': {'id': 123}}}
        unbound = {'parameters': {}, 'message': {'text': 'unrelated'}}
        self.assertEqual(replies_to({'sent': [late, current, unbound]}, 8, 123), [current])
        self.assertEqual(replies_to({'sent': [late, unbound]}, 8, 123), [])

    def test_same_message_number_in_another_chat_is_not_the_answer(self):
        other = {'parameters': {'reply_parameters': {'message_id': 8}}, 'message': {'chat': {'id': -10042}}}
        self.assertEqual(replies_to({'sent': [other]}, 8, 123), [])

    def test_duplicate_physical_replies_remain_visible(self):
        row = {'parameters': {'reply_parameters': '{"message_id":8}'}, 'message': {'text': 'answer', 'chat': {'id': 123}}}
        self.assertEqual(len(replies_to({'sent': [row, row]}, 8, 123)), 2)

    def test_retirement_explicitly_includes_independent_delivered_answer(self):
        original, answer = 'a'*64, 'b'*64
        class Fixture:
            def __init__(self): self.posts=[]
            def query(self, database, sql):
                self_database = database
                assert self_database == 'nocheh_archive'
                assert "kind IN ('telegram_update','telegram_delivered_message')" in sql
                assert "scope='123'" in sql
                return original + '\n' + answer
            def http(self, path, body=None):
                event_id = path.split('/')[3]
                if body is None:
                    return {'event_id':event_id,'retired':event_id==original,
                            'revision':1 if event_id==original else 0}
                self.posts.append((event_id,body))
                return {'event_id':event_id,'retired':True,'revision':body['expected_revision']+1}
        fixture=Fixture()
        ids, decisions=retire_synthetic_name_sources(fixture,original,'synthetic-case')
        self.assertEqual(ids,[original,answer])
        self.assertEqual([decision['retired'] for decision in decisions],[True,True])
        self.assertEqual(fixture.posts,[(answer,{'retired':True,'expected_revision':0,
                                                'operation_id':'synthetic-case-'+answer})])
        with patch.object(fixture,'query',return_value=answer):
            with self.assertRaisesRegex(AssertionError,'private_fact_source_missing'):
                retire_synthetic_name_sources(fixture,original,'synthetic-case')

    def test_invalid_continuation_stops_before_opening_a_fixture(self):
        for options in (['--start-at', 'retired_fact'], ['--isolation-topic', '0'], ['--isolation-topic', '7'],
                        ['--reuse-seeds', '/unused/observations.json', '--start-at', 'retired_fact',
                         '--stop-after', 'topic_isolation']):
            with self.subTest(options=options), patch('sys.argv', ['model-rehearsal', '--directory', '/unused', *options]), \
                    patch('sys.stderr'), patch('tools.acceptance.model_rehearsal.Fixture') as fixture:
                with self.assertRaises(SystemExit) as stopped:
                    main()
                self.assertEqual(stopped.exception.code, 2)
                fixture.assert_not_called()


if __name__ == '__main__':
    unittest.main()
