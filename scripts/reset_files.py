"""Anchored file erasure for the reset coordinator, with no standalone command.

Freeze after writers stop and preservation succeeds. The coordinator must bind
the manifest into its durable preservation evidence and supply a barrier that
rechecks journal, maintenance, owner exclusion, preservation and inactive fences.
No source bytes are read or copied. Database/container erasure is separate.
"""
import os
import stat
from contextlib import contextmanager
from pathlib import Path

FORMAT = 'nocheh-reset-file-manifest-v1'
MAX_ENTRIES = 100000
FIELDS = ('device', 'inode', 'kind')


def metadata(value):
    kind = ('directory' if stat.S_ISDIR(value.st_mode) else
            'file' if stat.S_ISREG(value.st_mode) else
            'symlink' if stat.S_ISLNK(value.st_mode) else None)
    if kind is None or kind == 'file' and value.st_nlink != 1:
        raise ValueError('reset_file_type_requires_review')
    return {'device': value.st_dev, 'inode': value.st_ino, 'kind': kind,
            'size': value.st_size, 'mtime_ns': value.st_mtime_ns,
            'ctime_ns': value.st_ctime_ns}


def same(actual, expected):
    keys = FIELDS if expected['kind'] == 'directory' else expected.keys()
    if any(actual.get(key) != expected[key] for key in keys):
        raise ValueError('reset_file_identity_changed')


def absolute(value):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or str(path) != value or path == Path('/'):
        raise ValueError('reset_file_path_invalid')
    return path


@contextmanager
def parent(path, expected=None):
    """Walk every ancestor by descriptor; never resolve a symlink during erase."""
    path = absolute(str(path))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    identities = []
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
            value = os.fstat(fd); identities.append([value.st_dev, value.st_ino])
        if expected is not None and identities != expected:
            raise ValueError('reset_file_ancestor_changed')
        yield fd, path.name, identities
    finally:
        os.close(fd)


def inspect_at(fd, name):
    try:
        return metadata(os.stat(name, dir_fd=fd, follow_symlinks=False))
    except FileNotFoundError:
        return None


def freeze(preflight, protected):
    """Return only metadata for reviewed installation-local content targets.

    External backups/restores require separate per-item ownership review; this
    primitive intentionally cannot accept a directory name as that authority.
    ``protected`` includes the reset's inactive markers and their ancestors.
    """
    if preflight.get('blockers'):
        raise ValueError('reset_file_inventory_blocked')
    installation = preflight['installation']
    roots = [absolute(installation[key]) for key in ('state', 'memory_state')]
    protected = [absolute(str(path)) for path in protected]
    selected = [row for row in preflight['paths']
                if row['action'] in ('erase', 'snapshot_preferences_then_erase')]
    retained = [absolute(row['path']) for row in preflight['paths']
                if row['action'] not in ('erase', 'snapshot_preferences_then_erase')]
    planned = []
    count = 0

    def scan(fd, name, path):
        nonlocal count
        count += 1
        if count > MAX_ENTRIES:
            raise ValueError('reset_file_inventory_limit')
        observed = inspect_at(fd, name)
        if observed is None:
            raise ValueError('reset_file_identity_changed')
        keep = any(path.is_relative_to(item) or path in item.parents for item in protected)
        record = {'name': name, 'metadata': observed, 'keep': keep}
        if observed['kind'] == 'directory':
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                same(metadata(os.fstat(child)), observed)
                record['children'] = [scan(child, item, path / item) for item in sorted(os.listdir(child))]
            finally:
                os.close(child)
        return record

    for row in selected:
        path = absolute(row['path'])
        if (not any(path.is_relative_to(root) and path != root for root in roots) or
                any(path == keep or path in keep.parents or keep in path.parents for keep in retained) or
                any(path == absolute(item['path']) or path in absolute(item['path']).parents or
                    absolute(item['path']) in path.parents for item in planned)):
            raise ValueError('reset_file_scope_invalid')
        with parent(path) as (fd, name, ancestors):
            observed = inspect_at(fd, name)
            if row['exists'] != (observed is not None):
                raise ValueError('reset_file_identity_changed')
            if observed is not None:
                same(observed, {key: row[key] for key in FIELDS})
                tree = scan(fd, name, path)
            else:
                tree = None
            planned.append({'path': str(path), 'ancestors': ancestors, 'tree': tree})
    return {'format': FORMAT, 'installation': installation['state'],
            'entries': count, 'targets': planned, 'content_copied': False}


def erase(manifest, assert_barrier):
    """Retry the same frozen manifest; missing entries are already removed.

    All remaining trees are checked before the first unlink. New or replaced
    entries fail closed. Use this only after the coordinator verifies the saved
    manifest hash; a caller-supplied manifest is not reset authorization.
    """
    if manifest.get('format') != FORMAT or manifest.get('content_copied') is not False:
        raise ValueError('reset_file_manifest_invalid')
    removed = 0

    def walk(fd, name, expected, deleting):
        nonlocal removed
        observed = inspect_at(fd, name)
        if observed is None:
            if expected and expected['keep']:
                raise ValueError('reset_file_preservation_missing')
            return
        if expected is None:
            raise ValueError('reset_file_unreviewed_entry')
        same(observed, expected['metadata'])
        if observed['kind'] == 'directory':
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                same(metadata(os.fstat(child)), expected['metadata'])
                children = {row['name']: row for row in expected['children']}
                if any(item not in children for item in os.listdir(child)):
                    raise ValueError('reset_file_unreviewed_entry')
                for item, row in children.items():
                    walk(child, item, row, deleting)
            finally:
                os.close(child)
        if deleting and not expected['keep']:
            assert_barrier()
            same(inspect_at(fd, name) or {}, expected['metadata'])
            if observed['kind'] == 'directory':
                os.rmdir(name, dir_fd=fd)
            else:
                os.unlink(name, dir_fd=fd)
            os.fsync(fd); removed += 1

    assert_barrier()
    for deleting in (False, True):
        for target in manifest['targets']:
            assert_barrier()
            with parent(absolute(target['path']), target['ancestors']) as (fd, name, _):
                walk(fd, name, target['tree'], deleting)
    assert_barrier()
    return {'removed_entries': removed, 'content_copied': False,
            'database_volumes_erased': False, 'inactive_markers_retained': True}
