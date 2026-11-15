"""Freeze current database setup only, before an installation reset.

This is a component of preservation, not its completion gate. The coordinator
must also preserve environment/provider setup, spending and native preferences,
validate their fresh-store admission, and retain maintenance exclusion.
"""
import hashlib
import json
import re
import uuid

from tools.operations.installation import configuration
from tools.acceptance import reset_protocol, reset_quiescence

# Version 2 (ADR-0251) carries the chats and their app ids, so every value names the same chat after the reset. A
# version 1 snapshot, taken before step 2b, still validates and restores: its values name chats in the old way.
FORMAT = 'nocheh-reset-configuration-v2'
FORMATS = ('nocheh-reset-configuration-v1', FORMAT)
CHAT_TABLES = ('chats', 'chat_ids')
ROW_LIMIT = 10000
LEGACY_PRIVACY = ('Do not disclose personal relationships, health, finances, identity details, credentials, '
                  'private plans, or information about other people. Release only relevant non-personal '
                  'knowledge. When uncertain, omit it.')
# Explicit projections prevent new content columns from entering this snapshot.
COMMON = {
    'security_policy': ('SELECT v.document FROM security_policy p '
                        'JOIN security_policy_versions v USING(revision)', ('document',)),
}
LEGACY = {
    'memory_spaces': ('SELECT id,overrides FROM memory_spaces ORDER BY id', ('id', 'overrides')),
}
ORIGINAL = {
    'installation_generation': ("SELECT generation::text AS generation FROM installation WHERE singleton", ('generation',)),
    'guard_mode': ('SELECT mode FROM guard_state WHERE singleton', ('mode',)),
    'runtime_configuration': ('SELECT c.name,v.document FROM runtime_configuration c '
                              'JOIN runtime_configuration_versions v USING(name,revision) ORDER BY c.name', ('name', 'document')),
    'projects': ('SELECT id,name,description,state FROM projects ORDER BY id',
                 ('id', 'name', 'description', 'state')),
    # A topic always follows its group's project (ADR-0247). A store the stores have not started at this version can
    # still hold a topic's own choice; starting them turns it into "follows its group", so it is read that way here.
    # Whether a row names a topic is its chat's row (ADR-0251).
    'project_assignments': ("SELECT a.space_id,"
                            "CASE WHEN t.id IS NOT NULL THEN NULL ELSE a.project_id END AS project_id,"
                            "CASE WHEN t.id IS NOT NULL THEN 'inherit' ELSE a.mode END AS mode "
                            "FROM project_assignments a LEFT JOIN chats t ON t.id=a.space_id AND t.kind='topic' ORDER BY a.space_id",
                            ('space_id', 'project_id', 'mode')),
    # Only the owner's rules. A store the stores have not started at this version still holds the rules a project's
    # share box kept; they are deleted at that start, never kept as the owner's (ADR-0247), so they are left out here.
    # The test reads the row as JSON, so it holds whether or not the old project_id column is still there.
    'sharing_rules': ("SELECT id,name,sources,destination,enabled,mode,instructions FROM sharing_rules r "
                      "WHERE to_jsonb(r)->>'project_id' IS NULL ORDER BY id",
                      ('id', 'name', 'sources', 'destination', 'enabled', 'mode', 'instructions')),
    'memory_access_settings': ('SELECT destination,suggestions,notify_owner,auto_followup,request_ttl_seconds,default_grant_mode FROM memory_access_settings ORDER BY destination',
                               ('destination', 'suggestions', 'notify_owner', 'auto_followup', 'request_ttl_seconds', 'default_grant_mode')),
    'chat_tool_settings': ('SELECT space_id,shell,browser,mcp FROM chat_tool_settings ORDER BY space_id',
                           ('space_id', 'shell', 'browser', 'mcp')),
    'runtime_profiles': ("SELECT id,name,owner_id FROM runtime_profiles WHERE state='active' ORDER BY id", ('id', 'name', 'owner_id')),
    # Every chat with its app ids (ADR-0251): what each value names. A name only when the owner gave it (a topic's);
    # names Telegram showed are content and are seen again after the reset.
    'chats': ("SELECT c.id,n.app,c.kind,c.parent_id,c.topic_key,c.app_type,"
              "CASE WHEN c.title_source='owner' THEN c.title END AS title,"
              "CASE WHEN c.title_source='owner' THEN 'owner' END AS title_source,c.is_forum,c.state "
              "FROM chats c JOIN chat_connections n ON n.id=c.connection_id ORDER BY c.id",
              ('id', 'app', 'kind', 'parent_id', 'topic_key', 'app_type', 'title', 'title_source', 'is_forum', 'state')),
    'chat_ids': ("SELECT n.app,i.external_id,i.chat_id,i.state,i.reason FROM chat_ids i "
                 "JOIN chat_connections n ON n.id=i.connection_id ORDER BY n.app,i.external_id",
                 ('app', 'external_id', 'chat_id', 'state', 'reason')),
}


