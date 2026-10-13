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
from services.hermes.subscription import SHARED_BASE_URL, resolve_credentials, part_model

GATEWAY = {'id': 'gateway', 'name': 'Synthetic gateway', 'url': 'https://gateway.example.test/v1'}
CHOICES = {'provider_running': False, 'providers': []}


class ProviderRouteTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.state = Path(self.folder.name)
        patcher = patch('tools.operations.provider.provider.reasoning_choices', return_value=CHOICES)
        patcher.start(); self.addCleanup(patcher.stop); self.addCleanup(self.folder.cleanup)
        initialize(self.state)

    def test_one_default_serves_every_part_until_a_part_names_its_own(self):
        values = load(self.state)
        selected = routes.routes(values)
        self.assertEqual({route.provider for route in selected.values()}, {'builtin'})
        self.assertEqual(selected['reply'].url, routes.BUILTIN_URL)
        self.assertEqual(selected['memory'].url, routes.BUILTIN_MEMORY_URL)
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
            {'NOCHEH_EMBEDDING_PROVIDER': 'builtin'},
            {'NOCHEH_REPLY_MODEL': 'bad model name'},
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
        self.assertEqual((env['NOCHEH_GUARD_ROUTE_URL'], env['NOCHEH_GUARD_ROUTE_KEY']), (routes.BUILTIN_URL, ''))
        initialize_honcho(self.state)
        meter = read_env(state_for(self.state) / 'meter.env')
        honcho = read_env(state_for(self.state) / 'honcho.env')
        self.assertEqual((meter['NOCHEH_REASONING_URL'], meter['NOCHEH_REASONING_KEY']), (GATEWAY['url'], 'synthetic-gateway-key'))
        self.assertEqual(honcho['DERIVER_MODEL_CONFIG__MODEL'], values['NOCHEH_MODEL'])
        self.assertNotIn('synthetic-gateway-key', (state_for(self.state) / 'honcho.env').read_text())


class HermesCredentialTests(unittest.TestCase):
    def test_each_part_uses_only_its_configured_provider(self):
        environment = {'NOCHEH_REASONING_ROUTE': 'shared', 'NOCHEH_MODEL': 'claude-opus-5-5',
                       'NOCHEH_REPLY_ROUTE_URL': GATEWAY['url'], 'NOCHEH_REPLY_ROUTE_KEY': 'synthetic-gateway-key',
                       'NOCHEH_GUARD_ROUTE_URL': SHARED_BASE_URL, 'NOCHEH_GUARD_ROUTE_MODEL': 'claude-haiku-5-5'}
        with tempfile.TemporaryDirectory() as folder:
            key = Path(folder) / 'hermes.key'; key.write_text('b' * 64)
            with patch.dict(os.environ, {**environment, 'CLIPROXY_HERMES_KEY_FILE': str(key)}):
                reply = resolve_credentials()
                self.assertEqual((reply.base_url, reply.access_token, reply.api_mode), (GATEWAY['url'], 'synthetic-gateway-key', 'chat_completions'))
                guard = resolve_credentials('guard')
                self.assertEqual((guard.base_url, guard.access_token), (SHARED_BASE_URL, 'b' * 64))
                self.assertEqual((part_model('reply'), part_model('guard')), ('claude-opus-5-5', 'claude-haiku-5-5'))
            for change in ({'NOCHEH_REPLY_ROUTE_KEY': ''}, {'NOCHEH_REPLY_ROUTE_URL': 'http://gateway.example.test/v1'}):
                with patch.dict(os.environ, {**environment, **change}), self.assertRaises(ValueError):
                    resolve_credentials()


if __name__ == '__main__':
    unittest.main()
