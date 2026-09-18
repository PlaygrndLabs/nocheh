"""Freeze current database setup only, before an installation reset.

This is a component of preservation, not its completion gate. The coordinator
must also preserve environment/provider setup, spending and native preferences,
validate their fresh-store admission, and retain maintenance exclusion.
"""
import json

from . import reset_protocol, reset_quiescence

FORMAT = 'nocheh-reset-configuration-v1'
ROW_LIMIT = 10000
# Explicit projections prevent new content columns from entering this snapshot.
COMMON = {
    'security_policy': ('SELECT v.document FROM security_policy p '
                        'JOIN security_policy_versions v USING(revision)', ('document',)),
}
LEGACY = {
    'memory_spaces': ('SELECT id,overrides FROM memory_spaces ORDER BY id', ('id', 'overrides')),
}
ORIGINAL = {
    'guard_mode': ('SELECT mode FROM guard_state WHERE singleton', ('mode',)),
    'runtime_configuration': ('SELECT c.name,v.document FROM runtime_configuration c '
                              'JOIN runtime_configuration_versions v USING(name,revision) ORDER BY c.name', ('name', 'document')),
    'projects': ('SELECT id,name,description,state FROM projects ORDER BY id', ('id', 'name', 'description', 'state')),
    'project_assignments': ('SELECT space_id,project_id,mode FROM project_assignments ORDER BY space_id', ('space_id', 'project_id', 'mode')),
    'sharing_rules': ('SELECT id,name,sources,destination,enabled,mode,instructions FROM sharing_rules ORDER BY id',
                      ('id', 'name', 'sources', 'destination', 'enabled', 'mode', 'instructions')),
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
