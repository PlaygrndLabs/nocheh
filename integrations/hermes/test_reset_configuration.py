import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock

from scripts import reset_configuration as configuration, reset_inventory, reset_protocol, reset_quiescence


class ResetConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name).resolve()
        self.values = {name: [] for name in configuration.catalog('original-only-v1')}
        self.values.update(security_policy=[{'document': {'version': 1, 'rules': []}}],
                           installation_generation=[{'generation': '11111111-1111-4111-8111-111111111111'}],
                           guard_mode=[{'mode': 'on'}])
        self.values['projects'] = [{'id': 'a' * 64, 'name': 'Saved project', 'description': 'Private configuration', 'state': 'active'}]
        self.preflight = {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()), 'executable': False, 'content_copied': False,
            'blockers': [], 'containers': [], 'volumes': [], 'installation': {'root': str(self.state.parent), 'state': str(self.state),
            'state_anchor': reset_inventory.entry(self.state, 'retain_root', 'fixture'), 'memory_state': str(self.state / 'honcho'),
            'project': 'fixture', 'storage_layout': 'original-only-v1', 'config_path': str(self.state / '.env'), 'configuration_sha256': 'a' * 64}}

    def ready(self, journal):
        journal.create(self.preflight, str(uuid.uuid4()))
        for step in reset_protocol.STEPS[:3]: journal.complete(step, 'b' * 64)
        reset_quiescence.fence(self.state, journal.value['reset_id'])

    def test_one_read_only_query_selects_only_explicit_setup_columns(self):
        query = Mock(return_value=json.dumps(self.values))
        result = configuration.snapshot(query, 'original-only-v1')
        store, sql = query.call_args.args
        self.assertEqual(store, 'control'); self.assertTrue(sql.startswith('BEGIN READ ONLY;'))
        self.assertNotIn('SELECT *', sql)
        for forbidden in ('events', 'guard_revisions', 'owner_commands', 'sharing_releases', 'learning_consent', 'schedule_definitions'):
            self.assertNotIn(forbidden, sql)
        self.assertEqual(result['configuration'], self.values)

    def test_legacy_routes_to_legacy_database_and_preserves_explicit_overrides(self):
        values = {'security_policy': self.values['security_policy'], 'memory_spaces': [{'id': '-42', 'overrides': {'mode': 'isolated'}}]}
        query = Mock(return_value=json.dumps(values)); result = configuration.snapshot(query, 'legacy')
        self.assertIsNone(query.call_args.args[0]); self.assertEqual(result['configuration'], values)
        self.assertNotIn('memory_shares', query.call_args.args[1])

    def test_legacy_setup_converts_to_original_only_without_widening_access(self):
        source = {'format': configuration.FORMAT, 'layout': 'legacy', 'configuration': {
            'security_policy': self.values['security_policy'], 'memory_spaces': [
                {'id': '-10', 'overrides': {'mode': 'filtered', 'sources': ['42'],
                                            'privacy_instructions': 'Only fixture facts.'}},
                {'id': '-20', 'overrides': {'mode': 'approved', 'sources': ['42']}},
                {'id': '-30', 'overrides': {'mode': 'isolated', 'sources': ['42']}}]}}
        custom = 'profile-' + 'a' * 48
        preferences = {'owner': '42', 'groups': ['-10', '-20', '-30'], 'profiles': [
            {'id': custom, 'space': '42', 'name': 'research', 'overrides': {}}]}
        values = {'TELEGRAM_ENABLED': 'true', 'TELEGRAM_OWNER_ID': '42',
                  'TELEGRAM_GROUP_IDS': '-30,-20,-10', 'NOCHEH_GUARD_MODE': 'off'}
        reset_id = '22222222-2222-4222-8222-222222222222'
        result = configuration.original_only(source, values, preferences, reset_id)
        self.assertEqual(result['layout'], 'original-only-v1')
        converted = result['configuration']
        self.assertEqual(converted['runtime_configuration'][0]['document'],
                         {'enabled': True, 'owner_id': '42', 'group_ids': ['-10', '-20', '-30']})
        self.assertEqual(converted['guard_mode'], [{'mode': 'off'}])
        self.assertEqual(converted['runtime_profiles'], [{'id': custom, 'name': 'research', 'owner_id': '42'}])
        rules = {row['destination']: row for row in converted['sharing_rules']}
        self.assertTrue(rules['-10']['enabled']); self.assertEqual(rules['-10']['mode'], 'filtered')
        self.assertFalse(rules['-20']['enabled']); self.assertEqual(rules['-20']['mode'], 'approved')
        self.assertFalse(rules['-30']['enabled']); self.assertEqual(rules['-30']['mode'], 'approved')
        self.assertEqual(configuration.original_only(source, values, preferences, reset_id), result)

    def test_legacy_conversion_rejects_unrepresentable_or_mismatched_setup(self):
        base = {'format': configuration.FORMAT, 'layout': 'legacy', 'configuration': {
            'security_policy': self.values['security_policy'],
            'memory_spaces': [{'id': '-10', 'overrides': {'mode': 'filtered', 'sources': ['-10']}}]}}
        values = {'TELEGRAM_ENABLED': 'false', 'TELEGRAM_OWNER_ID': '42',
                  'TELEGRAM_GROUP_IDS': '-10', 'NOCHEH_GUARD_MODE': 'on'}
        preferences = {'owner': '42', 'groups': ['-10'], 'profiles': []}
        with self.assertRaisesRegex(ValueError, 'requires_review'):
            configuration.original_only(base, values, preferences, str(uuid.uuid4()))
        safe = copy.deepcopy(base); safe['configuration']['memory_spaces'] = []
        with self.assertRaisesRegex(ValueError, 'legacy_configuration_invalid'):
            configuration.original_only(safe, values, {**preferences, 'owner': '99'}, str(uuid.uuid4()))

    def test_unknown_fields_and_missing_critical_configuration_fail_closed(self):
        for change in ('content', 'columns', 'security', 'generation', 'guard', 'runtime'):
            values = copy.deepcopy(self.values)
            if change == 'content': values['events'] = []
            if change == 'columns': values['projects'][0]['body'] = 'source content'
            if change == 'security': values['security_policy'] = []
            if change == 'generation': values['installation_generation'] = [{'generation': 'old'}]
            if change == 'guard': values['guard_mode'] = []
            if change == 'runtime': values['runtime_configuration'] = [{'name': 'unknown', 'document': {}}]
            with self.subTest(change=change), self.assertRaises(ValueError):
                configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')

    def test_size_and_row_limits_fail_instead_of_truncating_setup(self):
        values = copy.deepcopy(self.values); values['projects'] *= configuration.ROW_LIMIT + 1
        with self.assertRaisesRegex(ValueError, 'limit'):
            configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')
        with self.assertRaisesRegex(ValueError, 'limit'):
            configuration.snapshot(lambda *_: ' ' * (reset_protocol.LIMIT + 1), 'legacy')

    def test_freeze_is_private_durable_retryable_and_does_not_complete_preservation(self):
        recovery = Mock(spec=['assert_maintenance', 'query']); recovery.query.return_value = json.dumps(self.values)
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            result = configuration.freeze(journal, self.preflight, recovery, inspect=lambda: self.preflight)
            self.assertFalse(result['preservation_complete']); self.assertFalse(result['content_backup_created'])
            self.assertNotIn('Private configuration', json.dumps(result)); self.assertEqual(len(journal.value['steps']), 3)
            path = journal.directory / 'configuration.json'; self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            before = path.read_bytes()
            self.assertEqual(configuration.freeze(journal, self.preflight, recovery, inspect=lambda: self.preflight), result)
            self.assertEqual(path.read_bytes(), before)
            self.values['projects'][0]['name'] = 'Changed'; recovery.query.return_value = json.dumps(self.values)
            with self.assertRaisesRegex(ValueError, 'configuration_changed'):
                configuration.freeze(journal, self.preflight, recovery, inspect=lambda: self.preflight)
            self.assertEqual(path.read_bytes(), before)

    def test_changed_setup_between_reads_writes_no_snapshot(self):
        changed = copy.deepcopy(self.values); changed['guard_mode'][0]['mode'] = 'off'
        recovery = Mock(spec=['assert_maintenance', 'query']); recovery.query.side_effect = [json.dumps(self.values), json.dumps(changed)]
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal)
            with self.assertRaisesRegex(ValueError, 'configuration_changed'):
                configuration.freeze(journal, self.preflight, recovery, inspect=lambda: self.preflight)
            self.assertFalse((journal.directory / 'configuration.json').exists())

    def test_lost_maintenance_or_inactive_fence_prevents_capture(self):
        recovery = Mock(spec=['assert_maintenance', 'query']); recovery.query.return_value = json.dumps(self.values)
        with reset_protocol.locked(self.state) as journal:
            self.ready(journal); recovery.assert_maintenance.side_effect = RuntimeError('lost')
            with self.assertRaisesRegex(RuntimeError, 'lost'):
                configuration.freeze(journal, self.preflight, recovery, inspect=lambda: self.preflight)
            recovery.query.assert_not_called(); recovery.assert_maintenance.side_effect = None
            (self.state / 'spool/.restore-inactive').unlink()
            with self.assertRaises(FileNotFoundError):
                configuration.freeze(journal, self.preflight, recovery, inspect=lambda: self.preflight)
            recovery.query.assert_not_called()

    def test_unsettled_phase_and_symlink_receipt_are_rejected(self):
        recovery = Mock(spec=['assert_maintenance', 'query']); recovery.query.return_value = json.dumps(self.values)
        with reset_protocol.locked(self.state) as journal:
            journal.create(self.preflight, str(uuid.uuid4()))
            with self.assertRaisesRegex(ValueError, 'phase_required'):
                configuration.freeze(journal, self.preflight, recovery, inspect=lambda: self.preflight)
            for step in reset_protocol.STEPS[:3]: journal.complete(step, 'b' * 64)
            reset_quiescence.fence(self.state, journal.value['reset_id'])
            outside = self.state / 'outside'; outside.write_text('{}')
            (journal.directory / 'configuration.json').symlink_to(outside)
            with self.assertRaises(OSError):
                configuration.freeze(journal, self.preflight, recovery, inspect=lambda: self.preflight)
            self.assertEqual(outside.read_text(), '{}')


if __name__ == '__main__': unittest.main()