# Chat values stored before step 2b, in the legacy layout or a version 1 snapshot: a Telegram chat id, or it and one
# of its topics. They are read once here, to convert them; the stores read them only in their seeder (ADR-0251).
LEGACY_SPACE = re.compile(r'(-?[1-9][0-9]{0,18})(?:/topic/([1-9][0-9]{0,15}))?')


def legacy_group_space(value):
    """In the legacy layout, a group or one of its topics (a negative chat id); anything else counts as private."""
    match = LEGACY_SPACE.fullmatch(value) if isinstance(value, str) else None
    return match is not None and match.group(1).startswith('-')


def legacy_chats(values, served=()):
    """The chats rows and app ids that values stored before step 2b name, as the stores' seeder makes them: each value
    stays its chat's id. A value that names no chat ('*', 'desktop:…', anything else) gets none, so it counts as
    private. `served` holds the Telegram ids the setup serves."""
    chats, ids = {}, {}
    for value in values:
        match = LEGACY_SPACE.fullmatch(value) if isinstance(value, str) else None
        if not match: continue
        external, key = match.group(1), match.group(2)
        state = 'active' if external in served else 'off'
        chats.setdefault(external, {'id': external, 'app': 'telegram', 'kind': 'group' if external.startswith('-') else 'private',
                                    'parent_id': None, 'topic_key': None, 'app_type': None, 'title': None, 'title_source': None,
                                    'is_forum': False, 'state': state})
        ids.setdefault(external, {'app': 'telegram', 'external_id': external, 'chat_id': external, 'state': 'current', 'reason': None})
        if key: chats.setdefault(value, {**chats[external], 'id': value, 'kind': 'topic', 'parent_id': external, 'topic_key': key})
    return sorted(chats.values(), key=lambda row: row['id']), sorted(ids.values(), key=lambda row: row['external_id'])


class Chats:
    """The snapshot's chats (ADR-0251): what each value names. A value with no row counts as private."""
    def __init__(self, rows):
        self.rows = {row['id']: row for row in rows}

    def kind(self, value):
        row = self.rows.get(value) if isinstance(value, str) else None
        return row['kind'] if row else None

    def group_space(self, value):
        """A group or one of its topics, the only chats that share (ADR-0242)."""
        row = self.rows.get(value) if isinstance(value, str) else None
        if row and row['kind'] == 'topic': row = self.rows.get(row['parent_id'])
        return bool(row) and row['kind'] == 'group'


