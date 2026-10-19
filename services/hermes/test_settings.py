import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.installation.configuration import initialize, load, write_env, env_path
from tools.operations.installation.settings import view, save, apply


class SettingsTests(unittest.TestCase):
    def test_redaction_validation_conflicts_and_unknown_field_preservation(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); values = initialize(state)
            values['FUTURE_SECRET'] = 'private-extra-value'; write_env(env_path(state), values)
            first = view(state)
            self.assertNotIn(values['SERVICE_TOKEN'], str(first))
            self.assertNotIn('private-extra-value', str(first))
            second = save(state, {'NOCHEH_GUARD_MODE': 'off'}, first['revision'])
            self.assertEqual(load(state)['FUTURE_SECRET'], 'private-extra-value')
            for changes, revision in [({'NOCHEH_GUARD_MODE': 'bad'}, second['revision']),
                                      ({'SERVICE_TOKEN': 'new'}, second['revision']),
                                      ({'NOCHEH_MODEL': 'new'}, first['revision'])]:
                with self.assertRaises(ValueError): save(state, changes, revision)
                self.assertEqual(view(state)['revision'], second['revision'])

    def test_failed_apply_restores_last_baseline_and_reports_recovery(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state)
            baseline = load(state)
            save(state, {'NOCHEH_MODEL': 'new'}, view(state)['revision'])
            save(state, {'NOCHEH_GUARD_MODE': 'off'}, view(state)['revision'])
            with patch('tools.operations.installation.settings.subprocess.run') as run:
                run.return_value.returncode = 1
                self.assertEqual(apply(state), {'status': 'apply_failed', 'rolled_back': False})
            self.assertEqual(load(state), baseline)
            with patch('tools.operations.installation.settings.subprocess.run') as run, \
                    patch('tools.operations.installation.settings.refresh_honcho', return_value='refreshed') as refresh:
                run.return_value.returncode = 0
                result = apply(state)
                self.assertEqual(result['honcho'], 'refreshed'); refresh.assert_called_once()
                self.assertEqual(result['apply_state'], 'current')
                self.assertFalse((state / 'admin/previous.env').exists())

    def test_models_are_owner_settings_and_embeddings_never_mix(self):
        import sqlite3
        from tools.operations.memory.honcho_setup import state_for
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state)
            current = view(state)
            self.assertEqual([row['id'] for row in current['providers']['list']], ['openai', 'anthropic'])
            self.assertIn('text-embedding-3-large', current['models']['embedding'])
            editable = {field['key'] for field in current['fields'] if field['editable']}
            self.assertLessEqual({'NOCHEH_MODEL', 'NOCHEH_EMBEDDING_MODEL'}, editable)
            # Provider keys are entered in Settings › Models.
            self.assertLessEqual({'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NOCHEH_PROVIDER_KEYS', 'NOCHEH_PROVIDERS'}, editable)
            saved = save(state, {'NOCHEH_EMBEDDING_MODEL': 'text-embedding-3-large'}, current['revision'])
            # Once Honcho's ledger holds vectors from one model, another one is refused.
            ledger = state_for(state) / 'ledger/budget.sqlite'
            with sqlite3.connect(ledger) as db:
                db.execute('CREATE TABLE embedding_route(id INTEGER PRIMARY KEY, provider TEXT, model TEXT, dimensions INTEGER)')
                db.execute("INSERT INTO embedding_route VALUES(1,'openai','text-embedding-3-large',1536)")
            self.assertEqual(view(state)['models']['embedding_locked'], 'text-embedding-3-large')
            with self.assertRaisesRegex(ValueError, 'embedding_model_change_requires_rebuild'):
                save(state, {'NOCHEH_EMBEDDING_MODEL': 'text-embedding-3-small'}, saved['revision'])
            self.assertEqual(load(state)['NOCHEH_EMBEDDING_MODEL'], 'text-embedding-3-large')
            save(state, {'NOCHEH_MODEL': 'claude-opus-5-5'}, saved['revision'])
            self.assertEqual(load(state)['NOCHEH_MODEL'], 'claude-opus-5-5')


