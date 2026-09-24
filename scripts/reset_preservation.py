"""Freeze every non-content reset preservation input before any erasure.

The caller owns the reset journal and PostgreSQL maintenance lock.  This module
binds current database setup, native preferences, sanitized provider accounting,
retained files, explicit archive ownership decisions and the exact file-erasure
manifest.  It does not erase source stores, containers or volumes.
"""
import hashlib
import json
import os
import stat
import uuid
from pathlib import Path
from types import SimpleNamespace

from integrations.hermes import preference_transfer

from . import (configuration, reset_accounting, reset_configuration, reset_files,
               reset_ownership, reset_protocol, reset_quiescence)

FORMAT = 'nocheh-reset-preservation-v1'
PRIVATE_LIMIT = 64 * 1024 * 1024
MAX_PRESERVED_ENTRIES = 100000
MAX_PRESERVED_BYTES = 64 * 1024 * 1024 * 1024


def _private_read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > PRIVATE_LIMIT:
            raise ValueError('reset_preservation_file_invalid')
        raw = source.read(PRIVATE_LIMIT + 1)
    if len(raw) > PRIVATE_LIMIT:
        raise ValueError('reset_preservation_file_invalid')
    return json.loads(raw)


def _private_create(path, value):
    raw = reset_protocol.canonical(value) + b'\n'
    if len(raw) > PRIVATE_LIMIT:
        raise ValueError('reset_preservation_file_limit')
    temporary = path.with_name('.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(raw); output.flush(); os.fsync(output.fileno())
        os.link(temporary, path)
        temporary.unlink()
        reset_protocol.sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _immutable(path, value):
    if path.exists() or path.is_symlink():
        if _private_read(path) != value:
            raise ValueError('reset_preservation_artifact_changed')
    else:
        _private_create(path, value)
    if _private_read(path) != value:
        raise ValueError('reset_preservation_artifact_changed')


def _frozen_files(journal, preflight, inspect, current):
    """Keep the frozen manifest while a stopped Redis AOF changes size/time."""
    path = journal.directory / 'files.json'
    if not (path.exists() or path.is_symlink()):
        _immutable(path, current)
        return current
    saved = _private_read(path)
    if saved == current:
        return saved
    erasure = journal.directory / 'erasure.json'
    if (len(journal.value['steps']) != 4 or
            erasure.exists() and reset_protocol.read(erasure).get('stage') != 'prepared'):
        raise ValueError('reset_preservation_artifact_changed')
    observed = inspect()
    reset_quiescence.verify_quiescent(journal, preflight, observed)
    redis = [row for row in observed['containers'] if row['service'] == 'inngest-redis']
    if (len(redis) != 1 or redis[0]['state'] not in ('exited', 'created') or
            {key: value for key, value in saved.items() if key not in ('manifest', 'manifest_sha256')} !=
            {key: value for key, value in current.items() if key not in ('manifest', 'manifest_sha256')} or
            saved.get('manifest_sha256') != reset_protocol.fingerprint(saved.get('manifest')) or
            not reset_files.equivalent_after_redis_stop(saved['manifest'], current['manifest'])):
        raise ValueError('reset_preservation_artifact_changed')
    return saved


def _kind(value):
    if stat.S_ISDIR(value.st_mode):
        return 'directory'
    if stat.S_ISREG(value.st_mode):
        if value.st_nlink != 1:
            raise ValueError('reset_preserved_hardlink_denied')
        return 'file'
    if stat.S_ISLNK(value.st_mode):
        return 'symlink'
    raise ValueError('reset_preserved_type_denied')


def _stable(value):
    return {'device': value.st_dev, 'inode': value.st_ino, 'kind': _kind(value),
            'mode': stat.S_IMODE(value.st_mode), 'size': value.st_size,
            'mtime_ns': value.st_mtime_ns, 'ctime_ns': value.st_ctime_ns}


def _fingerprint_path(row, *, transformed=False):
    """Hash retained bytes and identities without retaining their contents."""
    path = reset_files.absolute(row['path'])
    digest = hashlib.sha256(); count = 0; total = 0

    def add(kind, relative, metadata, payload=b''):
        digest.update(reset_protocol.canonical([kind, relative, metadata]) + b'\n')
        digest.update(hashlib.sha256(payload).digest())

    def walk(fd, name, relative):
        nonlocal count, total
        value = os.stat(name, dir_fd=fd, follow_symlinks=False); metadata = _stable(value)
        count += 1
        if count > MAX_PRESERVED_ENTRIES:
            raise ValueError('reset_preserved_entry_limit')
        if metadata['kind'] == 'directory':
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                if _stable(os.fstat(child)) != metadata:
                    raise ValueError('reset_preserved_identity_changed')
                names = sorted(os.listdir(child)); add('directory', relative, metadata)
                for item in names:
                    walk(child, item, relative + '/' + item if relative else item)
                if _stable(os.fstat(child)) != metadata or names != sorted(os.listdir(child)):
                    raise ValueError('reset_preserved_identity_changed')
            finally:
                os.close(child)
        elif metadata['kind'] == 'file':
            child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
            content = hashlib.sha256(); size = 0
            try:
                if _stable(os.fstat(child)) != metadata:
                    raise ValueError('reset_preserved_identity_changed')
                while chunk := os.read(child, 1024 * 1024):
                    content.update(chunk); size += len(chunk)
                if _stable(os.fstat(child)) != metadata or size != metadata['size']:
                    raise ValueError('reset_preserved_identity_changed')
            finally:
                os.close(child)
            total += size
            add('file', relative, metadata, content.digest())
        else:
            target = os.readlink(name, dir_fd=fd).encode()
            total += len(target); add('symlink', relative, metadata, target)

    with reset_files.parent(path) as (fd, name, _):
        observed = reset_files.inspect_at(fd, name)
        present = observed is not None
        if not transformed:
            if present != row.get('exists'):
                raise ValueError('reset_preserved_identity_changed')
            if present and any(observed[key] != row.get(key) for key in ('device', 'inode', 'kind')):
                raise ValueError('reset_preserved_identity_changed')
        if present:
            walk(fd, name, '')
        else:
            add('absent', '', {})
    return {'path': str(path), 'action': row['action'], 'exists': present,
            'sha256': digest.hexdigest(), 'entries': count, 'bytes': total}


def _preserved_rows(preflight, reviewed):
    rows = [row for row in preflight['paths'] if row['action'] in ('preserve', 'sanitize_accounting', 'sqlite_checkpoint')
            and row.get('reason') != 'reset_coordinator_journal']
    rows.extend(reviewed['preserve'])
    paths = [row['path'] for row in rows]
    if len(paths) != len(set(paths)):
        raise ValueError('reset_preserved_scope_overlap')
    ordered = sorted(rows, key=lambda row: row['path'])
    for index, left in enumerate(ordered):
        a = Path(left['path'])
        if any(a in Path(right['path']).parents or Path(right['path']) in a.parents for right in ordered[index + 1:]):
            raise ValueError('reset_preserved_scope_overlap')
    return ordered


def _snapshot_preserved(preflight, reviewed, accounting_path=None):
    managed = set()
    if accounting_path is not None:
        # SQLite mutates the reviewed database in place. Its device/inode/kind
        # therefore remain bound; only checkpoint companions and the native lock
        # may appear or disappear around a safely retryable sanitization.
        managed = {str(accounting_path) + suffix for suffix in ('-wal', '-shm', '-journal', '.manager.lock')}
    values = [_fingerprint_path(row, transformed=row['path'] in managed)
              for row in _preserved_rows(preflight, reviewed)]
    if sum(row['entries'] for row in values) > MAX_PRESERVED_ENTRIES:
        raise ValueError('reset_preserved_entry_limit')
    if sum(row['bytes'] for row in values) > MAX_PRESERVED_BYTES:
        raise ValueError('reset_preserved_byte_limit')
    result = {'format': 'nocheh-reset-preserved-files-v1', 'entries': values,
              'roots': len(values), 'files': sum(row['entries'] for row in values),
              'bytes': sum(row['bytes'] for row in values)}
    result['sha256'] = reset_protocol.fingerprint(result)
    return result


def _post_shutdown_rebound(journal, preflight):
    """Bind only native status files replaced during a verified shutdown."""
    rows = {row['path']: row for row in preflight['paths']}
    rebound = {}
    for relative in reset_files.POST_SHUTDOWN_STATUS:
        path = journal.state / relative
        row = rows.get(str(path))
        if row is None:
            continue
        if row['action'] != 'erase' or not row['exists'] or row.get('kind') != 'file':
            raise ValueError('reset_status_identity_changed')
        with reset_files.parent(path) as (fd, name, _):
            observed = reset_files.inspect_at(fd, name)
        if (observed is None or observed['kind'] != 'file' or
                observed['device'] != row['device']):
            raise ValueError('reset_status_identity_changed')
        if observed['inode'] != row['inode']:
            rebound[str(path)] = {key: observed[key] for key in reset_files.FIELDS}
    return rebound


def _policy(values, snapshot):
    configuration.validate(values)
    groups = sorted(set(value.strip() for value in values['TELEGRAM_GROUP_IDS'].split(',') if value.strip()))
    document = {'enabled': values['TELEGRAM_ENABLED'] == 'true',
                'owner_id': values['TELEGRAM_OWNER_ID'] or None, 'group_ids': groups}
    policy = SimpleNamespace(owner=document['owner_id'], groups=document['group_ids'])
    if not policy.owner:
        raise ValueError('reset_owner_configuration_missing')
    if snapshot['layout'] == 'original-only-v1':
        rows = snapshot['configuration']['runtime_configuration']
        if len(rows) != 1 or rows[0] != {'name': 'assistant', 'document': document}:
            raise ValueError('reset_runtime_configuration_mismatch')
        if snapshot['configuration']['guard_mode'] != [{'mode': values['NOCHEH_GUARD_MODE']}]:
            raise ValueError('reset_guard_configuration_mismatch')
    return policy


def _configuration(journal, preflight, recovery, inspect):
    path = journal.directory / 'configuration.json'
    if len(journal.value['steps']) == 3:
        reset_configuration.freeze(journal, preflight, recovery, inspect=inspect)
    receipt = reset_protocol.read(path)
    if (receipt.get('format') != 'nocheh-reset-configuration-receipt-v1' or
            receipt.get('reset_id') != journal.value['reset_id'] or
            receipt.get('preflight_sha256') != journal.value['preflight_sha256'] or
            receipt.get('snapshot_sha256') != reset_protocol.fingerprint(receipt.get('snapshot'))):
        raise ValueError('reset_configuration_changed')
    snapshot = reset_configuration.validate(receipt['snapshot'])
    if reset_configuration.snapshot(recovery.query, snapshot['layout']) != snapshot:
        raise ValueError('reset_configuration_changed')
    return receipt


def _preference_receipt(journal, preflight, policy, config_receipt):
    snapshot = config_receipt['snapshot']; layout = snapshot['layout']
    catalog = None
    if layout == 'original-only-v1':
        catalog = [{**row, 'state': 'active'} for row in snapshot['configuration']['runtime_profiles']]
    native = journal.state / 'hermes'
    path = journal.directory / 'preferences.json'
    if path.exists() or path.is_symlink():
        receipt = _private_read(path)
    else:
        captured = preference_transfer.capture(native, policy, catalog)
        receipt = {'format': 'nocheh-reset-preferences-receipt-v1', 'reset_id': journal.value['reset_id'],
                   'preflight_sha256': journal.value['preflight_sha256'],
                   'snapshot_sha256': reset_protocol.fingerprint(captured), 'snapshot': captured}
        _immutable(path, receipt)
    if (not isinstance(receipt, dict) or receipt.get('format') != 'nocheh-reset-preferences-receipt-v1' or
            receipt.get('reset_id') != journal.value['reset_id'] or
            receipt.get('preflight_sha256') != journal.value['preflight_sha256'] or
            receipt.get('snapshot_sha256') != reset_protocol.fingerprint(receipt.get('snapshot'))):
        raise ValueError('reset_preferences_changed')
    preference_transfer.validate_snapshot(receipt['snapshot'])
    if (receipt['snapshot']['owner'] != policy.owner or receipt['snapshot']['groups'] != sorted(set(policy.groups))):
        raise ValueError('reset_preferences_scope_changed')
    preference_transfer.verify_source(native, receipt['snapshot'])
    return receipt


def _accounting_receipt(journal, preflight, reviewed, sanitize):
    targets = [row for row in preflight['paths'] if row['action'] == 'sanitize_accounting']
    if len(targets) > 1:
        raise ValueError('reset_accounting_scope_invalid')
    target = targets[0] if targets else None
    path = journal.directory / 'accounting.json'
    if target is None or not target['exists']:
        receipt = {'format': 'nocheh-reset-accounting-receipt-v1', 'reset_id': journal.value['reset_id'],
                   'preflight_sha256': journal.value['preflight_sha256'], 'present': False,
                   'accounting_preserved': True, 'backup_created': False}
        _immutable(path, receipt)
        return receipt, None
    accounting_path = reset_files.absolute(target['path'])
    rows = [row for row in _preserved_rows(preflight, reviewed)
            if row['path'] in {str(accounting_path) + suffix for suffix in ('', '-wal', '-shm', '-journal', '.manager.lock')}]
    if path.exists() or path.is_symlink():
        receipt = _private_read(path)
    else:
        result = sanitize(accounting_path)
        if result.get('accounting_preserved') is not True or result.get('backup_created') is not False:
            raise RuntimeError('reset_accounting_preservation_failed')
        frozen = {'format': 'nocheh-reset-accounting-files-v1',
                  'entries': [_fingerprint_path(row, transformed=row['path'] != str(accounting_path)) for row in rows]}
        frozen['sha256'] = reset_protocol.fingerprint(frozen)
        receipt = {'format': 'nocheh-reset-accounting-receipt-v1', 'reset_id': journal.value['reset_id'],
                   'preflight_sha256': journal.value['preflight_sha256'], 'present': True,
                   'accounting_preserved': True, 'backup_created': False,
                   'files': frozen, 'erased_rows': result.get('erased_rows', {})}
        _immutable(path, receipt)
    required = {'format', 'reset_id', 'preflight_sha256', 'present', 'accounting_preserved',
                'backup_created', 'files', 'erased_rows'}
    if (not isinstance(receipt, dict) or set(receipt) != required or
            receipt['format'] != 'nocheh-reset-accounting-receipt-v1' or
            receipt['reset_id'] != journal.value['reset_id'] or
            receipt['preflight_sha256'] != journal.value['preflight_sha256'] or
            receipt['present'] is not True or receipt['accounting_preserved'] is not True or
            receipt['backup_created'] is not False):
        raise ValueError('reset_accounting_receipt_changed')
    if (not isinstance(receipt['erased_rows'], dict) or
            any(not isinstance(name, str) or type(count) is not int or count < 0
                for name, count in receipt['erased_rows'].items())):
        raise ValueError('reset_accounting_receipt_changed')
    current = {'format': 'nocheh-reset-accounting-files-v1',
               'entries': [_fingerprint_path(row, transformed=row['path'] != str(accounting_path)) for row in rows]}
    current['sha256'] = reset_protocol.fingerprint(current)
    if current != receipt['files']:
        raise ValueError('reset_accounting_changed')
    return receipt, accounting_path


def _public(receipt):
    return {'phase': 'preservation_frozen', **receipt['counts'],
            'accounting_preserved': receipt['accounting_preserved'],
            'content_backup_created': False, 'source_content_copied': False}


def assert_frozen(journal, preflight):
    """Verify immutable component receipts without rereading erased sources."""
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) not in (4, 5) or
            journal.value['steps'][3]['step'] != 'preservation_frozen' or
            len(journal.value['steps']) == 5 and journal.value['steps'][4]['step'] != 'erased' or
            journal.value['preflight_sha256'] != reset_quiescence.hashlib_preflight(preflight)):
        raise ValueError('reset_preservation_phase_required')
    receipt = _private_read(journal.directory / 'preservation.json')
    required = {'format', 'reset_id', 'preflight_sha256', 'configuration_sha256', 'preferences_sha256',
                'accounting_sha256', 'preserved_sha256', 'ownership_sha256', 'file_manifest_sha256',
                'counts', 'accounting_preserved', 'content_backup_created', 'source_content_copied'}
    if (not isinstance(receipt, dict) or set(receipt) != required or receipt['format'] != FORMAT or
            receipt['reset_id'] != journal.value['reset_id'] or
            receipt['preflight_sha256'] != journal.value['preflight_sha256'] or
            receipt['accounting_preserved'] is not True or receipt['content_backup_created'] is not False or
            receipt['source_content_copied'] is not False or
            journal.value['steps'][3]['evidence_sha256'] != reset_protocol.fingerprint(receipt)):
        raise ValueError('reset_preservation_evidence_changed')
    configuration_receipt = reset_protocol.read(journal.directory / 'configuration.json')
    preferences = _private_read(journal.directory / 'preferences.json')
    accounting = _private_read(journal.directory / 'accounting.json')
    preserved = _private_read(journal.directory / 'preserved.json')
    ownership = _private_read(journal.directory / 'ownership.json')
    files = _private_read(journal.directory / 'files.json')
    configuration_fields = {'format', 'reset_id', 'preflight_sha256', 'snapshot_sha256', 'snapshot'}
    preference_fields = {'format', 'reset_id', 'preflight_sha256', 'snapshot_sha256', 'snapshot'}
    accounting_fields = ({'format', 'reset_id', 'preflight_sha256', 'present', 'accounting_preserved', 'backup_created'}
                         if accounting.get('present') is False else
                         {'format', 'reset_id', 'preflight_sha256', 'present', 'accounting_preserved',
                          'backup_created', 'files', 'erased_rows'})
    preserved_fields = {'format', 'entries', 'roots', 'files', 'bytes', 'sha256'}
    ownership_fields = {'format', 'reset_id', 'review_sha256', 'review'}
    file_fields = {'format', 'reset_id', 'preflight_sha256', 'ownership_sha256', 'manifest_sha256', 'manifest'}
    count_fields = {'configuration_records', 'preference_profiles', 'preserved_roots',
                    'preserved_entries', 'reviewed_items', 'erasure_targets'}
    if (not isinstance(configuration_receipt, dict) or set(configuration_receipt) != configuration_fields or
            not isinstance(preferences, dict) or set(preferences) != preference_fields or
            not isinstance(accounting, dict) or set(accounting) != accounting_fields or
            not isinstance(preserved, dict) or set(preserved) != preserved_fields or
            not isinstance(ownership, dict) or set(ownership) != ownership_fields or
            not isinstance(files, dict) or set(files) != file_fields or
            not isinstance(receipt['counts'], dict) or set(receipt['counts']) != count_fields or
            any(type(value) is not int or value < 0 for value in receipt['counts'].values()) or
            configuration_receipt.get('format') != 'nocheh-reset-configuration-receipt-v1' or
            configuration_receipt.get('reset_id') != journal.value['reset_id'] or
            configuration_receipt.get('preflight_sha256') != journal.value['preflight_sha256'] or
            preferences.get('format') != 'nocheh-reset-preferences-receipt-v1' or
            preferences.get('reset_id') != journal.value['reset_id'] or
            preferences.get('preflight_sha256') != journal.value['preflight_sha256'] or
            accounting.get('format') != 'nocheh-reset-accounting-receipt-v1' or
            accounting.get('reset_id') != journal.value['reset_id'] or
            accounting.get('preflight_sha256') != journal.value['preflight_sha256'] or
            preserved.get('format') != 'nocheh-reset-preserved-files-v1' or
            ownership.get('format') != reset_ownership.FORMAT or
            ownership.get('reset_id') != journal.value['reset_id'] or
            files.get('format') != 'nocheh-reset-files-receipt-v1' or
            files.get('reset_id') != journal.value['reset_id'] or
            files.get('preflight_sha256') != journal.value['preflight_sha256'] or
            files.get('ownership_sha256') != receipt['ownership_sha256'] or
            configuration_receipt.get('snapshot_sha256') != receipt['configuration_sha256'] or
            configuration_receipt.get('snapshot_sha256') != reset_protocol.fingerprint(configuration_receipt.get('snapshot')) or
            preferences.get('snapshot_sha256') != receipt['preferences_sha256'] or
            preferences.get('snapshot_sha256') != reset_protocol.fingerprint(preferences.get('snapshot')) or
            reset_protocol.fingerprint(accounting) != receipt['accounting_sha256'] or
            preserved.get('sha256') != receipt['preserved_sha256'] or
            reset_protocol.fingerprint({key: value for key, value in preserved.items() if key != 'sha256'}) != preserved.get('sha256') or
            ownership.get('review_sha256') != receipt['ownership_sha256'] or
            ownership.get('review_sha256') != reset_protocol.fingerprint(ownership.get('review')) or
            files.get('manifest_sha256') != receipt['file_manifest_sha256'] or
            files.get('manifest_sha256') != reset_protocol.fingerprint(files.get('manifest'))):
        raise ValueError('reset_preservation_artifact_changed')
    reset_configuration.validate(configuration_receipt['snapshot'])
    preference_transfer.validate_snapshot(preferences['snapshot'])
    try:
        counts = {'configuration_records': sum(len(rows) for rows in configuration_receipt['snapshot']['configuration'].values()),
                  'preference_profiles': len(preferences['snapshot']['profiles']),
                  'preserved_roots': preserved['roots'], 'preserved_entries': preserved['files'],
                  'reviewed_items': sum(len(root['entries']) for root in ownership['review']['roots']),
                  'erasure_targets': len(files['manifest']['targets'])}
    except (KeyError, TypeError):
        raise ValueError('reset_preservation_artifact_changed') from None
    if (counts != receipt['counts'] or accounting.get('accounting_preserved') is not True or
            accounting.get('backup_created') is not False):
        raise ValueError('reset_preservation_artifact_changed')
    return {'receipt': receipt, 'configuration': configuration_receipt, 'preferences': preferences,
            'accounting': accounting, 'preserved': preserved, 'ownership': ownership, 'files': files}


