import tempfile
import unittest
from pathlib import Path
from .profile_config import configure_profile, read, atomic_yaml


class ProfileConfigurationTests(unittest.TestCase):
    def test_preferences_survive_turn_preparation_but_policy_cannot_change(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder)
            first = configure_profile(profile, 'subscription-model')
            second = configure_profile(profile, 'subscription-model',
                                       {'agent.reasoning_effort': 'high', 'memory.memory_char_limit': 4400},
                                       first['revision'])
            self.assertEqual(configure_profile(profile, 'subscription-model'), second)
            path = profile / 'config.yaml'; raw = read(path)
            raw['display'] = {'skin': 'personal'}
            raw['model'] = {'provider': 'untrusted'}
            raw['memory']['provider'] = 'honcho'
            raw['plugins']['enabled'].append('unapproved')
            raw['fallback_models'] = ['untrusted']
            atomic_yaml(path, raw)
            configure_profile(profile, 'subscription-model')
            saved = read(path)
            self.assertEqual(saved['display']['skin'], 'personal')
            self.assertEqual(saved['agent']['reasoning_effort'], 'high')
            self.assertEqual(saved['model']['provider'], 'openai-codex')
            self.assertEqual(saved['plugins']['enabled'], ['nocheh'])
            self.assertEqual(saved['memory']['provider'], '')
            self.assertEqual(saved['fallback_models'], [])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_conflicting_invalid_and_unmanaged_edits_do_not_write(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder); initial = configure_profile(profile, 'model')
            for changes, revision in [({'agent.max_iterations': 900}, initial['revision']),
                                      ({'agent.max_iterations': True}, initial['revision']),
                                      ({'model.default': 'another'}, initial['revision']),
                                      ({'agent.reasoning_effort': 'high'}, 'stale')]:
                with self.assertRaises(ValueError): configure_profile(profile, 'model', changes, revision)
                self.assertEqual(configure_profile(profile, 'model'), initial)
