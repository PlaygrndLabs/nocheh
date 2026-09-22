"""Freeze current database setup only, before an installation reset.

This is a component of preservation, not its completion gate. The coordinator
must also preserve environment/provider setup, spending and native preferences,
validate their fresh-store admission, and retain maintenance exclusion.
"""
import hashlib
import json
import re
import uuid

from . import configuration, reset_protocol, reset_quiescence

FORMAT = 'nocheh-reset-configuration-v1'
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
    'projects': ('SELECT id,name,description,state FROM projects ORDER BY id', ('id', 'name', 'description', 'state')),
    'project_assignments': ('SELECT space_id,project_id,mode FROM project_assignments ORDER BY space_id', ('space_id', 'project_id', 'mode')),
    'sharing_rules': ('SELECT id,name,sources,destination,enabled,mode,instructions FROM sharing_rules ORDER BY id',
                      ('id', 'name', 'sources', 'destination', 'enabled', 'mode', 'instructions')),
    'memory_access_settings': ('SELECT destination,suggestions,notify_owner,auto_followup,request_ttl_seconds,default_grant_mode FROM memory_access_settings ORDER BY destination',
                               ('destination', 'suggestions', 'notify_owner', 'auto_followup', 'request_ttl_seconds', 'default_grant_mode')),
    'runtime_profiles': ("SELECT id,name,owner_id FROM runtime_profiles WHERE state='active' ORDER BY id", ('id', 'name', 'owner_id')),
}


def catalog(layout):
    if layout not in ('legacy', 'original-only-v1'):
        raise ValueError('reset_configuration_layout_invalid')
    return {**COMMON, **(LEGACY if layout == 'legacy' else ORIGINAL)}


def validate(snapshot):
    if not isinstance(snapshot, dict) or set(snapshot) != {'format', 'layout', 'configuration'} or snapshot['format'] != FORMAT:
        raise ValueError('reset_configuration_invalid')
    expected = catalog(snapshot['layout'])
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
    if len(reset_protocol.canonical(snapshot)) > reset_protocol.LIMIT:
        raise ValueError('reset_configuration_limit')
    return snapshot


def snapshot(query, layout):
    """Use one read-only, consistent statement in the selected database.

    There are no archive/derived reads, old configuration revisions, event
    grants, pending effects, prepared contexts or released sharing content.
    """
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
            any(ord(character) < 32 for character in value) or
            '/topic/' in value and not re.fullmatch(r'-?\d+/topic/[1-9]\d{0,15}', value)):
        raise ValueError('reset_legacy_space_invalid')
    return value


def _legacy_rules(rows):
    """Translate legacy destination policy without enabling wider access.

    The legacy filtered mode selected source spaces automatically. Approved and
    isolated modes did not authorize filtered recall, so their migrated rules are
    disabled while retaining the owner's source selection and instructions.
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
        instructions = values.get('privacy_instructions', LEGACY_PRIVACY)
        if not isinstance(instructions, str) or len(instructions.encode()) > 4000:
            raise ValueError('reset_legacy_space_invalid')
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
                                    'auto_followup': True, 'request_ttl_seconds': 86400,
                                    'default_grant_mode': 'one_time'}],
        'runtime_profiles': sorted(runtime_profiles, key=lambda row: row['id'])}}
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