def verify_retained(journal, preflight):
    """Rehash only paths that must survive after content erasure begins."""
    artifacts = assert_frozen(journal, preflight); saved = artifacts['preserved']
    current = []
    for row in saved.get('entries', []):
        if not isinstance(row, dict) or not isinstance(row.get('path'), str) or not isinstance(row.get('action'), str):
            raise ValueError('reset_preservation_artifact_changed')
        current.append(_fingerprint_path({'path': row['path'], 'action': row['action']}, transformed=True))
    observed = {'format': 'nocheh-reset-preserved-files-v1', 'entries': current,
                'roots': len(current), 'files': sum(row['entries'] for row in current),
                'bytes': sum(row['bytes'] for row in current)}
    observed['sha256'] = reset_protocol.fingerprint(observed)
    if observed != saved:
        raise ValueError('reset_preserved_files_changed')
    return artifacts


def freeze(journal, preflight, recovery, ownership_review, *, inspect,
           load_setup=configuration.load, sanitize=reset_accounting.sanitize):
    """Freeze the complete preservation gate, safely retrying private artifacts."""
    journal.assert_current()
    if (journal.value is None or len(journal.value['steps']) not in (3, 4) or
            [row['step'] for row in journal.value['steps'][:3]] != list(reset_protocol.STEPS[:3]) or
            len(journal.value['steps']) == 4 and journal.value['steps'][3]['step'] != 'preservation_frozen'):
        raise ValueError('reset_preservation_phase_required')
    if reset_quiescence.hashlib_preflight(preflight) != journal.value['preflight_sha256']:
        raise ValueError('reset_preflight_changed')

    def held():
        journal.assert_current(); recovery.assert_maintenance()
        reset_quiescence.verify_quiescent(journal, preflight, inspect())

    held()
    reviewed = reset_ownership.validate(preflight, ownership_review)
    ownership = {'format': reset_ownership.FORMAT, 'reset_id': journal.value['reset_id'],
                 'review_sha256': reviewed['review_sha256'], 'review': ownership_review}
    _immutable(journal.directory / 'ownership.json', ownership)
    config_receipt = _configuration(journal, preflight, recovery, inspect)
    values = load_setup(journal.state)
    if (hashlib.sha256(reset_protocol.canonical(values)).hexdigest() !=
            preflight['installation']['configuration_sha256'] or
            values['NOCHEH_STORAGE_LAYOUT'] != preflight['installation']['storage_layout']):
        raise ValueError('reset_setup_configuration_changed')
    policy = _policy(values, config_receipt['snapshot'])
    held(); preferences = _preference_receipt(journal, preflight, policy, config_receipt)
    # Establish that credentials, login state, ledgers and the unsanitized
    # accounting database still match the reviewed inventory before the one
    # permitted preservation mutation begins. On retry, the immutable accounting
    # receipt authorizes only the already-sanitized SQLite companions to differ.
    accounting_targets = [row for row in preflight['paths'] if row['action'] == 'sanitize_accounting' and row['exists']]
    accounting_identity = accounting_targets[0]['path'] if accounting_targets else None
    held(); _snapshot_preserved(preflight, reviewed, accounting_identity)
    held(); accounting, accounting_path = _accounting_receipt(journal, preflight, reviewed, sanitize)
    held()

    preserved = _snapshot_preserved(preflight, reviewed, accounting_path)
    _immutable(journal.directory / 'preserved.json', preserved)
    protected = [journal.state / relative for relative in reset_quiescence.FENCES]
    rebound = _post_shutdown_rebound(journal, preflight)
    file_manifest = reset_files.freeze(preflight, protected, ownership_review, rebound=rebound)
    files_receipt = {'format': 'nocheh-reset-files-receipt-v1', 'reset_id': journal.value['reset_id'],
                     'preflight_sha256': journal.value['preflight_sha256'],
                     'ownership_sha256': reviewed['review_sha256'],
                     'manifest_sha256': reset_protocol.fingerprint(file_manifest), 'manifest': file_manifest}
    files_receipt = _frozen_files(journal, preflight, inspect, files_receipt)

    held()
    if reset_ownership.validate(preflight, ownership_review) != reviewed:
        raise ValueError('reset_ownership_review_changed')
    if reset_configuration.snapshot(recovery.query, config_receipt['snapshot']['layout']) != config_receipt['snapshot']:
        raise ValueError('reset_configuration_changed')
    preference_transfer.verify_source(journal.state / 'hermes', preferences['snapshot'])
    if _snapshot_preserved(preflight, reviewed, accounting_path) != preserved:
        raise ValueError('reset_preserved_files_changed')
    latest_manifest = reset_files.freeze(preflight, protected, ownership_review,
                                         rebound=_post_shutdown_rebound(journal, preflight))
    if _frozen_files(journal, preflight, inspect,
                     {**files_receipt, 'manifest': latest_manifest,
                      'manifest_sha256': reset_protocol.fingerprint(latest_manifest)}) != files_receipt:
        raise ValueError('reset_file_manifest_changed')
    held()

    counts = {'configuration_records': sum(len(rows) for rows in config_receipt['snapshot']['configuration'].values()),
              'preference_profiles': len(preferences['snapshot']['profiles']),
              'preserved_roots': preserved['roots'], 'preserved_entries': preserved['files'],
              'reviewed_items': reviewed['items'], 'erasure_targets': len(file_manifest['targets'])}
    receipt = {'format': FORMAT, 'reset_id': journal.value['reset_id'],
               'preflight_sha256': journal.value['preflight_sha256'],
               'configuration_sha256': config_receipt['snapshot_sha256'],
               'preferences_sha256': preferences['snapshot_sha256'],
               'accounting_sha256': reset_protocol.fingerprint(accounting),
               'preserved_sha256': preserved['sha256'], 'ownership_sha256': reviewed['review_sha256'],
               'file_manifest_sha256': files_receipt['manifest_sha256'], 'counts': counts,
               'accounting_preserved': accounting['accounting_preserved'],
               'content_backup_created': False, 'source_content_copied': False}
    path = journal.directory / 'preservation.json'
    _immutable(path, receipt)
    evidence = reset_protocol.fingerprint(receipt)
    if len(journal.value['steps']) == 4 and journal.value['steps'][3]['evidence_sha256'] != evidence:
        raise ValueError('reset_preservation_evidence_changed')
    journal.complete('preservation_frozen', evidence)
    held()
    return _public(receipt)