class MiniAppSettingsTests(unittest.TestCase):
    def telegram(self, state, **extra):
        values = load(state)
        values.update(TELEGRAM_ENABLED='true', TELEGRAM_BOT_TOKEN='5550001:' + 'A' * 35, TELEGRAM_OWNER_ID='4242', **extra)
        write_env(env_path(state), values)
        return view(state)['revision']

    def test_the_mini_app_needs_an_https_address_and_its_tunnel_token(self):
        from tools.operations.installation.configuration import compose_environment
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state); revision = self.telegram(state)
            self.assertNotIn('miniapp', compose_environment(state)['COMPOSE_PROFILES'].split(','))
            for changes in ({'NOCHEH_MINI_APP_URL': 'http://nocheh.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': 'e' * 64},
                            {'NOCHEH_MINI_APP_URL': 'https://nocheh.example.com/dashboard', 'CLOUDFLARE_TUNNEL_TOKEN': 'e' * 64},
                            {'NOCHEH_MINI_APP_URL': 'https://user@nocheh.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': 'e' * 64},
                            {'NOCHEH_MINI_APP_URL': 'https://nocheh.example.com'},
                            {'NOCHEH_MINI_APP_URL': 'https://nocheh.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': 'bad token'}):
                with self.assertRaises(ValueError): save(state, changes, revision)
            result = save(state, {'NOCHEH_MINI_APP_URL': 'https://nocheh.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': 'e' * 64}, revision)
            # The tunnel token is never shown back.
            self.assertNotIn('e' * 64, str(result))
            environment = compose_environment(state)
            self.assertIn('miniapp', environment['COMPOSE_PROFILES'].split(','))
            self.assertEqual(environment['TELEGRAM_BOT_ID'], '5550001')

    def test_apply_starts_the_mini_app_and_puts_it_on_the_owners_menu_button(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state); revision = self.telegram(state, TELEGRAM_BOT_NAMES='Nocheh,نوچه')
            calls = []
            def bot(token, method, **params): calls.append((method, params)); return True
            with patch('tools.operations.installation.settings.subprocess.run') as run, \
                    patch('tools.operations.installation.settings.refresh_honcho', return_value='unchanged'), \
                    patch('tools.operations.installation.settings.telegram_api', side_effect=bot):
                run.return_value.returncode = 0
                # Never turned on: no Telegram call at all.
                self.assertEqual(apply(state)['mini_app'], 'off')
                self.assertEqual(calls, [])
                save(state, {'NOCHEH_MINI_APP_URL': 'https://nocheh.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': 'e' * 64}, view(state)['revision'])
                self.assertEqual(apply(state)['mini_app'], 'shown')
                up = run.call_args_list[-1].args[0]
                self.assertEqual(up[-2:], ['nocheh-miniapp', 'nocheh-tunnel'])
                self.assertEqual(calls[-1][0], 'setChatMenuButton')
                self.assertEqual(calls[-1][1]['chat_id'], '4242')
                self.assertEqual(json.loads(calls[-1][1]['menu_button']),
                                 {'type': 'web_app', 'text': 'Nocheh', 'web_app': {'url': 'https://nocheh.example.com/'}})
                save(state, {'NOCHEH_MINI_APP_URL': '', 'CLOUDFLARE_TUNNEL_TOKEN': ''}, view(state)['revision'])
                self.assertEqual(apply(state)['mini_app'], 'removed')
                # Turning it off stops the mini app and closes its tunnel.
                self.assertEqual(run.call_args_list[-1].args[0][-5:], ['rm', '-s', '-f', 'nocheh-miniapp', 'nocheh-tunnel'])
                self.assertEqual(json.loads(calls[-1][1]['menu_button']), {'type': 'default'})
