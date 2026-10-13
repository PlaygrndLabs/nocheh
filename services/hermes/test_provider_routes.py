"""Settings › Models: providers, their keys, and the provider and model of each part."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.operations.installation.configuration import compose_environment, initialize, load, read_env
from tools.operations.installation.settings import save, view
from tools.operations.provider import routes
from services.hermes.subscription import ProviderNotConfigured, resolve_credentials, part_model

GATEWAY = {'id': 'gateway', 'name': 'Synthetic gateway', 'url': 'https://gateway.example.test/v1'}


class ProviderRouteTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.state = Path(self.folder.name)
        self.addCleanup(self.folder.cleanup)
        initialize(self.state)

    def test_fresh_installation_is_valid_with_every_part_unconfigured(self):
        values = load(self.state)
        self.assertEqual(values['NOCHEH_PROVIDER'], '')
        routes.validate(values)
        selected = routes.routes(values)
        self.assertEqual({(route.configured, route.provider, route.url, route.key) for route in selected.values()},
                         {(False, '', '', '')})
        env = compose_environment(self.state)
        for name in ('REPLY', 'GUARD'):
            self.assertEqual([env[f'NOCHEH_{name}_ROUTE_{field}'] for field in ('URL', 'MODEL', 'KEY')], ['', '', ''])
        self.assertEqual(env['NOCHEH_MEMORY_ROUTE_MODEL'], '')
        # Hermes starts, and each model call names the missing provider.
        with patch.dict(os.environ, {key: env[key] for key in env if key.startswith('NOCHEH_') and '_ROUTE_' in key}):
            for part in ('reply', 'guard'):
                with self.subTest(part=part), self.assertRaisesRegex(ProviderNotConfigured, 'provider_not_configured'):
                    resolve_credentials(part)
        # Honcho's meter gets no reasoning provider and no key.
        from tools.operations.memory.honcho_setup import initialize as initialize_honcho, provider_ready, state_for
        initialize_honcho(self.state)
        meter = read_env(state_for(self.state) / 'meter.env')
        self.assertEqual((meter['NOCHEH_REASONING_URL'], meter['NOCHEH_REASONING_KEY']), ('', ''))
        self.assertFalse(provider_ready(self.state))
        # A chosen provider without a key is still refused.
        for change in ({'NOCHEH_PROVIDER': 'openai'}, {'NOCHEH_GUARD_PROVIDER': 'anthropic'}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'no API key'):
                routes.validate({**values, **change})

    def test_one_default_serves_every_part_until_a_part_names_its_own(self):
        values = load(self.state)
        values.update(NOCHEH_PROVIDERS=json.dumps([GATEWAY]), NOCHEH_PROVIDER_KEYS='{"gateway":"synthetic-gateway-key"}',
                      NOCHEH_PROVIDER='gateway', NOCHEH_MODEL='claude-sonnet-5-5',
                      OPENAI_API_KEY='synthetic-openai-key', NOCHEH_MEMORY_PROVIDER='openai', NOCHEH_MEMORY_MODEL='gpt-5.6-sol')
        routes.validate(values)
        selected = routes.routes(values)
        self.assertEqual((selected['reply'].provider, selected['reply'].url, selected['reply'].model),
                         ('gateway', GATEWAY['url'], 'claude-sonnet-5-5'))
        self.assertEqual(selected['guard'].key, 'synthetic-gateway-key')
        self.assertEqual((selected['memory'].url, selected['memory'].model, selected['memory'].key),
                         ('https://api.openai.com/v1', 'gpt-5.6-sol', 'synthetic-openai-key'))

    def test_invalid_providers_and_missing_keys_are_refused(self):
        values = load(self.state)
        bad = [
            {'NOCHEH_PROVIDERS': json.dumps([{**GATEWAY, 'url': 'http://gateway.example.test/v1'}])},
            {'NOCHEH_PROVIDERS': json.dumps([{**GATEWAY, 'url': 'https://user:pass@gateway.example.test/v1'}])},
            {'NOCHEH_PROVIDERS': json.dumps([{**GATEWAY, 'id': 'openai'}])},
            {'NOCHEH_PROVIDERS': json.dumps([GATEWAY, GATEWAY])},
            {'NOCHEH_REPLY_PROVIDER': 'missing'},
            # A chosen provider without a key cannot serve a part.
            {'NOCHEH_PROVIDERS': json.dumps([GATEWAY]), 'NOCHEH_GUARD_PROVIDER': 'gateway'},
            {'NOCHEH_MEMORY_PROVIDER': 'anthropic'},
            {'NOCHEH_EMBEDDING_PROVIDER': 'anthropic'},
            {'NOCHEH_PROVIDER': 'builtin'},
            {'NOCHEH_PROVIDERS': json.dumps([{**GATEWAY, 'url': 'http://model-fixture:8317/v1'}])},
            {'NOCHEH_PROVIDER': 'openai', 'OPENAI_API_KEY': 'synthetic-openai-key', 'NOCHEH_REPLY_MODEL': 'bad model name'},
        ]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(ValueError):
                routes.validate({**values, **change})

    def test_keys_merge_never_reach_the_view_and_leave_with_their_provider(self):
        current = view(self.state)
        saved = save(self.state, {'NOCHEH_PROVIDERS': json.dumps([GATEWAY]),
                                  'NOCHEH_PROVIDER_KEYS': json.dumps({'gateway': 'synthetic-gateway-key'}),
                                  'NOCHEH_REPLY_PROVIDER': 'gateway'}, current['revision'])
        self.assertNotIn('synthetic-gateway-key', json.dumps(saved))
        gateway = next(row for row in saved['providers']['list'] if row['id'] == 'gateway')
        self.assertTrue(gateway['has_key'])
        self.assertFalse(next(row for row in saved['providers']['list'] if row['id'] == 'anthropic')['has_key'])
        # Saving again without the key keeps the stored one.
        saved = save(self.state, {'NOCHEH_REPLY_MODEL': 'claude-opus-5-5'}, saved['revision'])
        self.assertEqual(routes.keys(load(self.state)), {'gateway': 'synthetic-gateway-key'})
        # A part still using a provider keeps it from being removed.
        with self.assertRaises(ValueError):
            save(self.state, {'NOCHEH_PROVIDERS': '[]'}, saved['revision'])
        save(self.state, {'NOCHEH_PROVIDERS': '[]', 'NOCHEH_REPLY_PROVIDER': ''}, saved['revision'])
        self.assertEqual(routes.keys(load(self.state)), {})

    def test_model_lists_follow_the_provider_being_edited_without_leaking_a_saved_key(self):
        sent = []

        class Opener:
            def open(self, request, timeout):
                sent.append((request.full_url, request.get_header('Authorization')))
                body = json.dumps({'data': [{'id': 'claude-sonnet-5-5'}, {'id': 'bad model'}]}).encode()
                return type('Response', (), {'read': lambda self, size: body, '__enter__': lambda self: self,
                                             '__exit__': lambda self, *a: None})()

        values = load(self.state)
        values.update(NOCHEH_PROVIDERS=json.dumps([GATEWAY]), NOCHEH_PROVIDER_KEYS='{"gateway":"synthetic-gateway-key"}')
        # An unsaved provider lists with the address and key being typed.
        listed = routes.list_models(values, 'custom-2', Opener(), url='https://other.example.test/v1/', secret='synthetic-typed-key')
        self.assertEqual(listed['models'], ['claude-sonnet-5-5'])
        self.assertEqual(sent[-1], ('https://other.example.test/v1/models', 'Bearer synthetic-typed-key'))
        # The saved key goes only to the saved address.
        routes.list_models(values, 'gateway', Opener(), url=GATEWAY['url'])
        self.assertEqual(sent[-1], (GATEWAY['url'] + '/models', 'Bearer synthetic-gateway-key'))
        count = len(sent)
        moved = routes.list_models(values, 'gateway', Opener(), url='https://elsewhere.example.test/v1')
        self.assertEqual((moved['error'], len(sent)), ('missing_key', count))
        for url, secret, error in (('http://other.example.test/v1', 'k', 'invalid_url'),
                                   ('https://other.example.test/v1', 'bad\nkey', 'invalid_key')):
            self.assertEqual(routes.list_models(values, 'custom-2', Opener(), url=url, secret=secret)['error'], error)
        self.assertEqual(len(sent), count)
        # The rehearsal fixture's address is listed only inside an installation fixture.
        fixture = 'http://model-fixture:8317/v1'
        self.assertEqual(routes.list_models(values, 'custom-2', Opener(), url=fixture, secret='k')['error'], 'invalid_url')
        with patch.dict(os.environ, {'NOCHEH_INSTALLATION_FIXTURE': '1'}):
            routes.list_models(values, 'custom-2', Opener(), url=fixture, secret='synthetic-typed-key')
        self.assertEqual(sent[-1][0], fixture + '/models')
        # Presets always use their own address.
        routes.list_models({**values, 'OPENAI_API_KEY': 'synthetic-openai-key'}, 'openai', Opener(), url='https://other.example.test/v1')
        self.assertEqual(sent[-1][0], 'https://api.openai.com/v1/models')
        with self.assertRaises(ValueError):
            routes.list_models(values, 'builtin', Opener())

    def test_compose_gets_resolved_routes_and_honcho_gets_the_memory_route(self):
        from tools.operations.memory.honcho_setup import initialize as initialize_honcho, state_for
        values = load(self.state)
        values.update(NOCHEH_PROVIDERS=json.dumps([GATEWAY]), NOCHEH_PROVIDER_KEYS='{"gateway":"synthetic-gateway-key"}',
                      NOCHEH_REPLY_PROVIDER='gateway', NOCHEH_REPLY_MODEL='claude-opus-5-5', NOCHEH_MEMORY_PROVIDER='gateway')
        from tools.operations.installation.configuration import write_env, env_path
        write_env(env_path(self.state), values)
        env = compose_environment(self.state)
        self.assertEqual((env['NOCHEH_REPLY_ROUTE_URL'], env['NOCHEH_REPLY_ROUTE_MODEL'], env['NOCHEH_REPLY_ROUTE_KEY']),
                         (GATEWAY['url'], 'claude-opus-5-5', 'synthetic-gateway-key'))
        self.assertEqual((env['NOCHEH_GUARD_ROUTE_URL'], env['NOCHEH_GUARD_ROUTE_MODEL'], env['NOCHEH_GUARD_ROUTE_KEY']), ('', '', ''))
        initialize_honcho(self.state)
        meter = read_env(state_for(self.state) / 'meter.env')
        honcho = read_env(state_for(self.state) / 'honcho.env')
        self.assertEqual((meter['NOCHEH_REASONING_URL'], meter['NOCHEH_REASONING_KEY']), (GATEWAY['url'], 'synthetic-gateway-key'))
        self.assertEqual(honcho['DERIVER_MODEL_CONFIG__MODEL'], values['NOCHEH_MODEL'])
        self.assertNotIn('synthetic-gateway-key', (state_for(self.state) / 'honcho.env').read_text())


class HermesCredentialTests(unittest.TestCase):
    def test_each_part_uses_only_its_configured_provider(self):
        environment = {'NOCHEH_MODEL': 'claude-opus-5-5',
                       'NOCHEH_REPLY_ROUTE_URL': GATEWAY['url'], 'NOCHEH_REPLY_ROUTE_KEY': 'synthetic-gateway-key',
                       'NOCHEH_GUARD_ROUTE_URL': 'https://guard.example.test/v1', 'NOCHEH_GUARD_ROUTE_KEY': 'synthetic-guard-key',
                       'NOCHEH_GUARD_ROUTE_MODEL': 'claude-haiku-5-5'}
        with patch.dict(os.environ, environment):
            reply = resolve_credentials()
            self.assertEqual((reply.base_url, reply.access_token, reply.api_mode), (GATEWAY['url'], 'synthetic-gateway-key', 'chat_completions'))
            guard = resolve_credentials('guard')
            self.assertEqual((guard.base_url, guard.access_token), ('https://guard.example.test/v1', 'synthetic-guard-key'))
            self.assertEqual((part_model('reply'), part_model('guard')), ('claude-opus-5-5', 'claude-haiku-5-5'))
        for change in ({'NOCHEH_REPLY_ROUTE_KEY': ''}, {'NOCHEH_REPLY_ROUTE_URL': 'http://gateway.example.test/v1'}):
            with patch.dict(os.environ, {**environment, **change}), self.assertRaises(ValueError):
                resolve_credentials()

    def test_fixture_http_address_is_accepted_only_inside_an_installation_fixture(self):
        environment = {'NOCHEH_REPLY_ROUTE_URL': 'http://model-fixture:8317/v1', 'NOCHEH_REPLY_ROUTE_KEY': 'synthetic-fixture-key'}
        for flag in ('', '0'):
            with patch.dict(os.environ, {**environment, 'NOCHEH_INSTALLATION_FIXTURE': flag}), self.assertRaises(ValueError):
                resolve_credentials()
        with patch.dict(os.environ, {**environment, 'NOCHEH_INSTALLATION_FIXTURE': '1'}):
            self.assertEqual(resolve_credentials().base_url, 'http://model-fixture:8317/v1')
            with self.assertRaises(ValueError):
                with patch.dict(os.environ, {'NOCHEH_REPLY_ROUTE_URL': 'http://other-fixture:8317/v1'}):
                    resolve_credentials()
        values = {'NOCHEH_PROVIDERS': json.dumps([{**GATEWAY, 'url': environment['NOCHEH_REPLY_ROUTE_URL']}])}
        with self.assertRaises(ValueError):
            routes.custom(values)
        with patch.dict(os.environ, {'NOCHEH_INSTALLATION_FIXTURE': '1'}):
            self.assertEqual(routes.custom(values)[0]['url'], environment['NOCHEH_REPLY_ROUTE_URL'])


if __name__ == '__main__':
    unittest.main()
