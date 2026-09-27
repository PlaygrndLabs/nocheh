"""Durable reset progress and the one-attempt Telegram backlog boundary.

Internal coordinator primitives, not a reset command. The caller must verify
each phase and retain its evidence before recording completion. In particular,
this journal cannot turn an inventory into permission to erase installation data.
"""
import fcntl
import hashlib
import http.client
import json
import os
import re
import stat
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

FORMAT = 'nocheh-reset-progress-v1'
STEPS = ('isolated_acceptance', 'quiesced', 'effects_settled', 'preservation_frozen',
         'erased', 'initialized', 'empty_baseline', 'telegram_boundary',
         'fresh_acceptance', 'resumed')
HASH = re.compile(r'[a-f0-9]{64}')
TOKEN = re.compile(r'[1-9][0-9]{0,19}:[A-Za-z0-9_-]{16,256}')
LIMIT = 1024 * 1024


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def fingerprint(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('reset_identifier_invalid')
    return value


def checksum(value):
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise ValueError('reset_evidence_hash_invalid')
    return value


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def regular(fd):
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError('reset_journal_file_invalid')
    return metadata


def read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        if regular(source.fileno()).st_size > LIMIT:
            raise ValueError('reset_journal_size_invalid')
        raw = source.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise ValueError('reset_journal_size_invalid')
        return json.loads(raw)


def atomic(path, value, *, create=False):
    raw = canonical(value) + b'\n'
    if len(raw) > LIMIT:
        raise ValueError('reset_journal_size_invalid')
    if path.exists() or path.is_symlink():
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            regular(fd)
        finally:
            os.close(fd)
    temporary = path.with_name('.' + uuid.uuid4().hex + '.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(raw); output.flush(); os.fsync(output.fileno())
        if create:
            os.link(temporary, path)
            temporary.unlink()
        else:
            os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def validate(value, state):
    if not isinstance(value, dict) or set(value) != {
            'format', 'reset_id', 'state', 'state_identity', 'preflight_sha256',
            'generation', 'created_at', 'steps', 'telegram'}:
        raise ValueError('reset_journal_invalid')
    metadata = state.stat()
    if value['format'] != FORMAT or value['state'] != str(state) or value['state_identity'] != [metadata.st_dev, metadata.st_ino]:
        raise ValueError('reset_installation_changed')
    identifier(value['reset_id']); identifier(value['generation']); checksum(value['preflight_sha256'])
    steps = value['steps']
    if not isinstance(steps, list) or len(steps) > len(STEPS):
        raise ValueError('reset_journal_steps_invalid')
    for index, row in enumerate(steps):
        if not isinstance(row, dict) or set(row) != {'step', 'evidence_sha256', 'completed_at'} or row['step'] != STEPS[index]:
            raise ValueError('reset_journal_steps_invalid')
        checksum(row['evidence_sha256'])
    telegram = value['telegram']
    if telegram is not None:
        if not isinstance(telegram, dict) or set(telegram) not in (
                {'binding', 'state', 'attempted_at'}, {'binding', 'state', 'attempted_at', 'confirmed_at'}):
            raise ValueError('reset_telegram_journal_invalid')
        checksum(telegram['binding'])
        if telegram['state'] not in ('attempting', 'confirmed') or (telegram['state'] == 'confirmed') != ('confirmed_at' in telegram):
            raise ValueError('reset_telegram_journal_invalid')
        if len(steps) < STEPS.index('telegram_boundary'):
            raise ValueError('reset_telegram_journal_invalid')
    if len(steps) > STEPS.index('telegram_boundary'):
        if not telegram or telegram['state'] != 'confirmed' or steps[STEPS.index('telegram_boundary')]['evidence_sha256'] != fingerprint(telegram):
            raise ValueError('reset_telegram_journal_invalid')
    return value


class ResetJournal:
    """Open with ``locked``; one local coordinator owns all journal transitions."""
    def __init__(self, state, directory, lock):
        self.state, self.directory, self.lock = state, directory, lock
        self.path = directory / 'progress.json'
        self.lock_identity = (os.fstat(lock.fileno()).st_dev, os.fstat(lock.fileno()).st_ino)
        self.directory_identity = (directory.stat().st_dev, directory.stat().st_ino)
        self.value = None
        if self.path.exists() or self.path.is_symlink():
            self.value = validate(read(self.path), self.state)

    def assert_current(self):
        if self.lock.closed:
            raise RuntimeError('reset_journal_lock_required')
        metadata = (self.directory / 'coordinator.lock').lstat()
        directory = self.directory.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or
                (metadata.st_dev, metadata.st_ino) != self.lock_identity or
                not stat.S_ISDIR(directory.st_mode) or (directory.st_dev, directory.st_ino) != self.directory_identity):
            raise RuntimeError('reset_journal_identity_changed')
        if self.value is not None and validate(read(self.path), self.state) != self.value:
            raise RuntimeError('reset_journal_changed')

    def create(self, preflight, generation):
        self.assert_current()
        if (not isinstance(preflight, dict) or preflight.get('format') != 'nocheh-reset-preflight-v1' or
                preflight.get('executable') is not False or preflight.get('content_copied') is not False or
                preflight.get('blockers') != [] or preflight.get('installation', {}).get('state') != str(self.state)):
            raise ValueError('reset_preflight_invalid')
        reset_id = identifier(preflight.get('id')); generation = identifier(generation)
        metadata = self.state.stat()
        anchor = preflight['installation'].get('state_anchor', {})
        if (anchor.get('device'), anchor.get('inode'), anchor.get('kind')) != (metadata.st_dev, metadata.st_ino, 'directory'):
            raise ValueError('reset_installation_changed')
        binding = hashlib.sha256(canonical(preflight) + b'\n').hexdigest()
        if self.value is not None:
            if (self.value['reset_id'], self.value['preflight_sha256'], self.value['generation']) != (reset_id, binding, generation):
                raise ValueError('reset_already_in_progress')
            return self.value
        value = {'format': FORMAT, 'reset_id': reset_id, 'state': str(self.state),
                 'state_identity': [metadata.st_dev, metadata.st_ino], 'preflight_sha256': binding,
                 'generation': generation, 'created_at': now(), 'steps': [], 'telegram': None}
        self.save(value)
        return self.value

    def save(self, value):
        self.assert_current()
        validate(value, self.state)
        if self.value is None:
            atomic(self.path, value, create=True)
        else:
            atomic(self.path, value)
        self.value = value

    def complete(self, step, evidence_sha256):
        self.assert_current(); checksum(evidence_sha256)
        if self.value is None or step not in STEPS:
            raise ValueError('reset_phase_invalid')
        position = STEPS.index(step); steps = self.value['steps']
        if position < len(steps):
            if steps[position]['evidence_sha256'] != evidence_sha256:
                raise ValueError('reset_phase_evidence_changed')
            return
        if position != len(steps):
            raise ValueError('reset_phase_out_of_order')
        self.save({**self.value, 'steps': [*steps, {'step': step, 'evidence_sha256': evidence_sha256, 'completed_at': now()}]})

    def telegram_boundary(self, token, assert_quiescent, read_generation, transport=None):
        """Call only after the verified empty baseline, with every poller held.

        A durable attempted request is NEVER retried, including after a failure
        before the socket write. Telegram offers no idempotency key or receipt
        lookup for this method. An uncertain outcome remains a pending live gate.
        """
        self.assert_current()
        if not isinstance(token, str) or not TOKEN.fullmatch(token):
            raise ValueError('reset_telegram_token_invalid')
        if self.value is None or len(self.value['steps']) < STEPS.index('telegram_boundary'):
            raise ValueError('reset_empty_baseline_required')
        binding = fingerprint({'reset_id': self.value['reset_id'], 'generation': self.value['generation'],
                               'credential_sha256': hashlib.sha256(token.encode()).hexdigest()})
        previous = self.value['telegram']
        if previous:
            if previous['binding'] != binding:
                raise ValueError('reset_telegram_binding_changed')
            if previous['state'] != 'confirmed':
                raise RuntimeError('reset_telegram_outcome_uncertain')
        # Validate environmental prerequisites before recording an attempt. Never
        # let a prerequisite failure consume the one permitted transport call.
        marker = self.state / 'spool/.restore-inactive'
        if marker.is_symlink() or not marker.is_file():
            raise ValueError('reset_inactive_fence_required')
        assert_quiescent()
        if read_generation() != self.value['generation']:
            raise ValueError('reset_generation_changed')
        if previous:
            self.complete('telegram_boundary', fingerprint(previous))
            return {'state': 'confirmed', 'reused': True}
        attempt = {'binding': binding, 'state': 'attempting', 'attempted_at': now()}
        self.save({**self.value, 'telegram': attempt})
        # macOS and the Docker VM do not share advisory-lock visibility. The
        # coordinator additionally holds the database maintenance lock, but this
        # exclusive, never-replaced reservation independently prevents a second
        # transport call, even if another kernel read an older progress document.
        reservation = self.directory / ('telegram-' + self.value['reset_id'] + '.attempt')
        try:
            fd = os.open(reservation, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            raise RuntimeError('reset_telegram_outcome_uncertain') from None
        with os.fdopen(fd, 'wb') as output:
            output.write(canonical({'binding': binding})); output.flush(); os.fsync(output.fileno())
        sync_directory(self.directory)
        try:
            confirmed = (transport or delete_telegram_backlog)(token)
            if confirmed is not True:
                raise ValueError()
        except Exception:
            # Do not persist or display provider errors, which may contain the
            # token-bearing URL or untrusted response text. Keep the attempt.
            raise RuntimeError('reset_telegram_outcome_uncertain') from None
        self.save({**self.value, 'telegram': {**attempt, 'state': 'confirmed', 'confirmed_at': now()}})
        # An intervening writer must still block acceptance, but cannot turn a
        # confirmed discard into another attempt on retry.
        assert_quiescent()
        if read_generation() != self.value['generation'] or marker.is_symlink() or not marker.is_file():
            raise ValueError('reset_boundary_environment_changed')
        self.complete('telegram_boundary', fingerprint(self.value['telegram']))
        return {'state': 'confirmed', 'reused': False}


@contextmanager
def locked(state):
    supplied = Path(state)
    if supplied.is_symlink() or not supplied.is_dir():
        raise ValueError('reset_state_invalid')
    state = supplied.resolve()
    directory = state
    for name in ('admin', 'reset'):
        directory = directory / name
        if directory.is_symlink():
            raise ValueError('reset_journal_directory_invalid')
        directory.mkdir(exist_ok=True, mode=0o700)
        sync_directory(directory.parent)
        if not directory.is_dir():
            raise ValueError('reset_journal_directory_invalid')
    fd = os.open(directory / 'coordinator.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, 'r+b') as lock:
        regular(fd)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('reset_coordinator_busy') from None
        yield ResetJournal(state, directory, lock)


def delete_telegram_backlog(token):
    """One HTTPS request, without proxy discovery, redirects, logging or retries."""
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError('reset_telegram_token_invalid')
    connection = http.client.HTTPSConnection('api.telegram.org', timeout=20)
    try:
        connection.request('POST', '/bot' + token + '/deleteWebhook',
                           body=b'{"drop_pending_updates":true}', headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read(8193)
        if response.status != 200 or len(raw) > 8192:
            raise ValueError()
        result = json.loads(raw)
        if not isinstance(result, dict) or result.get('ok') is not True or result.get('result') is not True:
            raise ValueError()
        return True
    except Exception:
        raise RuntimeError('reset_telegram_outcome_uncertain') from None
    finally:
        connection.close()
