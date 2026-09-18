"""Exact ownership review for restore and external archive reset candidates.

This module prepares a private review document.  A human or installation-specific
reviewer must assign every immediate item either to this installation or to an
unrelated owner.  Directory names and shared provider identities are never reset
authority.  The validated result is consumed only by the preservation coordinator.
"""
import os
import stat
from pathlib import Path

from . import reset_protocol, reset_quiescence

FORMAT = 'nocheh-reset-ownership-review-v1'
VALIDATED = 'nocheh-reset-reviewed-paths-v1'
DISPOSITIONS = frozenset(('erase-installation-owned', 'preserve-unrelated'))
MAX_ITEMS = 10000


def _absolute(value):
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or str(path) != value or path == Path('/'):
        raise ValueError('reset_review_path_invalid')
    return path


def _metadata(path):
    return _metadata_value(path.lstat())


def _metadata_value(value):
    kind = ('directory' if stat.S_ISDIR(value.st_mode) else
            'file' if stat.S_ISREG(value.st_mode) else
            'symlink' if stat.S_ISLNK(value.st_mode) else None)
    if kind is None or kind == 'file' and value.st_nlink != 1:
        raise ValueError('reset_review_type_requires_review')
    return {'device': value.st_dev, 'inode': value.st_ino, 'kind': kind}


def _root_rows(preflight):
    rows = [row for row in preflight.get('paths', []) if row.get('action') == 'review_restore']
    rows.extend(preflight.get('external_archives', []))
    if any(row.get('action') not in ('review_restore', 'review_archive') for row in rows):
        raise ValueError('reset_review_inventory_invalid')
    paths = [row.get('path') for row in rows]
    if len(paths) != len(set(paths)) or len(paths) > MAX_ITEMS:
        raise ValueError('reset_review_inventory_invalid')
    return sorted(rows, key=lambda row: row['path'])


def prepare(preflight):
    """Create the exact private item list whose dispositions must be supplied."""
    roots = []
    count = 0
    for row in _root_rows(preflight):
        path = _absolute(row['path'])
        present = path.exists() or path.is_symlink()
        if present != row.get('exists'):
            raise ValueError('reset_review_identity_changed')
        root = {'path': str(path), 'action': row['action'], 'exists': present, 'entries': []}
        if present:
            observed = _metadata(path)
            if any(observed[key] != row.get(key) for key in ('device', 'inode', 'kind')):
                raise ValueError('reset_review_identity_changed')
            root.update(observed)
            if observed['kind'] == 'directory':
                descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    if _metadata_value(os.fstat(descriptor)) != observed:
                        raise ValueError('reset_review_identity_changed')
                    candidates = [(path / name, _metadata_value(os.stat(name, dir_fd=descriptor, follow_symlinks=False)))
                                  for name in sorted(os.listdir(descriptor))]
                finally:
                    os.close(descriptor)
            else:
                candidates = [(path, observed)]
            for candidate, metadata in candidates:
                count += 1
                if count > MAX_ITEMS:
                    raise ValueError('reset_review_item_limit')
                root['entries'].append({'path': str(candidate), **metadata, 'disposition': None})
        roots.append(root)
    return {'format': FORMAT, 'preflight_sha256': reset_quiescence.hashlib_preflight(preflight),
            'roots': roots, 'content_copied': False}


def validate(preflight, review):
    """Bind every decision to a still-current item and return scoped file rows."""
    if (not isinstance(review, dict) or set(review) != {
            'format', 'preflight_sha256', 'roots', 'content_copied'} or
            review.get('format') != FORMAT or review.get('content_copied') is not False or
            review.get('preflight_sha256') != reset_quiescence.hashlib_preflight(preflight)):
        raise ValueError('reset_ownership_review_invalid')
    current = prepare(preflight)
    if not isinstance(review.get('roots'), list) or len(review['roots']) != len(current['roots']):
        raise ValueError('reset_ownership_review_incomplete')
    erase, preserve = [], []
    for expected, supplied in zip(current['roots'], review['roots']):
        if not isinstance(supplied, dict) or set(supplied) != set(expected):
            raise ValueError('reset_ownership_review_invalid')
        if ({key: supplied[key] for key in supplied if key != 'entries'} !=
                {key: expected[key] for key in expected if key != 'entries'}):
            raise ValueError('reset_review_identity_changed')
        if not isinstance(supplied.get('entries'), list) or len(supplied['entries']) != len(expected['entries']):
            raise ValueError('reset_ownership_review_incomplete')
        for actual, candidate in zip(supplied['entries'], expected['entries']):
            if not isinstance(actual, dict) or set(actual) != set(candidate):
                raise ValueError('reset_ownership_review_invalid')
            disposition = actual['disposition']
            actual = {key: value for key, value in actual.items() if key != 'disposition'}
            candidate = dict(candidate); candidate.pop('disposition')
            if actual != candidate:
                raise ValueError('reset_review_identity_changed')
            if disposition not in DISPOSITIONS:
                raise ValueError('reset_ownership_review_incomplete')
            target = {'path': candidate['path'], 'exists': True,
                      'device': candidate['device'], 'inode': candidate['inode'], 'kind': candidate['kind'],
                      'action': 'erase' if disposition == 'erase-installation-owned' else 'preserve',
                      'reason': 'reviewed_installation_owned' if disposition == 'erase-installation-owned' else 'reviewed_unrelated'}
            (erase if disposition == 'erase-installation-owned' else preserve).append(target)
    digest = reset_protocol.fingerprint(review)
    roots = [row['path'] for row in current['roots']]
    return {'format': VALIDATED, 'preflight_sha256': review['preflight_sha256'],
            'review_sha256': digest, 'roots': roots, 'erase': erase, 'preserve': preserve,
            'items': len(erase) + len(preserve), 'content_copied': False}
