import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scripts.configuration import initialize, load, write_env, env_path
from scripts.settings import view, save, apply


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
            with patch('scripts.settings.subprocess.run') as run:
                run.return_value.returncode = 1
                self.assertEqual(apply(state), {'status': 'apply_failed', 'rolled_back': False})
            self.assertEqual(load(state), baseline)
            with patch('scripts.settings.subprocess.run') as run:
                run.return_value.returncode = 0
                result = apply(state)
                self.assertEqual(result['apply_state'], 'current')
                self.assertFalse((state / 'admin/previous.env').exists())
