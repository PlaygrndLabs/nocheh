import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock

from tools.acceptance import reset_configuration as configuration
from tools.acceptance import reset_inventory
from tools.acceptance import reset_protocol
from tools.acceptance import reset_quiescence


def chat(id, kind, parent=None, state='off'):
    """A chats row as the snapshot reads it (ADR-0251); a topic's key is the end of its old value or a fixture key."""
    return {'id': id, 'app': 'telegram', 'kind': kind, 'parent_id': parent, 'topic_key': id.rsplit('/', 1)[-1] if parent else None,
            'app_type': None, 'title': None, 'title_source': None, 'is_forum': False, 'state': state}


# Old-shaped chats (values stored before step 2b) and one chat first seen later, with a digest id.
CHATS = [chat('-1001', 'group'), chat('-1002', 'group'), chat('123', 'private'), chat('123/topic/5', 'topic', '123'),
         chat('-1001/topic/7', 'topic', '-1001'), chat('e' * 64, 'group'), chat('f' * 64, 'topic', 'e' * 64)]
CHAT_IDS = [{'app': 'telegram', 'external_id': '-1001', 'chat_id': '-1001', 'state': 'current', 'reason': None},
            {'app': 'telegram', 'external_id': '-1002', 'chat_id': '-1002', 'state': 'current', 'reason': None},
            {'app': 'telegram', 'external_id': '123', 'chat_id': '123', 'state': 'current', 'reason': None},
            {'app': 'telegram', 'external_id': '-1003', 'chat_id': 'e' * 64, 'state': 'current', 'reason': None}]


class ResetConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name).resolve()
        self.values = {name: [] for name in configuration.catalog('original-only-v1')}
        self.values.update(security_policy=[{'document': {'version': 1, 'rules': []}}],
                           installation_generation=[{'generation': '11111111-1111-4111-8111-111111111111'}],
                           guard_mode=[{'mode': 'on'}])
        self.values['projects'] = [{'id': 'a' * 64, 'name': 'Saved project', 'description': 'Private configuration', 'state': 'active'}]
        self.values['chats'] = copy.deepcopy(CHATS); self.values['chat_ids'] = copy.deepcopy(CHAT_IDS)
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
                {'id': '-10', 'overrides': {'mode': 'filtered', 'sources': ['-40', '42'],
                                            'privacy_instructions': 'Only fixture facts.'}},
                {'id': '-20', 'overrides': {'mode': 'approved', 'sources': ['-40']}},
                {'id': '-30', 'overrides': {'mode': 'isolated', 'sources': ['-40']}},
                {'id': '-50', 'overrides': {'mode': 'filtered', 'sources': ['42']}},
                {'id': '42', 'overrides': {'mode': 'filtered', 'sources': ['-40']}}]}}
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
                         {'enabled': True, 'owner_id': '42', 'group_ids': ['-10', '-20', '-30'], 'group_access': {}})
        self.assertEqual(converted['guard_mode'], [{'mode': 'off'}])
        self.assertEqual(converted['runtime_profiles'], [{'id': custom, 'name': 'research', 'owner_id': '42'}])
        rules = {row['destination']: row for row in converted['sharing_rules']}
        # A private chat never shares or is shared with: its source is dropped and its own policy is not carried over.
        self.assertEqual(sorted(rules), ['-10', '-20', '-30', '-50'])
        self.assertEqual(rules['-10']['sources'], ['-40']); self.assertEqual(rules['-50']['sources'], [])
        self.assertFalse(rules['-50']['enabled'])
        self.assertEqual(converted['memory_access_settings'][0]['auto_followup'], False)
        self.assertTrue(rules['-10']['enabled']); self.assertEqual(rules['-10']['mode'], 'filtered')
        self.assertFalse(rules['-20']['enabled']); self.assertEqual(rules['-20']['mode'], 'approved')
        self.assertFalse(rules['-30']['enabled']); self.assertEqual(rules['-30']['mode'], 'approved')
        self.assertTrue(all(set(row) == {'id', 'name', 'sources', 'destination', 'enabled', 'mode', 'instructions'} for row in rules.values()))
        # Each chat the setup names keeps its old value as its id, served as the setup says (ADR-0251).
        self.assertEqual([(row['id'], row['kind'], row['state']) for row in converted['chats']],
                         [('-10', 'group', 'active'), ('-20', 'group', 'active'), ('-30', 'group', 'active'), ('-40', 'group', 'off'),
                          ('-50', 'group', 'off'), ('42', 'private', 'active')])
        self.assertEqual({row['external_id']: row['chat_id'] for row in converted['chat_ids']}, {row['id']: row['id'] for row in converted['chats']})
        self.assertEqual(result['format'], 'nocheh-reset-configuration-v2')
        self.assertEqual(configuration.original_only(source, values, preferences, reset_id), result)
        values['TELEGRAM_GROUP_ACCESS'] = '{"-10":{"granted":["77"],"denied":["88"]}}'
        preserved = configuration.original_only(source, values, preferences, reset_id)
        self.assertEqual(preserved['configuration']['runtime_configuration'][0]['document']['group_access'],
                         {'-10': {'granted': ['77'], 'denied': ['88']}})

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

    def test_a_private_chat_in_a_rule_or_project_stops_the_reset_before_erasure(self):
        rule = {'id': 'b' * 64, 'name': 'Saved share', 'sources': ['-1001'], 'destination': '-1002', 'enabled': True,
                'mode': 'approved', 'instructions': ''}
        assigned = {'space_id': '-1001', 'project_id': 'a' * 64, 'mode': 'assigned'}
        values = copy.deepcopy(self.values); values['sharing_rules'] = [rule]; values['project_assignments'] = [assigned]
        self.assertEqual(configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')['configuration'], values)
        for change in ('source', 'topic', 'destination', 'desktop', 'assignment', 'padded'):
            values = copy.deepcopy(self.values); values['sharing_rules'] = [dict(rule)]; values['project_assignments'] = [dict(assigned)]
            if change == 'source': values['sharing_rules'][0]['sources'] = ['-1001', '123']
            # An ID Telegram never gives a group counts as private, as the server's groupSpace decides.
            if change == 'padded': values['sharing_rules'][0]['sources'] = ['-01001']
            if change == 'topic': values['sharing_rules'][0]['sources'] = ['123/topic/5']
            if change == 'destination': values['sharing_rules'][0]['destination'] = '123'
            if change == 'desktop': values['sharing_rules'][0]['sources'] = ['desktop:personal_chat:9']
            if change == 'assignment': values['project_assignments'][0]['space_id'] = '123'
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'private_chat_requires_review'):
                configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')
        values = copy.deepcopy(self.values); values['project_assignments'] = [{**assigned, 'space_id': '123', 'mode': 'none', 'project_id': None}]
        self.assertEqual(configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')['configuration'], values,
                         'a private chat may be kept out of every project')

    def test_old_share_box_fields_and_a_topic_choice_stop_the_reset_before_erasure(self):
        # A project never shares between its groups and a topic always follows its group's project (ADR-0247).
        assigned = {'space_id': '-1001', 'project_id': 'a' * 64, 'mode': 'assigned'}
        values = copy.deepcopy(self.values); values['project_assignments'] = [assigned, {'space_id': '-1001/topic/7', 'project_id': None, 'mode': 'inherit'}]
        self.assertEqual(configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')['configuration'], values)
        for change in ('sharing_enabled', 'sharing_mode', 'share_into', 'project_id'):
            values = copy.deepcopy(self.values); values['project_assignments'] = [dict(assigned)]
            values['sharing_rules'] = [{'id': 'b' * 64, 'name': 'Saved share', 'sources': ['-1001'], 'destination': '-1002', 'enabled': True,
                                        'mode': 'approved', 'instructions': ''}]
            if change == 'sharing_enabled': values['projects'][0]['sharing_enabled'] = True
            if change == 'sharing_mode': values['projects'][0]['sharing_mode'] = 'filtered'
            if change == 'share_into': values['project_assignments'][0]['share_into'] = True
            if change == 'project_id': values['sharing_rules'][0]['project_id'] = 'a' * 64
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'fields_invalid'):
                configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')
        for mode, project in (('assigned', 'a' * 64), ('none', None)):
            values = copy.deepcopy(self.values); values['project_assignments'] = [{'space_id': '-1001/topic/7', 'project_id': project, 'mode': mode}]
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, 'topic_follows_group'):
                configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')

    def test_a_project_rule_in_a_store_not_yet_started_is_left_out_never_kept_as_the_owners(self):
        # Starting the stores at this version deletes the rules a project's share box kept (ADR-0247). A reset that reads
        # an older store selects only the owner's rules, by a test that holds with or without the old column, so a
        # project rule never comes back as an owner rule after the reset.
        query = Mock(return_value=json.dumps(self.values))
        configuration.snapshot(query, 'original-only-v1')
        sql = query.call_args.args[1]
        self.assertIn("FROM sharing_rules r WHERE to_jsonb(r)->>'project_id' IS NULL ORDER BY id", sql)
        self.assertNotIn('project_id FROM sharing_rules', sql)
        self.assertEqual(sql.count('FROM sharing_rules'), 1)

    def test_a_topic_choice_in_a_store_not_yet_started_is_read_as_following_its_group(self):
        # Starting the stores at this version turns a topic's own project choice into "follows its group" (ADR-0247). A
        # reset that reads an older store reads every topic row that way, so such a store does not stop the reset.
        query = Mock(return_value=json.dumps(self.values))
        configuration.snapshot(query, 'original-only-v1')
        sql = query.call_args.args[1]
        self.assertIn("SELECT a.space_id,CASE WHEN t.id IS NOT NULL THEN NULL ELSE a.project_id END AS project_id,"
                      "CASE WHEN t.id IS NOT NULL THEN 'inherit' ELSE a.mode END AS mode "
                      "FROM project_assignments a LEFT JOIN chats t ON t.id=a.space_id AND t.kind='topic'", sql)

    def test_a_version_1_snapshot_still_validates_by_its_old_values(self):
        # A snapshot taken before step 2b carries no chats; its values name chats in the old way, read once here.
        values = {name: rows for name, rows in self.values.items() if name not in ('chats', 'chat_ids')}
        values['project_assignments'] = [{'space_id': '-1001', 'project_id': 'a' * 64, 'mode': 'assigned'},
                                         {'space_id': '-1001/topic/7', 'project_id': None, 'mode': 'inherit'}]
        old = {'format': 'nocheh-reset-configuration-v1', 'layout': 'original-only-v1', 'configuration': values}
        self.assertEqual(configuration.validate(copy.deepcopy(old)), old)
        for space, mode, error in (('123', 'assigned', 'private_chat_requires_review'), ('-1001/topic/7', 'assigned', 'topic_follows_group')):
            broken = copy.deepcopy(old); broken['configuration']['project_assignments'] = [{'space_id': space, 'project_id': 'a' * 64, 'mode': mode}]
            with self.subTest(space=space), self.assertRaisesRegex(ValueError, error):
                configuration.validate(broken)
        with self.assertRaisesRegex(ValueError, 'fields_invalid'):
            configuration.validate({**old, 'configuration': {**values, 'chats': []}})

    def test_the_snapshot_carries_each_chat_and_decides_kinds_from_its_rows(self):
        # Version 2 carries the chats and their app ids (ADR-0251): a digest id is a group or topic by its row, and an id
        # with no row counts as private, however it looks.
        query = Mock(return_value=json.dumps(self.values))
        result = configuration.snapshot(query, 'original-only-v1')
        self.assertEqual(result['format'], 'nocheh-reset-configuration-v2')
        sql = query.call_args.args[1]
        self.assertIn("CASE WHEN c.title_source='owner' THEN c.title END AS title", sql, 'only names the owner gave travel')
        self.assertIn('FROM chat_ids i JOIN chat_connections n', sql)
        rule = {'id': 'b' * 64, 'name': 'Saved share', 'sources': ['f' * 64], 'destination': 'e' * 64, 'enabled': True,
                'mode': 'approved', 'instructions': ''}
        values = copy.deepcopy(self.values); values['sharing_rules'] = [rule]
        values['project_assignments'] = [{'space_id': 'e' * 64, 'project_id': 'a' * 64, 'mode': 'assigned'},
                                         {'space_id': 'f' * 64, 'project_id': None, 'mode': 'inherit'}]
        self.assertEqual(configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')['configuration'], values)
        values['project_assignments'][1] = {'space_id': 'f' * 64, 'project_id': 'a' * 64, 'mode': 'assigned'}
        with self.assertRaisesRegex(ValueError, 'topic_follows_group'):
            configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')
        values = copy.deepcopy(self.values); values['sharing_rules'] = [{**rule, 'sources': ['d' * 64]}]
        with self.assertRaisesRegex(ValueError, 'private_chat_requires_review'):
            configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')
        for broken in ('orphan_topic', 'orphan_id', 'duplicate'):
            values = copy.deepcopy(self.values)
            if broken == 'orphan_topic': values['chats'].append(chat('c' * 64, 'topic', 'd' * 64))
            if broken == 'orphan_id': values['chat_ids'].append({**CHAT_IDS[0], 'external_id': '-1004', 'chat_id': 'd' * 64})
            if broken == 'duplicate': values['chats'].append(CHATS[0])
            with self.subTest(broken=broken), self.assertRaisesRegex(ValueError, 'chats_invalid'):
                configuration.snapshot(lambda *_: json.dumps(values), 'original-only-v1')
        self.assertEqual(sql.count('FROM project_assignments'), 1)

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