def _chats(values):
    """The snapshot's chats rows, checked: each topic's chat is a row, and each app id names a row."""
    chats = values['chats']
    if (len({row['id'] for row in chats}) != len(chats) or
            any(not isinstance(row['id'], str) or row['kind'] not in ('private', 'group', 'topic') or
                (row['kind'] == 'topic') != (row['parent_id'] is not None) for row in chats)):
        raise ValueError('reset_configuration_chats_invalid')
    known = Chats(chats)
    if (any(row['kind'] == 'topic' and known.kind(row['parent_id']) not in ('private', 'group') for row in chats) or
            any(known.kind(row['chat_id']) not in ('private', 'group') for row in values['chat_ids'])):
        raise ValueError('reset_configuration_chats_invalid')
    return known


def catalog(layout, format=FORMAT):
    if layout not in ('legacy', 'original-only-v1'):
        raise ValueError('reset_configuration_layout_invalid')
    tables = {**COMMON, **(LEGACY if layout == 'legacy' else ORIGINAL)}
    return {name: value for name, value in tables.items() if format == FORMAT or name not in CHAT_TABLES}


def validate(snapshot):
    if not isinstance(snapshot, dict) or set(snapshot) != {'format', 'layout', 'configuration'} or snapshot['format'] not in FORMATS:
        raise ValueError('reset_configuration_invalid')
    expected = catalog(snapshot['layout'], snapshot['format'])
    values = snapshot['configuration']
    if not isinstance(values, dict) or set(values) != set(expected):
        raise ValueError('reset_configuration_fields_invalid')
    for name, (_, columns) in expected.items():
        rows = values[name]
        if not isinstance(rows, list) or len(rows) > ROW_LIMIT:
            raise ValueError('reset_configuration_limit')
        if any(not isinstance(row, dict) or set(row) != set(columns) for row in rows):
            raise ValueError('reset_configuration_fields_invalid')
    if len(values['security_policy']) != 1 or not isinstance(values['security_policy'][0]['document'], dict):
        raise ValueError('reset_security_configuration_missing')
    if snapshot['layout'] == 'original-only-v1':
        generations = values['installation_generation']
        if len(generations) != 1 or not isinstance(generations[0]['generation'], str):
            raise ValueError('reset_installation_generation_missing')
        try:
            import uuid
            if str(uuid.UUID(generations[0]['generation'])) != generations[0]['generation']:
                raise ValueError
        except (ValueError, AttributeError):
            raise ValueError('reset_installation_generation_invalid') from None
        if len(values['guard_mode']) != 1 or values['guard_mode'][0]['mode'] not in ('on', 'off'):
            raise ValueError('reset_guard_configuration_missing')
        # An unrecognized setup area must acquire an explicit transfer before
        # reset; silently dropping it would violate setup preservation.
        runtime = values['runtime_configuration']
        if len(runtime) > 1 or any(row['name'] != 'assistant' or not isinstance(row['document'], dict) for row in runtime):
            raise ValueError('reset_runtime_configuration_requires_transfer')
        if snapshot['format'] == FORMAT:
            chats = _chats(values)
        else:
            chats = Chats(legacy_chats([row['space_id'] for row in values['project_assignments']] +
                                       [space for row in values['sharing_rules'] if isinstance(row['sources'], list)
                                        for space in [*row['sources'], row['destination']]])[0])
        # A private chat never joins a project or a sharing rule (ADR-0242). The restore refuses such a row, so a
        # reset stops here, before anything is erased, until the owner removes the private chat from it.
        if any(not isinstance(row['sources'], list) for row in values['sharing_rules']):
            raise ValueError('reset_configuration_fields_invalid')
        if (any(row['mode'] == 'assigned' and not chats.group_space(row['space_id']) for row in values['project_assignments']) or
                any(not all(chats.group_space(space) for space in [*row['sources'], row['destination']]) for row in values['sharing_rules'])):
            raise ValueError('reset_configuration_private_chat_requires_review')
        # A topic always follows its group's project (ADR-0247). The snapshot reads every topic row that way, so only a
        # hand-edited snapshot can hold another choice; the restore refuses it the same way.
        if any(chats.kind(row['space_id']) == 'topic' and row['mode'] != 'inherit' for row in values['project_assignments']):
            raise ValueError('reset_configuration_topic_follows_group')
    if len(reset_protocol.canonical(snapshot)) > reset_protocol.LIMIT:
        raise ValueError('reset_configuration_limit')
    return snapshot


