"""Real-model rehearsal: one bounded relay exit and causal reply matching."""
import asyncio
import copy
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.paths import ROOT
from tools.acceptance.model_rehearsal import (enable_relay, main, next_update_base, read_upstream, replies_to,
    retire_synthetic_name_sources, selected_cases, validate_model_egress)

PROJECT = 'nocheh-installation-' + 'a' * 12


def manifest():
    return {'name': PROJECT, 'networks': {'default': {'internal': True, 'name': PROJECT + '_default'}},
            'services': {'model-fixture': {'environment': {'NOCHEH_INSTALLATION_FIXTURE': '1'}, 'networks': {'default': None},
                                           'volumes': []},
                         'hermes': {'networks': {'default': None}}}}


class ModelRehearsalReplyTests(unittest.TestCase):
    def test_only_the_model_relay_gets_an_egress_network(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / 'state').mkdir()
            upstream = directory / 'upstream.json'
            upstream.write_text('{}')
            valid = enable_relay(directory, manifest(), upstream)
            self.assertEqual(valid['networks']['model-egress'], {'name': PROJECT + '-model-egress'})
            self.assertEqual(oct((directory / 'state/model-upstream.json').stat().st_mode & 0o777), '0o600')
            self.assertNotIn('key', json.dumps(valid['services']['model-fixture']['environment']))
        for change in (lambda m: m['services']['hermes']['networks'].update({'model-egress': None}),
                       lambda m: m['networks']['default'].update(internal=False),
                       lambda m: m['networks']['model-egress'].update(name='bridge'),
                       lambda m: m['services']['hermes'].update(ports=['8781:8781'])):
            with self.subTest(change=change):
                bad = copy.deepcopy(valid)
                change(bad)
                with self.assertRaises(ValueError):
                    validate_model_egress(bad)
        with self.assertRaisesRegex(ValueError, 'model_egress_network_required'):
            validate_model_egress(manifest())

    def test_upstream_file_must_be_private_https_and_outside_tracked_source(self):
        good = {'chat': {'url': 'https://gateway.example/v1', 'key': 'synthetic'},
                'embeddings': {'url': 'https://embeddings.example/v1', 'key': 'synthetic'}}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'upstream.json'
            path.write_text(json.dumps(good))
            path.chmod(0o600)
            self.assertEqual(read_upstream(path), path.resolve())
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'private'):
                read_upstream(path)
            path.chmod(0o600)
            for bad in ({'embeddings': good['embeddings']},
                        {'chat': {'url': 'http://gateway.example/v1', 'key': 'synthetic'}},
                        {'chat': {'url': 'https://user:pass@gateway.example/v1', 'key': 'synthetic'}},
                        {'chat': {'url': 'https://gateway.example/v1?x=1', 'key': 'synthetic'}},
                        {'chat': {'url': 'https://gateway.example/v1', 'key': ' '}},
                        {**good, 'speech': good['chat']}):
                with self.subTest(bad=bad):
                    path.write_text(json.dumps(bad))
                    with self.assertRaises(ValueError):
                        read_upstream(path)
        with self.assertRaisesRegex(ValueError, 'outside_tracked_source'):
            read_upstream(ROOT / 'package.json')

    def test_new_updates_start_above_those_an_earlier_run_already_acknowledged(self):
        # An earlier scenario run numbered updates ahead of the clock; reusing a lower
        # number would be dropped by the adapter and never captured.
        self.assertGreater(next_update_base({'updates': [], 'offset': 2000000101}, 2000000000), 2000000101)
        self.assertGreater(next_update_base({'updates': [{'update_id': 2000000500}], 'offset': 0}, 2000000000), 2000000500)
        self.assertGreater(next_update_base({'updates': [], 'offset': 0}, 2000000000), 2000000000)

    def test_focused_topic_window_excludes_restart_and_retirement(self):
        self.assertEqual(selected_cases('topic_shared', 'group_isolation'), ('topic_shared', 'group_isolation'))
        self.assertNotIn('retired_fact', selected_cases('topic_shared', 'topic_shared'))

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
                         '--stop-after', 'topic_shared']):
            with self.subTest(options=options), patch('sys.argv', ['model-rehearsal', '--directory', '/unused', *options]), \
                    patch('sys.stderr'), patch('tools.acceptance.model_rehearsal.Fixture') as fixture:
                with self.assertRaises(SystemExit) as stopped:
                    main()
                self.assertEqual(stopped.exception.code, 2)
                fixture.assert_not_called()


@unittest.skipUnless(importlib.util.find_spec('fastapi') and importlib.util.find_spec('httpx'), 'needs fastapi and httpx')
class ModelRelayTests(unittest.TestCase):
    """The relay changes only the authorization and keeps the guard canary check."""
    def setUp(self):
        import httpx
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        with patch.dict(os.environ, {'NOCHEH_INSTALLATION_FIXTURE': '1'}):
            spec = importlib.util.spec_from_file_location('installation_provider', ROOT / 'tools/acceptance/rehearsals/installation-provider.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.seen = []

        def upstream(request):
            self.seen.append((str(request.url), request.headers['authorization'], request.content))
            return httpx.Response(200, json={'ok': True})
        self.counts = {'detector': 0, 'learning': 0, 'chat': 0, 'embeddings': 0, 'raw_canary_outside_detector': 0}
        app = FastAPI()
        module.relay(app, {'chat': {'url': 'https://gateway.example/v1', 'key': 'real-chat'},
                           'embeddings': {'url': 'https://embeddings.example/v1', 'key': 'real-embed'}},
                     self.counts, 'CANARY', client=httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
        self.client = TestClient(app)

    def test_requests_reach_their_provider_with_only_the_key_replaced(self):
        body = {'model': 'synthetic-model', 'messages': [{'role': 'user', 'content': 'hello'}]}
        response = self.client.post('/v1/chat/completions', json=body, headers={'authorization': 'Bearer fixture-key'})
        self.assertEqual(response.json(), {'ok': True})
        self.client.post('/v1/embeddings', json={'model': 'synthetic-embedding', 'input': ['hello']})
        self.client.get('/v1/models')
        self.assertEqual([(url, key) for url, key, _ in self.seen], [
            ('https://gateway.example/v1/chat/completions', 'Bearer real-chat'),
            ('https://embeddings.example/v1/embeddings', 'Bearer real-embed'),
            ('https://gateway.example/v1/models', 'Bearer real-chat')])
        self.assertEqual(json.loads(self.seen[0][2]), body)
        self.assertEqual(self.counts['chat'], 1)

    def test_an_unguarded_secret_never_leaves_except_to_the_detector(self):
        leaked = {'messages': [{'role': 'user', 'content': 'my CANARY'}]}
        self.assertEqual(self.client.post('/v1/chat/completions', json=leaked).status_code, 400)
        self.assertEqual(self.client.post('/v1/embeddings', json={'input': ['CANARY']}).status_code, 400)
        detector = {'messages': [{'role': 'system', 'content': 'Find secret values in the supplied data. CANARY'}]}
        self.assertEqual(self.client.post('/v1/chat/completions', json=detector).status_code, 200)
        self.assertEqual(len(self.seen), 1)
        self.assertEqual((self.counts['raw_canary_outside_detector'], self.counts['detector']), (2, 1))


if __name__ == '__main__':
    unittest.main()
