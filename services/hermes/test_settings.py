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
        choices = {'provider_running': True, 'providers': [{'id': 'claude', 'label': 'Claude', 'signed_in': True, 'models': ['claude-sonnet-5-5']},
                                                            {'id': 'codex', 'label': 'ChatGPT', 'signed_in': False, 'models': []}]}
        with tempfile.TemporaryDirectory() as folder, patch('tools.operations.provider.provider.reasoning_choices', return_value=choices):
            state = Path(folder); initialize(state)
            current = view(state)
            self.assertEqual(current['models']['reasoning'], ['claude-sonnet-5-5'])
            self.assertEqual([provider['signed_in'] for provider in current['models']['providers']], [True, False])
            self.assertIn('text-embedding-3-large', current['models']['embedding'])
            editable = {field['key'] for field in current['fields'] if field['editable']}
            self.assertLessEqual({'NOCHEH_MODEL', 'NOCHEH_EMBEDDING_MODEL'}, editable)
            self.assertNotIn('OPENAI_API_KEY', editable)
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