def snapshot(query, layout):
    """Use one read-only, consistent statement in the selected database.

    There are no archive/derived reads, old configuration revisions, event
    grants, pending effects, prepared contexts or released sharing content.
    """
    # The chats tables are there once the stores started at this version (ADR-0251); before that the read fails, and
    # the reset stops before anything is erased.
    fields = []
    for name, (sql, _) in catalog(layout).items():
        fields.append("'" + name + "', (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (" +
                      sql + f' LIMIT {ROW_LIMIT + 1}) t)')
    sql = 'BEGIN READ ONLY; SELECT jsonb_build_object(' + ','.join(fields) + '); COMMIT;'
    raw = query(None if layout == 'legacy' else 'control', sql)
    if len(raw.encode()) > reset_protocol.LIMIT:
        raise ValueError('reset_configuration_limit')
    return validate({'format': FORMAT, 'layout': layout, 'configuration': json.loads(raw)})


def _space(value):
    if (not isinstance(value, str) or not value.strip() or len(value.encode()) > 256 or
            any(ord(character) < 32 for character in value) or '/' in value and not LEGACY_SPACE.fullmatch(value)):
        raise ValueError('reset_legacy_space_invalid')
    return value


def _legacy_rules(rows):
    """Translate legacy destination policy without enabling wider access.

    The legacy filtered mode selected source spaces automatically. Approved and
    isolated modes did not authorize filtered recall, so their migrated rules are
    disabled while retaining the owner's source selection and instructions.
    A private chat never shares or is shared with (ADR-0242): a private source is
    dropped, and a private destination's policy is not carried over.
    """
    result, destinations = [], set()
    for item in rows:
        destination = _space(item['id'])
        if destination in destinations or not isinstance(item['overrides'], dict):
            raise ValueError('reset_legacy_space_invalid')
        destinations.add(destination); values = item['overrides']
        if set(values) - {'mode', 'sources', 'privacy_instructions'}:
            raise ValueError('reset_legacy_space_invalid')
        mode = values.get('mode', 'approved')
        if mode not in ('isolated', 'approved', 'filtered'):
            raise ValueError('reset_legacy_space_invalid')
        raw_sources = values.get('sources', [])
        if not isinstance(raw_sources, list) or len(raw_sources) > 100:
            raise ValueError('reset_legacy_space_invalid')
        sources = sorted({_space(source) for source in raw_sources})
        if destination in sources:
            raise ValueError('reset_legacy_space_requires_review')
        sources = [source for source in sources if legacy_group_space(source)]
        instructions = values.get('privacy_instructions', LEGACY_PRIVACY)
        if not isinstance(instructions, str) or len(instructions.encode()) > 4000:
            raise ValueError('reset_legacy_space_invalid')
        if not legacy_group_space(destination):
            continue
        identifier = hashlib.sha256(reset_protocol.canonical(
            ['legacy-space-policy-v1', destination])).hexdigest()
        result.append({'id': identifier, 'name': f'Migrated legacy {mode} policy {identifier[:12]}',
                       'sources': sources, 'destination': destination,
                       'enabled': mode == 'filtered' and bool(sources),
                       'mode': 'filtered' if mode == 'filtered' else 'approved',
                       'instructions': instructions})
    return sorted(result, key=lambda row: row['id'])


