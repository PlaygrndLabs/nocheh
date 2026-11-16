import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from . import preference_transfer as transfer
from .policy_config import save, view
from .profile_config import atomic_yaml, configure_profile, inspect_profile, read
from .scopes import Scope, Scopes


class PreferenceTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source, self.target = self.root / 'source', self.root / 'target'
        self.source.mkdir(); self.target.mkdir()
        self.env = patch.dict(os.environ, {'NOCHEH_RUNTIME_HOME': str(self.source)})
        self.env.start(); self.addCleanup(self.env.stop)
        # The reset's own policy: the owner its setup names and the groups Nocheh is on in (tools/acceptance/reset_preservation.py).
        self.policy = SimpleNamespace(owner='42', groups=['-10'])
        save(self.source, {'agent.max_iterations': 5, 'agent.reasoning_effort': 'high'}, view(self.source)['revision'])
        save(self.source, {'agent.max_iterations': 2}, view(self.source)['revision'], job='old-schedule')
        self.owner = self.source / 'profiles' / Scopes.profile('42')
        self.group = self.source / 'profiles' / Scopes.profile('-10')
        configure_profile(self.owner, 'fixture-model')
        self.change(self.group, {'agent.max_iterations': 3})
        self.custom = self.source / 'profiles' / 'research'
        self.change(self.custom, {'memory.user_char_limit': 4000})
        (self.custom / 'nocheh-owner-profile.json').write_text('{"scope":"owner"}')
        value = read(self.custom / 'config.yaml')
        value['system_prompt'] = 'PRIVATE OLD PROMPT'
        value['env'] = {'SECRET_KEY': 'PRIVATE OLD CREDENTIAL'}
        atomic_yaml(self.custom / 'config.yaml', value)
        (self.custom / 'memories').mkdir()
        (self.custom / 'memories/MEMORY.md').write_text('PRIVATE OLD MEMORY')
        (self.custom / 'state.db').write_bytes(b'PRIVATE OLD SESSION')
        (self.source / 'auth.json').write_text('PRIVATE OLD LOGIN')

    def change(self, profile, changes):
        initial = configure_profile(profile, 'fixture-model')
        configure_profile(profile, 'fixture-model', changes, initial['revision'])

    def admitted(self, snapshot):
        return [{**row, 'owner_id': snapshot['owner'], 'revision': 1} for row in transfer.profile_commands(snapshot)]

    def test_preferences_inherit_after_restore_without_content_jobs_or_credentials(self):
        snapshot = transfer.capture(self.source, self.policy)
        serialized = json.dumps(snapshot)
        for forbidden in ('PRIVATE OLD', 'old-schedule', 'SECRET_KEY', 'system_prompt', 'auth.json'):
            self.assertNotIn(forbidden, serialized)
        rows = {row['space']: row for row in snapshot['profiles'] if row['name'] is None}
        self.assertEqual(rows['42']['overrides'], {})
        self.assertEqual(rows['-10']['overrides'], {'agent.max_iterations': 3})
        self.assertEqual(transfer.profile_commands(snapshot), transfer.profile_commands(transfer.capture(self.source, self.policy)))
        with self.assertRaisesRegex(ValueError, 'catalog_not_admitted'):
            transfer.restore(self.target, snapshot, 'fixture-model', [])
        self.assertEqual(list(self.target.iterdir()), [])
        (self.target / 'auth.json').write_text('NEW LOGIN PRESERVED')
        result = transfer.restore(self.target, snapshot, 'fixture-model', self.admitted(snapshot))
        self.assertEqual(transfer.restore(self.target, snapshot, 'fixture-model', self.admitted(snapshot)), result)
        self.assertFalse(result['native_content_copied'])
        self.assertEqual((self.target / 'auth.json').read_text(), 'NEW LOGIN PRESERVED')
        self.assertEqual((self.custom / 'state.db').read_bytes(), b'PRIVATE OLD SESSION')
        self.assertNotIn('jobs', read(self.target / 'nocheh-policy.yaml'))
        with patch.dict(os.environ, {'NOCHEH_RUNTIME_HOME': str(self.target)}):
            owner = self.target / 'profiles' / Scopes.profile('42')
            group = self.target / 'profiles' / Scopes.profile('-10')
            custom = self.target / 'profiles' / transfer.profile_commands(snapshot)[0]['id']
            self.assertEqual(inspect_profile(owner, 'fixture-model')['values']['agent.max_iterations'], 5)
            self.assertEqual(inspect_profile(owner, 'fixture-model')['origins']['agent.max_iterations'], 'global')
            self.assertEqual(inspect_profile(group, 'fixture-model')['values']['agent.max_iterations'], 3)
            self.assertEqual(inspect_profile(custom, 'fixture-model')['values']['memory.user_char_limit'], 4000)
            save(self.target, {'agent.max_iterations': 6}, view(self.target)['revision'])
            self.assertEqual(inspect_profile(owner, 'fixture-model')['values']['agent.max_iterations'], 6)
            self.assertEqual(inspect_profile(group, 'fixture-model')['values']['agent.max_iterations'], 3)
            self.assertEqual([path.name for path in custom.iterdir()], ['config.yaml'])
            self.assertEqual((custom / 'config.yaml').stat().st_mode & 0o777, 0o600)

    def test_missing_topic_override_keeps_parent_inheritance_after_generation_change(self):
        from .assistant_gateway import prepare_profile
        for topic in ('7', '8'):
            scope = '-10/topic/' + topic
            directory = self.source / 'profiles' / Scopes.profile(scope)
            directory.mkdir()
            (directory / 'space.json').write_text(json.dumps({'space': scope, 'revision': 0, 'owner': False}))
            if topic == '8':
                self.change(directory, {'agent.max_iterations': 4})
        snapshot = transfer.capture(self.source, self.policy)
        self.assertNotIn('-10/topic/7', [row['space'] for row in snapshot['profiles']])
        transfer.restore(self.target, snapshot, 'fixture-model', self.admitted(snapshot))
        self.assertFalse((self.target / 'profiles' / Scopes.profile('-10/topic/7')).exists())
        with patch.dict(os.environ, {'NOCHEH_RUNTIME_HOME': str(self.target)}):
            for topic, expected in (('7', 3), ('8', 4)):
                space = '-10/topic/' + topic
                scope = Scopes.apply_revision(Scope('-10', '42', False, Scopes.profile(space), space), {
                    'generation': '11111111-1111-1111-1111-111111111111', 'guard_epoch': 2, 'revision': 2,
                    'logical_profile': Scopes.profile(space)})
                actual = prepare_profile(self.target, scope, 'fixture-model')
                self.assertEqual(read(actual / 'config.yaml')['agent']['max_iterations'], expected)
                self.assertFalse((actual / 'memories').exists())

    def test_chats_first_seen_after_step_2b_and_upgraded_groups_keep_their_preferences(self):
        # ADR-0252: the reset's configuration names its chats by their Nocheh ids. A topic first seen after step 2b in the
        # old group '-10' has a digest id, a group first seen after step 2b ('-30' in the setup) is a digest too, and the
        # group '-20' Telegram upgraded to '-1020' keeps its old id as its chat id.
        topic, new_group, new_topic = 'a' * 64, 'b' * 64, 'c' * 64
        chats = {'owner': '42', 'groups': {'-10': ['-10'], '-20': ['-1020', '-20'], new_group: ['-30']},
                 'topics': {topic: '-10', new_topic: new_group}}
        policy = SimpleNamespace(owner='42', groups=['-10', '-1020', '-30'], chats=chats)
        for space, value in ((topic, 4), (new_group, 6), ('-20', 7)):
            directory = self.source / 'profiles' / Scopes.profile(space)
            self.change(directory, {'agent.max_iterations': value})
            (directory / 'space.json').write_text(json.dumps({'space': space, 'chat': chats['topics'].get(space, space), 'revision': 0, 'owner': False}))
        snapshot = transfer.capture(self.source, policy)
        self.assertEqual(snapshot['format'], 'nocheh-runtime-preferences-v2')
        self.assertEqual(snapshot['chats'], chats)
        rows = {row['space']: row for row in snapshot['profiles'] if row['name'] is None}
        self.assertEqual({space: rows[space]['overrides'].get('agent.max_iterations') for space in (topic, new_group, '-20', '-10')},
                         {topic: 4, new_group: 6, '-20': 7, '-10': 3})
        self.assertNotIn(new_topic, rows, 'a topic with no config of its own inherits its chat\'s')
        self.assertFalse({Scopes.profile('-30'), Scopes.profile('-1020')} & {row['id'] for row in snapshot['profiles']},
                         'no profile is named after a Telegram id that is not the chat\'s id')
        transfer.restore(self.target, snapshot, 'fixture-model', self.admitted(snapshot))
        with patch.dict(os.environ, {'NOCHEH_RUNTIME_HOME': str(self.target)}):
            for space, value in ((topic, 4), (new_group, 6), ('-20', 7)):
                self.assertEqual(inspect_profile(self.target / 'profiles' / Scopes.profile(space), 'fixture-model')['values']['agent.max_iterations'], value)
        # The same capture without the chat records would read the old way and miss them: the reset passes them in.
        legacy = transfer.capture(self.source, SimpleNamespace(owner='42', groups=['-10', '-1020', '-30']))
        self.assertNotIn(topic, [row['space'] for row in legacy['profiles']])
        # A snapshot that names a space outside its chats, or a served Telegram id no chat has, is refused.
        for change in ({'chats': {**chats, 'topics': {**chats['topics'], 'd' * 64: '-99'}}},
                       {'chats': {**chats, 'groups': {'-10': ['-10'], new_group: ['-30']}}},
                       {'groups': ['-10', '-1020', '-30', '-40']}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                transfer.validate_snapshot({**snapshot, **change})
        bad = copy.deepcopy(snapshot)
        bad['profiles'].append({'id': Scopes.profile('d' * 64), 'space': 'd' * 64, 'name': None, 'overrides': {}})
        with self.assertRaises(ValueError):
            transfer.validate_snapshot(bad)

    def test_a_snapshot_taken_before_step_2b_still_restores(self):
        for topic in ('7', '8'):
            directory = self.source / 'profiles' / Scopes.profile('-10/topic/' + topic)
            self.change(directory, {'agent.max_iterations': int(topic)})
            (directory / 'space.json').write_text(json.dumps({'space': '-10/topic/' + topic, 'revision': 0, 'owner': False}))
        snapshot = transfer.capture(self.source, self.policy)
        self.assertEqual(snapshot['chats']['topics'], {'-10/topic/7': '-10', '-10/topic/8': '-10'})
        old = {key: value for key, value in snapshot.items() if key != 'chats'}
        old['format'] = 'nocheh-runtime-preferences-v1'
        transfer.validate_snapshot(old)
        transfer.restore(self.target, old, 'fixture-model', self.admitted(old))
        with patch.dict(os.environ, {'NOCHEH_RUNTIME_HOME': str(self.target)}):
            self.assertEqual(inspect_profile(self.target / 'profiles' / Scopes.profile('-10/topic/8'), 'fixture-model')['values']['agent.max_iterations'], 8)
        # In the old form a topic is only one of a served group's, never the owner's or another group's.
        for space in ('42/topic/1', '-99/topic/1'):
            bad = copy.deepcopy(old)
            bad['profiles'].append({'id': Scopes.profile(space), 'space': space, 'name': None, 'overrides': {}})
            with self.subTest(space=space), self.assertRaises(ValueError):
                transfer.validate_snapshot(bad)

    def test_original_only_catalog_is_authority_and_legacy_marker_cannot_create_profile(self):
        identity = 'profile-' + 'a' * 48
        self.change(self.source / 'profiles' / identity, {'agent.max_iterations': 9})
        catalog = [{'id': identity, 'owner_id': '42', 'name': 'renamed', 'state': 'active'}]
        snapshot = transfer.capture(self.source, self.policy, catalog)
        custom = [row for row in snapshot['profiles'] if row['name'] is not None]
        self.assertEqual(custom, [{'id': identity, 'name': 'renamed', 'space': '42', 'overrides': {'agent.max_iterations': 9}}])
        self.assertNotIn('research', [row['name'] for row in snapshot['profiles']])
        with self.assertRaisesRegex(ValueError, 'invalid_profile_catalog'):
            transfer.capture(self.source, self.policy, [{**catalog[0], 'owner_id': '55'}])
        for admitted in ([{**catalog[0], 'name': 'wrong'}], catalog * 2, [{**catalog[0], 'state': 'retired'}]):
            with self.assertRaisesRegex(ValueError, 'catalog_not_admitted'):
                transfer.restore(self.target, snapshot, 'fixture-model', admitted)
        self.assertEqual(list(self.target.iterdir()), [])

    def test_drift_invalid_snapshots_and_symlinks_fail_before_writes(self):
        snapshot = transfer.capture(self.source, self.policy)
        for key, value in (('owner', 42), ('global', {'agent.max_iterations': True}),
                           ('global', {'model.default': 'unapproved'})):
            bad = {**snapshot, key: value}
            with self.assertRaises(ValueError):
                transfer.restore(self.target, bad, 'fixture-model', self.admitted(snapshot))
        bad = copy.deepcopy(snapshot)
        bad['profiles'][0]['space'] = '-999'
        with self.assertRaises(ValueError):
            transfer.restore(self.target, bad, 'fixture-model', self.admitted(snapshot))
        self.assertEqual(list(self.target.iterdir()), [])
        (self.target / 'profiles').symlink_to(self.source / 'profiles', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'path_denied'):
            transfer.restore(self.target, snapshot, 'fixture-model', self.admitted(snapshot))
        self.assertEqual((self.custom / 'state.db').read_bytes(), b'PRIVATE OLD SESSION')
        self.change(self.group, {'agent.max_iterations': 4})
        with self.assertRaisesRegex(ValueError, 'source_changed'):
            transfer.verify_source(self.source, snapshot)
        config = self.custom / 'config.yaml'
        config.unlink(); config.symlink_to(self.group / 'config.yaml')
        with self.assertRaisesRegex(ValueError, 'path_denied'):
            transfer.capture(self.source, self.policy)

    def test_interrupted_writes_retry_but_changed_target_is_preserved(self):
        snapshot = transfer.capture(self.source, self.policy)
        count = 0

        def fail_after_write(path, value):
            nonlocal count
            atomic_yaml(path, value); count += 1
            if count == 2:
                raise OSError('fixture interruption')

        with patch.object(transfer, 'atomic_yaml', side_effect=fail_after_write):
            with self.assertRaisesRegex(OSError, 'fixture interruption'):
                transfer.restore(self.target, snapshot, 'fixture-model', self.admitted(snapshot))
        transfer.restore(self.target, snapshot, 'fixture-model', self.admitted(snapshot))
        owner = self.target / 'profiles' / Scopes.profile('42') / 'config.yaml'
        value = read(owner); value['agent']['max_iterations'] = 11
        atomic_yaml(owner, value)
        before = {path.relative_to(self.target): path.read_bytes() for path in self.target.rglob('*') if path.is_file()}
        with self.assertRaisesRegex(ValueError, 'target_conflict'):
            transfer.restore(self.target, snapshot, 'fixture-model', self.admitted(snapshot))
        self.assertEqual(before, {path.relative_to(self.target): path.read_bytes() for path in self.target.rglob('*') if path.is_file()})

    def test_profile_inventory_drift_and_ambiguous_legacy_names_stop_transfer(self):
        snapshot = transfer.capture(self.source, self.policy)
        profile = self.source / 'profiles' / 'all'
        profile.mkdir()
        with self.assertRaisesRegex(ValueError, 'source_changed'):
            transfer.verify_source(self.source, snapshot)
        (profile / 'nocheh-owner-profile.json').write_text('{"scope":"owner"}')
        with self.assertRaisesRegex(ValueError, 'name_requires_mapping'):
            transfer.capture(self.source, self.policy)
        # A filesystem marker does not restore a profile retired in control.
        self.assertFalse(transfer.profile_commands(transfer.capture(self.source, self.policy, [])))

    def test_target_history_or_unexpected_profiles_block_all_configuration_writes(self):
        snapshot = transfer.capture(self.source, self.policy)
        identity = snapshot['profiles'][0]['id']
        path = self.target / 'profiles' / identity
        path.mkdir(parents=True)
        (path / 'state.db').write_bytes(b'DO NOT OVERWRITE')
        with self.assertRaisesRegex(ValueError, 'target_not_empty'):
            transfer.restore(self.target, snapshot, 'fixture-model', self.admitted(snapshot))
        self.assertFalse((self.target / 'nocheh-policy.yaml').exists())
        self.assertEqual((path / 'state.db').read_bytes(), b'DO NOT OVERWRITE')
        other = self.root / 'other'
        (other / 'profiles' / 'unrelated').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'target_not_empty'):
            transfer.restore(other, snapshot, 'fixture-model', self.admitted(snapshot))
        self.assertFalse((other / 'nocheh-policy.yaml').exists())
