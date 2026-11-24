import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.operations.installation.configuration import initialize, load, write_env, env_path
from tools.operations.installation.settings import view, save, apply, service_revision


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
                steps = []
                self.assertEqual(apply(state, steps.append), {'status': 'apply_failed', 'rolled_back': False})
                # The dashboard shows each step while the services restart.
                self.assertEqual(steps, ['restarting', 'rolling_back'])
            self.assertEqual(load(state), baseline)
            with patch('tools.operations.installation.settings.subprocess.run') as run, \
                    patch('tools.operations.installation.settings.refresh_honcho', return_value='refreshed') as refresh:
                run.return_value.returncode = 0
                steps = []
                result = apply(state, steps.append)
                self.assertEqual(steps, ['restarting', 'memory', 'telegram'])
                self.assertEqual(result['honcho'], 'refreshed'); refresh.assert_called_once()
                self.assertEqual(result['apply_state'], 'current')
                self.assertFalse((state / 'admin/previous.env').exists())

    def test_backup_settings_work_live_without_apply(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state)
            with patch('tools.operations.installation.settings.subprocess.run') as run, \
                    patch('tools.operations.installation.settings.refresh_honcho', return_value='unchanged'):
                run.return_value.returncode = 0
                apply(state)
            saved = save(state, {'NOCHEH_BACKUP_TIME': '02:30', 'NOCHEH_BACKUP_KEEP': '14'}, view(state)['revision'])
            self.assertEqual(saved['apply_state'], 'current')
            self.assertFalse((state / 'admin/previous.env').exists())
            self.assertEqual({field['key']: field['takes_effect'] for field in saved['fields']}['NOCHEH_BACKUP_TIME'], 'right away')
            self.assertEqual(save(state, {'NOCHEH_GUARD_MODE': 'off'}, saved['revision'])['apply_state'], 'pending')

    def test_a_newly_added_setting_at_its_default_does_not_ask_for_apply(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state)
            before = {key: value for key, value in load(state).items() if key != 'NOCHEH_DASHBOARD_URL'}
            (state / 'admin').mkdir(exist_ok=True)
            (state / 'admin/applied.json').write_text(json.dumps({'revision': service_revision(before)}))
            self.assertEqual(view(state)['apply_state'], 'current')
            saved = save(state, {'NOCHEH_DASHBOARD_URL': 'https://dash.example.test'}, view(state)['revision'])
            self.assertEqual(saved['apply_state'], 'pending')
            self.assertEqual(save(state, {'NOCHEH_DASHBOARD_URL': ''}, saved['revision'])['apply_state'], 'current')

    def test_a_retired_setting_is_hidden_unsaveable_and_does_not_ask_for_apply_after_an_upgrade(self):
        from tools.operations.installation.configuration import DEFAULTS, GENERATED
        from tools.operations.installation.settings import LIVE, revision
        # The group list (ADR-0253) and the lists of who may talk in each group, which members replace (step 3): an older
        # .env keeps its line, at the old default or not.
        access = json.dumps({'-10': {'granted': ['77'], 'denied': ['78']}})
        for key, default, listed in (('TELEGRAM_GROUP_IDS', '', '-10'), ('TELEGRAM_GROUP_ACCESS', '{}', access)):
            # The revision a build that still had the setting recorded at Apply.
            old = {**DEFAULTS, key: default}
            before = lambda values: revision({name: value for name, value in values.items() if name not in LIVE and name not in GENERATED
                                              and old.get(name) != value})
            for value in (default, listed):
                with self.subTest(key=key, value=value), tempfile.TemporaryDirectory() as folder:
                    state = Path(folder); values = initialize(state)
                    self.assertNotIn(key, values, 'a new .env has no line for it')
                    values[key] = value; write_env(env_path(state), values)
                    self.assertEqual(load(state)[key], value)
                    (state / 'admin').mkdir(exist_ok=True)
                    (state / 'admin/applied.json').write_text(json.dumps({'revision': before(load(state))}))
                    current = view(state)
                    self.assertEqual(current['apply_state'], 'current')
                    self.assertNotIn(key, [field['key'] for field in current['fields']])
                    with self.assertRaisesRegex(ValueError, 'unsupported_setting'): save(state, {key: listed}, current['revision'])
                    self.assertEqual(load(state)[key], value)

    def test_generated_keys_never_ask_for_apply(self):
        # A cutover or rotate-keys applies them itself (ADR-0295); Settings neither lists nor counts them.
        from tools.operations.installation.configuration import GENERATED
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); values = initialize(state)
            changed = {**values, **{name: values[name][::-1] for name in GENERATED}}
            self.assertEqual(service_revision(changed), service_revision(values))
            self.assertNotEqual(service_revision({**values, 'NOCHEH_GUARD_MODE': 'off'}), service_revision(values))
            for name in ('AGENT_KEY', 'NOCHEH_HERMES_SESSION_TOKEN'):
                self.assertNotIn(name, [field['key'] for field in view(state)['fields']])
                self.assertNotIn(values[name], json.dumps(view(state)))

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
            self.assertIsNone(view(state)['models']['embedding_rebuild'])
            save(state, {'NOCHEH_MODEL': 'claude-opus-5-5'}, saved['revision'])
            self.assertEqual(load(state)['NOCHEH_MODEL'], 'claude-opus-5-5')

    def test_a_confirmed_model_change_rebuilds_memory_on_apply(self):
        import sqlite3
        from services.honcho.meter import Ledger
        from tools.operations.memory.honcho_setup import state_for
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state)
            ledger = state_for(state) / 'ledger/budget.sqlite'; ledger.parent.mkdir(parents=True, exist_ok=True)
            Ledger(ledger)
            with sqlite3.connect(ledger) as db:
                # A ledger from before the route was recorded: its vectors are small-model ones.
                db.execute("INSERT INTO calls(route,reserved,started) VALUES('/v1/embeddings',10000,0)")
            self.assertEqual(view(state)['models']['embedding_locked'], 'text-embedding-3-small')
            confirmed = save(state, {'NOCHEH_EMBEDDING_MODEL': 'text-embedding-3-large'}, view(state)['revision'], rebuild_memory=True)
            self.assertEqual(confirmed['models']['embedding_rebuild'], 'text-embedding-3-large')
            operation = json.loads((state / 'admin/memory-rebuild.json').read_text())['operation_id']
            calls = []

            class API:
                fail = True
                def call(self, path, body=None):
                    calls.append((path, body))
                    if body is not None and API.fail: raise OSError('archive unavailable')
                    return {'connection': {'revision': 7}}

            def applied(honcho='refreshed'):
                with patch('tools.operations.installation.settings.subprocess.run') as run, \
                        patch('tools.operations.installation.settings.refresh_honcho', return_value=honcho), \
                        patch('tools.operations.archive.archive.API', API):
                    run.return_value.returncode = 0
                    return apply(state)

            # Honcho didn't restart: nothing is switched, and the change waits to apply again.
            result = applied('failed')
            self.assertEqual(result['memory_rebuild'], 'failed'); self.assertNotEqual(result['apply_state'], 'current')
            self.assertEqual(calls, [])
            # The fresh start fails: Apply stays pending, and the marker keeps its operation ID.
            result = applied()
            self.assertEqual(result['memory_rebuild'], 'failed'); self.assertNotEqual(result['apply_state'], 'current')
            self.assertEqual(json.loads((state / 'admin/memory-rebuild.json').read_text())['operation_id'], operation)
            API.fail = False; calls.clear()
            result = applied()
            self.assertEqual((result['memory_rebuild'], result['apply_state']), ('started', 'current'))
            self.assertEqual(calls[-1], ('/v1/memory/longterm/fresh-start', {'expected_revision': 7, 'operation_id': operation, 'from_archive': True}))
            self.assertEqual({key: value for key, value in result['models'].items() if key != 'transcription'},
                             {'embedding': ['text-embedding-3-large', 'text-embedding-3-small'],
                              'embedding_locked': 'text-embedding-3-large', 'embedding_rebuild': None})
            # Nothing is rebuilt twice, and the spending records stay.
            self.assertIsNone(applied()['memory_rebuild'])
            with sqlite3.connect(ledger) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM calls').fetchone()[0], 1)

    def test_choosing_the_stored_model_again_cancels_the_rebuild(self):
        import sqlite3
        from services.honcho.meter import Ledger
        from tools.operations.memory.honcho_setup import state_for
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state)
            ledger = state_for(state) / 'ledger/budget.sqlite'; ledger.parent.mkdir(parents=True, exist_ok=True)
            Ledger(ledger)
            with sqlite3.connect(ledger) as db:
                db.execute("INSERT INTO embedding_route VALUES(1,'openai','text-embedding-3-small',1536)")
            save(state, {'NOCHEH_EMBEDDING_MODEL': 'text-embedding-3-large'}, view(state)['revision'], rebuild_memory=True)
            self.assertTrue((state / 'admin/memory-rebuild.json').exists())
            save(state, {'NOCHEH_EMBEDDING_MODEL': 'text-embedding-3-small'}, view(state)['revision'])
            self.assertFalse((state / 'admin/memory-rebuild.json').exists())
            self.assertIsNone(view(state)['models']['embedding_rebuild'])


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
            # The bot label names only a bot this workspace polls (ADR-0245).
            self.assertEqual(environment['NOCHEH_POLLED_BOT_ID'], '5550001' if environment.get('TELEGRAM_ENABLED') == 'true' else '')

    def test_the_dashboard_checks_phone_sign_ins_with_the_bot_id_and_owner_never_the_token(self):
        import os
        from tools.runtime.management import dispatch
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state); self.telegram(state)
            with patch.dict(os.environ, {'NOCHEH_STATE_DIR': str(state)}):
                checked = dispatch({'operation': 'mini_app.launch_check'})
                self.assertEqual(checked, {'bot_id': '5550001', 'owner_id': '4242', 'test_environment': False})
                self.assertNotIn('A' * 35, json.dumps(checked))
                # Read from .env each time, so a changed bot or owner counts at once.
                values = load(state); values.update(TELEGRAM_BOT_TOKEN='5550002:' + 'B' * 35, TELEGRAM_TEST_ENVIRONMENT='true')
                write_env(env_path(state), values)
                self.assertEqual(dispatch({'operation': 'mini_app.launch_check'}),
                                 {'bot_id': '5550002', 'owner_id': '4242', 'test_environment': True})

    def test_apply_starts_the_mini_app_and_puts_it_on_the_menu_buttons(self):
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
                # Every private chat's default button opens the members' page; the owner's own chat keeps the owner's page,
                # set after the default so it stands over it (ADR-0265 D11).
                self.assertEqual([call[0] for call in calls], ['setChatMenuButton'] * 2)
                self.assertNotIn('chat_id', calls[0][1])
                self.assertEqual(json.loads(calls[0][1]['menu_button']),
                                 {'type': 'web_app', 'text': 'Nocheh', 'web_app': {'url': 'https://nocheh.example.com/m/'}})
                self.assertEqual(calls[1][1]['chat_id'], '4242')
                self.assertEqual(json.loads(calls[1][1]['menu_button']),
                                 {'type': 'web_app', 'text': 'Nocheh', 'web_app': {'url': 'https://nocheh.example.com/'}})
                # A changed address applies both again.
                save(state, {'NOCHEH_MINI_APP_URL': 'https://tasks.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': 'e' * 64}, view(state)['revision'])
                del calls[:]
                self.assertEqual(apply(state)['mini_app'], 'shown')
                self.assertEqual([json.loads(call[1]['menu_button'])['web_app']['url'] for call in calls],
                                 ['https://tasks.example.com/m/', 'https://tasks.example.com/'])
                # Either call failing is reported.
                del calls[:]
                def refused(token, method, **params):
                    calls.append((method, params)); return None if 'chat_id' not in params else True
                with patch('tools.operations.installation.settings.telegram_api', side_effect=refused):
                    self.assertEqual(apply(state)['mini_app'], 'failed')
                self.assertEqual(len(calls), 2, 'the owner\'s button is still set when the default fails')
                del calls[:]
                save(state, {'NOCHEH_MINI_APP_URL': '', 'CLOUDFLARE_TUNNEL_TOKEN': ''}, view(state)['revision'])
                self.assertEqual(apply(state)['mini_app'], 'removed')
                # Turning it off stops the mini app and closes its tunnel, and both buttons go back to Telegram's default.
                self.assertEqual(run.call_args_list[-1].args[0][-5:], ['rm', '-s', '-f', 'nocheh-miniapp', 'nocheh-tunnel'])
                self.assertEqual([(call[1].get('chat_id'), json.loads(call[1]['menu_button'])) for call in calls],
                                 [(None, {'type': 'default'}), ('4242', {'type': 'default'})])

    def test_a_former_owners_chat_loses_the_owners_menu_button(self):
        # After the owner changes, the former owner's chat keeps no button of its own: it falls back to the default,
        # the members' page, so a former owner added as a member reaches it (ADR-0265 D11).
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder); initialize(state); self.telegram(state)
            calls = []
            def bot(token, method, **params): calls.append((params.get('chat_id'), json.loads(params['menu_button']))); return True
            with patch('tools.operations.installation.settings.subprocess.run') as run, \
                    patch('tools.operations.installation.settings.refresh_honcho', return_value='unchanged'), \
                    patch('tools.operations.installation.settings.telegram_api', side_effect=bot):
                run.return_value.returncode = 0
                save(state, {'NOCHEH_MINI_APP_URL': 'https://nocheh.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': 'e' * 64}, view(state)['revision'])
                self.assertEqual(apply(state)['mini_app'], 'shown')
                self.assertEqual([chat for chat, _ in calls], [None, '4242'])
                del calls[:]
                save(state, {'TELEGRAM_OWNER_ID': '4343'}, view(state)['revision'], owner_change=True)
                self.assertEqual(apply(state)['mini_app'], 'shown')
                members, owner = {'type': 'web_app', 'text': 'Nocheh', 'web_app': {'url': 'https://nocheh.example.com/m/'}}, \
                    {'type': 'web_app', 'text': 'Nocheh', 'web_app': {'url': 'https://nocheh.example.com/'}}
                self.assertEqual(calls, [(None, members), ('4343', owner), ('4242', {'type': 'default'})])
                # Applied once, it is not done again; nor when the owner stays the same.
                del calls[:]
                save(state, {'NOCHEH_MINI_APP_URL': 'https://tasks.example.com', 'CLOUDFLARE_TUNNEL_TOKEN': 'e' * 64}, view(state)['revision'])
                self.assertEqual(apply(state)['mini_app'], 'shown')
                self.assertEqual([chat for chat, _ in calls], [None, '4343'])