def original_only(snapshot_value, values, preferences, reset_id):
    """Create the exact original-only setup request from either source layout."""
    source = validate(snapshot_value)
    if source['layout'] == 'original-only-v1':
        return source
    try:
        uuid.UUID(reset_id)
        owner = preferences['owner']; profiles = preferences['profiles']
        groups = sorted(set(value.strip() for value in values['TELEGRAM_GROUP_IDS'].split(',') if value.strip()))
        if (preferences['groups'] != groups or owner != values['TELEGRAM_OWNER_ID'] or
                not isinstance(profiles, list)):
            raise ValueError
        runtime_profiles = [{'id': row['id'], 'name': row['name'], 'owner_id': owner}
                            for row in profiles if row.get('name') is not None]
        assistant = {'enabled': values['TELEGRAM_ENABLED'] == 'true',
                     'owner_id': owner, 'group_ids': groups,
                     'group_access': configuration.group_access(values)}
    except (KeyError, TypeError, AttributeError, ValueError):
        raise ValueError('reset_legacy_configuration_invalid') from None
    converted = {'format': FORMAT, 'layout': 'original-only-v1', 'configuration': {
        'security_policy': source['configuration']['security_policy'],
        'installation_generation': [{'generation': str(uuid.uuid5(
            uuid.NAMESPACE_URL, 'nocheh:legacy-installation:' + reset_id))}],
        'guard_mode': [{'mode': values['NOCHEH_GUARD_MODE']}],
        'runtime_configuration': [{'name': 'assistant', 'document': assistant}],
        'projects': [], 'project_assignments': [],
        'sharing_rules': _legacy_rules(source['configuration']['memory_spaces']),
        'memory_access_settings': [{'destination': '*', 'suggestions': 'related', 'notify_owner': True,
                                    'auto_followup': False, 'request_ttl_seconds': 86400,
                                    'default_grant_mode': 'one_time'}],
        'chat_tool_settings': [],
        'runtime_profiles': sorted(runtime_profiles, key=lambda row: row['id'])}}
    # Each chat the converted setup names keeps its old value as its id (ADR-0251).
    rules = converted['configuration']['sharing_rules']
    converted['configuration']['chats'], converted['configuration']['chat_ids'] = legacy_chats(
        [*groups, owner, *(space for row in rules for space in [*row['sources'], row['destination']])], served={*groups, owner})
    return validate(converted)


def freeze(journal, preflight, recovery, *, inspect):
    """Save one immutable private component without advancing preservation.

    Retrying with changed setup fails instead of overwriting the prior copy.
    The complete coordinator retires this private artifact after verified
    restoration; only its content-free digest belongs in public evidence.
    """
    journal.assert_current()
    if journal.value is None or [row['step'] for row in journal.value['steps']] != list(reset_protocol.STEPS[:3]):
        raise ValueError('reset_configuration_phase_required')
    if reset_quiescence.hashlib_preflight(preflight) != journal.value['preflight_sha256']:
        raise ValueError('reset_preflight_changed')

    def held():
        journal.assert_current(); recovery.assert_maintenance()
        reset_quiescence.verify_quiescent(journal, preflight, inspect())

    held()
    captured = snapshot(recovery.query, preflight['installation']['storage_layout'])
    receipt = {'format': 'nocheh-reset-configuration-receipt-v1', 'reset_id': journal.value['reset_id'],
               'preflight_sha256': journal.value['preflight_sha256'],
               'snapshot_sha256': reset_protocol.fingerprint(captured), 'snapshot': captured}
    path = journal.directory / 'configuration.json'
    if path.exists() or path.is_symlink():
        if reset_protocol.read(path) != receipt:
            raise ValueError('reset_configuration_changed')
    held()
    if snapshot(recovery.query, captured['layout']) != captured:
        raise ValueError('reset_configuration_changed')
    if not path.exists():
        reset_protocol.atomic(path, receipt, create=True)
    held()
    if reset_protocol.read(path) != receipt:
        raise ValueError('reset_configuration_changed')
    return {'snapshot_sha256': receipt['snapshot_sha256'],
            'configuration_records': {name: len(rows) for name, rows in captured['configuration'].items()},
            'preservation_complete': False, 'content_backup_created': False}
