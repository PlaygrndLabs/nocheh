"""Encrypted off-site copies of finished backups (ADR-0229, ADR-0236).

A copy is the backup folder as one tar stream, encrypted on this machine with a key derived from the
owner's passphrase, then uploaded to S3-compatible storage such as Cloudflare R2. The storage only
ever holds ciphertext; without the passphrase a copy cannot be read, including by us."""
import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import shutil
import struct
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree

RECORD = 'admin/offsite.json'
# Each workspace other than personal keeps its copies in its own folder under PREFIX (ADR-0245); personal keeps
# PREFIX itself. A listing reads one folder level only, so workspaces that share a bucket never list, prune or
# fetch each other's copies.
PREFIX = 'nocheh-backups/'
# A storage lock (ADR-0236) refuses to delete or replace a young copy.
LOCKED = 'offsite_storage_ObjectLockedByBucketPolicy'
SUFFIX = '.nocheh-backup'
MAGIC = b'NOCHEH-OFFSITE-1\n'
CHUNK = 4 * 1024 * 1024
PART = 16 * 1024 * 1024
# scrypt costs about 32 MiB of memory and well under a second; the salt is new for every copy.
KDF = {'name': 'scrypt', 'n': 2 ** 15, 'r': 8, 'p': 1}
MINIMUM_PASSPHRASE = 16
EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()


class OffsiteError(ValueError):
    pass


PROVIDERS = ('cloudflare', 'backblaze', 'other')


def folder(values):
    from tools.operations.installation.workspaces import DEFAULT, name_of
    name = name_of(values)
    return PREFIX if name == DEFAULT else PREFIX + name + '/'


def settings(values):
    return {'enabled': values.get('NOCHEH_OFFSITE', 'off') == 's3', 'folder': folder(values),
            'provider': values.get('NOCHEH_OFFSITE_PROVIDER', '') or 'cloudflare',
            'endpoint': values.get('NOCHEH_OFFSITE_ENDPOINT', '').rstrip('/'),
            'bucket': values.get('NOCHEH_OFFSITE_BUCKET', ''),
            'region': values.get('NOCHEH_OFFSITE_REGION', '') or 'auto',
            'access_key': values.get('NOCHEH_OFFSITE_ACCESS_KEY_ID', ''),
            'secret_key': values.get('NOCHEH_OFFSITE_SECRET_ACCESS_KEY', ''),
            'passphrase': values.get('NOCHEH_OFFSITE_PASSPHRASE', ''),
            'keep': int(values.get('NOCHEH_OFFSITE_KEEP', '14') or '14')}


def validate(values):
    mode = values.get('NOCHEH_OFFSITE', 'off')
    if mode not in ('off', 's3'): raise ValueError('NOCHEH_OFFSITE must be off or s3')
    if values.get('NOCHEH_OFFSITE_PROVIDER', 'cloudflare') not in PROVIDERS: raise ValueError('NOCHEH_OFFSITE_PROVIDER must be cloudflare, backblaze or other')
    keep = str(values.get('NOCHEH_OFFSITE_KEEP', '14'))
    if not re.fullmatch(r'[1-9]\d{0,2}', keep) or int(keep) > 365: raise ValueError('NOCHEH_OFFSITE_KEEP must be 1-365')
    endpoint = str(values.get('NOCHEH_OFFSITE_ENDPOINT', ''))
    if endpoint:
        parsed = urllib.parse.urlsplit(endpoint)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment \
                or parsed.path.strip('/'):
            raise ValueError('NOCHEH_OFFSITE_ENDPOINT must be an https address such as https://<account>.r2.cloudflarestorage.com')
    bucket = str(values.get('NOCHEH_OFFSITE_BUCKET', ''))
    if bucket and not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', bucket): raise ValueError('NOCHEH_OFFSITE_BUCKET must be a bucket name such as nocheh-backups')
    region = str(values.get('NOCHEH_OFFSITE_REGION', ''))
    if region and not re.fullmatch(r'[a-z0-9-]{1,32}', region): raise ValueError('NOCHEH_OFFSITE_REGION must be a region such as auto or eu-central-1')
    passphrase = str(values.get('NOCHEH_OFFSITE_PASSPHRASE', ''))
    if passphrase and len(passphrase) < MINIMUM_PASSPHRASE: raise ValueError(f'NOCHEH_OFFSITE_PASSPHRASE must be at least {MINIMUM_PASSPHRASE} characters')
    # Settings files read quotes and backslashes differently; refuse them rather than save a passphrase that reads back changed.
    if any(c in passphrase for c in '\'"\\'): raise ValueError('NOCHEH_OFFSITE_PASSPHRASE cannot contain quotes or backslashes')
    if mode == 's3':
        missing = [key for key in ('NOCHEH_OFFSITE_ENDPOINT', 'NOCHEH_OFFSITE_BUCKET', 'NOCHEH_OFFSITE_ACCESS_KEY_ID',
                                   'NOCHEH_OFFSITE_SECRET_ACCESS_KEY', 'NOCHEH_OFFSITE_PASSPHRASE') if not values.get(key)]
        if missing: raise ValueError('Off-site copies need ' + ', '.join(missing))


# ---- encryption: chunked AES-256-GCM, each chunk bound to its position and to the last-chunk flag ----

def _key(passphrase, kdf):
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    if kdf.get('name') != 'scrypt' or type(kdf.get('n')) is not int or kdf['n'] != KDF['n'] or kdf.get('r') != 8 or kdf.get('p') != 1:
        raise OffsiteError('offsite_unsupported_format')
    salt = base64.b64decode(kdf['salt'])
    if len(salt) != 16: raise OffsiteError('offsite_unsupported_format')
    return Scrypt(salt=salt, length=32, n=kdf['n'], r=kdf['r'], p=kdf['p']).derive(passphrase.encode())


def _nonce(prefix, index):
    return prefix + struct.pack('>I', index)


def _aad(header_line, index, final):
    return header_line + struct.pack('>IB', index, 1 if final else 0)


class EncryptingWriter(io.RawIOBase):
    """A write-only stream that encrypts what it gets in fixed-size chunks."""

    def __init__(self, out, passphrase):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        self.closed_stream = True
        if len(passphrase) < MINIMUM_PASSPHRASE: raise OffsiteError('offsite_passphrase_too_short')
        self.out, self.buffer, self.index = out, bytearray(), 0
        header = {'kdf': {**KDF, 'salt': base64.b64encode(secrets.token_bytes(16)).decode()}, 'cipher': 'aes-256-gcm', 'chunk': CHUNK,
                  'nonce_prefix': base64.b64encode(secrets.token_bytes(8)).decode()}
        self.header_line = json.dumps(header, sort_keys=True, separators=(',', ':')).encode() + b'\n'
        self.prefix = base64.b64decode(header['nonce_prefix'])
        self.aead = AESGCM(_key(passphrase, header['kdf']))
        out.write(MAGIC + self.header_line); self.closed_stream = False

    def writable(self):
        return True

    def write(self, data):
        self.buffer.extend(data)
        while len(self.buffer) > CHUNK:
            self._emit(bytes(self.buffer[:CHUNK]), False); del self.buffer[:CHUNK]
        return len(data)

    def _emit(self, plain, final):
        sealed = self.aead.encrypt(_nonce(self.prefix, self.index), plain, _aad(self.header_line, self.index, final))
        self.out.write(struct.pack('>IB', len(sealed), 1 if final else 0) + sealed); self.index += 1
        if self.index >= 2 ** 32 - 1: raise OffsiteError('offsite_copy_too_large')

    def close(self):
        if not self.closed_stream:
            self.closed_stream = True; self._emit(bytes(self.buffer), True); self.buffer.clear()
        super().close()


class DecryptingReader(io.RawIOBase):
    """A read-only stream over an encrypted copy. Any change, reordering or cut-off raises."""

    def __init__(self, source, passphrase):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        if source.read(len(MAGIC)) != MAGIC: raise OffsiteError('offsite_not_a_copy')
        self.header_line = source.readline(4096)
        try:
            header = json.loads(self.header_line)
            if header.get('cipher') != 'aes-256-gcm' or header.get('chunk') != CHUNK: raise ValueError
            self.prefix = base64.b64decode(header['nonce_prefix'])
            key = _key(passphrase, header['kdf'])
        except OffsiteError: raise
        except Exception: raise OffsiteError('offsite_unsupported_format') from None
        if len(self.prefix) != 8: raise OffsiteError('offsite_unsupported_format')
        self.source, self.aead, self.index, self.pending, self.done = source, AESGCM(key), 0, b'', False

    def readable(self):
        return True

    def _next(self):
        from cryptography.exceptions import InvalidTag
        head = self.source.read(5)
        if len(head) != 5: raise OffsiteError('offsite_copy_truncated')
        size, final = struct.unpack('>IB', head)
        if size < 16 or size > CHUNK + 16 or final not in (0, 1): raise OffsiteError('offsite_copy_damaged')
        sealed = self.source.read(size)
        if len(sealed) != size: raise OffsiteError('offsite_copy_truncated')
        try: plain = self.aead.decrypt(_nonce(self.prefix, self.index), sealed, _aad(self.header_line, self.index, bool(final)))
        except InvalidTag: raise OffsiteError('offsite_wrong_passphrase_or_damaged') from None
        self.index += 1
        if final:
            self.done = True
            if self.source.read(1): raise OffsiteError('offsite_copy_damaged')
        return plain

    def readinto(self, target):
        while not self.pending and not self.done: self.pending = self._next()
        count = min(len(target), len(self.pending)); target[:count] = self.pending[:count]; self.pending = self.pending[count:]
        return count


def encrypt_backup(snapshot, out_path, passphrase):
    """Writes the backup folder as one encrypted tar stream; returns the copy's size in bytes."""
    snapshot = Path(snapshot)
    with open(out_path, 'xb') as out:
        writer = EncryptingWriter(out, passphrase)
        with io.BufferedWriter(writer, buffer_size=CHUNK) as buffered:
            with tarfile.open(fileobj=buffered, mode='w|', format=tarfile.PAX_FORMAT) as tar:
                for path in sorted(snapshot.rglob('*')):
                    if path.is_symlink() or not path.is_file(): continue
                    tar.add(path, arcname='backup/' + path.relative_to(snapshot).as_posix(), recursive=False)
        out.flush(); os.fsync(out.fileno())
    Path(out_path).chmod(0o600)
    return Path(out_path).stat().st_size


def decrypt_backup(copy_path, output, passphrase):
    """Restores a backup folder from an encrypted copy and checks every checksum in its manifest."""
    output = Path(output)
    if output.exists(): raise OffsiteError('offsite_output_exists')
    staging = Path(tempfile.mkdtemp(prefix='.offsite-', dir=output.parent))
    try:
        with open(copy_path, 'rb') as source:
            reader = DecryptingReader(source, passphrase)
            with io.BufferedReader(reader, buffer_size=CHUNK) as buffered, tarfile.open(fileobj=buffered, mode='r|') as tar:
                for member in tar:
                    parts = Path(member.name).parts
                    if not member.isfile() or len(parts) < 2 or parts[0] != 'backup' or '..' in parts or member.name.startswith('/'):
                        raise OffsiteError('offsite_unsafe_member')
                    target = staging.joinpath(*parts[1:]); target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    with tar.extractfile(member) as file, open(target, 'xb') as out: shutil.copyfileobj(file, out, CHUNK)
                    target.chmod(0o600)
                # The tar end blocks are zero padding; anything else after them means the copy was changed.
                for rest in iter(lambda: buffered.read(CHUNK), b''):
                    if rest.strip(b'\0'): raise OffsiteError('offsite_copy_damaged')
        from tools.operations.installation.operations import validate_snapshot
        try: manifest = validate_snapshot(staging)
        except (ValueError, KeyError, OSError) as error: raise OffsiteError('offsite_backup_invalid') from error
        staging.rename(output)
        return manifest
    finally:
        if staging.exists(): shutil.rmtree(staging, ignore_errors=True)


# ---- S3-compatible storage, signed with AWS Signature Version 4 ----

def _quote(value, safe='-_.~'):
    return urllib.parse.quote(value, safe=safe)


def signed_headers(method, url, headers, payload_hash, access_key, secret_key, region, now=None):
    """The request headers with an AWS Signature Version 4 Authorization header added."""
    now = now or datetime.now(timezone.utc)
    stamp, day = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname + (f':{parsed.port}' if parsed.port else '')
    values = {**{key.lower(): str(value).strip() for key, value in headers.items()}, 'host': host,
              'x-amz-content-sha256': payload_hash, 'x-amz-date': stamp}
    names = sorted(values)
    query = '&'.join(f'{_quote(k)}={_quote(v)}' for k, v in sorted(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)))
    canonical = '\n'.join([method, _quote(parsed.path or '/', safe='/-_.~'), query, ''.join(f'{name}:{values[name]}\n' for name in names),
                           ';'.join(names), payload_hash])
    scope = f'{day}/{region}/s3/aws4_request'
    to_sign = '\n'.join(['AWS4-HMAC-SHA256', stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ('AWS4' + secret_key).encode()
    for part in (day, region, 's3', 'aws4_request'): key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    values['authorization'] = f'AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={";".join(names)}, Signature={signature}'
    values.pop('host')
    return values


class Storage:
    def __init__(self, config, opener=None):
        self.config, self.opener = config, opener or urllib.request.build_opener()

    def url(self, key='', query=''):
        return self.config['endpoint'] + '/' + _quote(self.config['bucket']) + ('/' + _quote(key, safe='/-_.~') if key else '') + ('?' + query if query else '')

    def request(self, method, key='', query='', body=b'', headers=None, stream=False):
        url = self.url(key, query)
        payload = hashlib.sha256(body).hexdigest() if body else EMPTY_SHA256
        all_headers = signed_headers(method, url, headers or {}, payload, self.config['access_key'], self.config['secret_key'], self.config['region'])
        request = urllib.request.Request(url, data=body if method in ('PUT', 'POST') else None, method=method, headers=all_headers)
        try:
            response = self.opener.open(request, timeout=300)
        except urllib.error.HTTPError as error:
            code = re.search(rb'<Code>([A-Za-z]+)</Code>', error.read(4096) or b'')
            raise OffsiteError('offsite_storage_' + (code.group(1).decode() if code else str(error.code))) from None
        except (urllib.error.URLError, OSError):
            raise OffsiteError('offsite_storage_unreachable') from None
        if stream: return response
        with response: return response.read()

    def put(self, key, path):
        size = Path(path).stat().st_size
        with open(path, 'rb') as file:
            if size <= PART:
                self.request('PUT', key, body=file.read(), headers={'content-type': 'application/octet-stream'}); return
            upload = ElementTree.fromstring(self.request('POST', key, 'uploads=')).findtext('{*}UploadId')
            if not upload: raise OffsiteError('offsite_storage_upload_refused')
            parts = []
            # S3 allows 10,000 parts; larger copies get larger parts instead of being cut short.
            part = max(PART, -(-size // 10000))
            try:
                for number in range(1, 10001):
                    body = file.read(part)
                    if not body: break
                    response = self.request('PUT', key, f'partNumber={number}&uploadId={_quote(upload)}', body=body, stream=True)
                    with response: etag = response.headers.get('ETag'); response.read()
                    if not etag: raise OffsiteError('offsite_storage_upload_refused')
                    parts.append((number, etag))
                if file.read(1): raise OffsiteError('offsite_copy_too_large')
                done = ''.join(f'<Part><PartNumber>{n}</PartNumber><ETag>{e}</ETag></Part>' for n, e in parts)
                answer = self.request('POST', key, f'uploadId={_quote(upload)}', body=f'<CompleteMultipartUpload>{done}</CompleteMultipartUpload>'.encode(),
                                      headers={'content-type': 'application/xml'})
                # S3 can report a failed completion inside an HTTP 200 answer.
                try: root = ElementTree.fromstring(answer)
                except ElementTree.ParseError: raise OffsiteError('offsite_storage_upload_refused') from None
                if root.tag.endswith('Error'): raise OffsiteError('offsite_storage_' + (root.findtext('{*}Code') or root.findtext('Code') or 'upload_refused'))
                if not root.tag.endswith('CompleteMultipartUploadResult'): raise OffsiteError('offsite_storage_upload_refused')
            except BaseException:
                try: self.request('DELETE', key, f'uploadId={_quote(upload)}')
                except OffsiteError: pass
                raise

    def get(self, key, path):
        response = self.request('GET', key, stream=True)
        with response, open(path, 'xb') as out:
            shutil.copyfileobj(response, out, CHUNK); out.flush(); os.fsync(out.fileno())
        Path(path).chmod(0o600)

    def list(self):
        """Every copy in this workspace's folder, oldest first, as {key, size}."""
        found, token, prefix = [], None, self.config.get('folder') or folder({})
        while True:
            query = 'list-type=2&prefix=' + _quote(prefix) + ('&continuation-token=' + _quote(token) if token else '')
            root = ElementTree.fromstring(self.request('GET', query=query))
            for item in root.findall('{*}Contents'):
                key = item.findtext('{*}Key') or ''
                if key.startswith(prefix) and '/' not in key[len(prefix):] and key.endswith(SUFFIX): found.append({'key': key, 'size': int(item.findtext('{*}Size') or 0)})
            if root.findtext('{*}IsTruncated') != 'true': break
            token = root.findtext('{*}NextContinuationToken')
            if not token: break
        return sorted(found, key=lambda item: item['key'])

    def delete(self, key):
        self.request('DELETE', key)


# ---- the record the dashboard reads, and the two operations ----

def _now():
    return datetime.now(timezone.utc)


def read_record(state):
    try:
        record = json.loads((Path(state) / RECORD).read_text())
        if isinstance(record, dict) and isinstance(record.get('sent'), dict): return record
    except (OSError, ValueError): pass
    return {'sent': {}, 'attempted': []}


def write_record(state, record):
    path = Path(state) / RECORD; path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as file:
        json.dump(record, file); file.flush(); os.fsync(file.fileno()); temporary = Path(file.name)
    temporary.chmod(0o600); temporary.replace(path)


def _finished(state):
    """Finished local backups, newest first, as (id, created_at, path)."""
    from tools.operations.installation.admin_operations import backups
    root = Path(state) / 'admin/backups'
    rows = sorted(backups(Path(state)), key=lambda row: row['created_at'], reverse=True)
    return [(row['id'], row['created_at'], root / row['id']) for row in rows]


def _room(state, needed):
    """The encrypted copy is written next to the data first; leave the same margin automatic backups keep."""
    from tools.operations.installation.backup_schedule import MINIMUM_FREE
    return shutil.disk_usage(Path(state) / 'admin').free >= needed + MINIMUM_FREE


def _size(path):
    return sum(file.stat().st_size for file in Path(path).rglob('*') if file.is_file() and not file.is_symlink())


def object_key(backup, created_at, prefix=None):
    moment = re.sub(r'[^0-9]', '', created_at)[:14]
    return f'{prefix or folder({})}{moment}-{backup}{SUFFIX}'


def due(state, values):
    """A copy is due when off-site copies are on and the newest finished backup has not been tried yet.
    Each backup is tried once by the schedule, so a failure never retries in a loop; Send copy now retries."""
    if not settings(values)['enabled']: return {'due': False}
    finished = _finished(state)
    if not finished: return {'due': False}
    record = read_record(state)
    if finished[0][0] in record['sent'] or finished[0][0] in record.get('attempted', []): return {'due': False}
    if not _room(state, _size(finished[0][2])): return {'due': False, 'skipped': 'low_disk'}
    return {'due': True}


def send(state, values, opener=None):
    """Encrypts the newest finished backup, uploads it, then removes copies beyond the number to keep."""
    config = settings(values)
    if not config['enabled']: raise OffsiteError('offsite_not_configured')
    finished = _finished(state)
    if not finished: raise OffsiteError('offsite_no_backup')
    backup, created_at, path = finished[0]
    if not _room(state, _size(path)): raise OffsiteError('offsite_low_disk')
    record = read_record(state); record['attempted'] = (record.get('attempted', []) + [backup])[-50:]
    record['last'] = {'state': 'running', 'at': _now().isoformat(), 'backup': backup}; write_record(state, record)
    work = Path(state) / 'admin/offsite-work'; work.mkdir(parents=True, exist_ok=True, mode=0o700)
    copy = work / (backup + SUFFIX); key = object_key(backup, created_at, config['folder'])
    try:
        if copy.exists(): copy.unlink()
        size = encrypt_backup(path, copy, config['passphrase'])
        storage = Storage(config, opener)
        try: storage.put(key, copy)
        except OffsiteError as error:
            # This backup was sent before and its copy is still locked: that copy stays and counts as sent.
            if str(error) != LOCKED: raise
            size = next((item['size'] for item in storage.list() if item['key'] == key), None)
            if size is None: raise
        removed, locked, prune_error = 0, 0, None
        try:
            copies = storage.list()
            for item in copies[:max(0, len(copies) - config['keep'])]:
                # A storage lock (ADR-0236) keeps young copies; they are removed by a later copy once it ends.
                try: storage.delete(item['key']); removed += 1
                except OffsiteError as error:
                    if str(error) != LOCKED: raise
                    locked += 1
        except OffsiteError as error: prune_error = str(error)
        record = read_record(state)
        record['sent'][backup] = {'key': key, 'at': _now().isoformat(), 'bytes': size}
        record['sent'] = dict(sorted(record['sent'].items(), key=lambda item: item[1]['at'])[-100:])
        extra = {**({'locked': locked} if locked else {}), **({'prune_error': prune_error} if prune_error else {})}
        record['last'] = {'state': 'sent', 'at': _now().isoformat(), 'backup': backup, 'key': key, 'bytes': size, 'removed': removed, **extra}
        write_record(state, record)
        return {'status': 'offsite_sent', 'backup': backup, 'key': key, 'bytes': size, 'removed': removed, **extra}
    except Exception as error:
        record = read_record(state)
        record['last'] = {'state': 'failed', 'at': _now().isoformat(), 'backup': backup, 'error': _code(error)}
        write_record(state, record); raise
    finally:
        if copy.exists(): copy.unlink()


def check(state, values, opener=None):
    """The restore test: downloads the newest copy, decrypts it and checks every checksum, then deletes it."""
    config = settings(values)
    if not config['enabled']: raise OffsiteError('offsite_not_configured')
    work = Path(state) / 'admin/offsite-work'; work.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = work / 'check'; copy = work / ('check' + SUFFIX); key = None
    try:
        for leftover in (copy, target):
            if leftover.is_dir(): shutil.rmtree(leftover)
            elif leftover.exists(): leftover.unlink()
        storage = Storage(config, opener); copies = storage.list()
        if not copies: raise OffsiteError('offsite_no_copy')
        # The download and the opened backup both sit on this disk until the test ends.
        if not _room(state, 2 * int(copies[-1].get('size') or 0)): raise OffsiteError('offsite_low_disk')
        key = copies[-1]['key']; storage.get(key, copy)
        manifest = decrypt_backup(copy, target, config['passphrase'])
        result = {'state': 'passed', 'at': _now().isoformat(), 'key': key, 'created_at': manifest.get('created_at'), 'copies': len(copies)}
        record = read_record(state); record['check'] = result; write_record(state, record)
        return {'status': 'offsite_checked', **result}
    except Exception as error:
        record = read_record(state); record['check'] = {'state': 'failed', 'at': _now().isoformat(), 'key': key, 'error': _code(error)}
        write_record(state, record); raise
    finally:
        if copy.exists(): copy.unlink()
        if target.exists(): shutil.rmtree(target, ignore_errors=True)


def _code(error):
    text = str(error)
    return text if re.fullmatch(r'offsite_[A-Za-z0-9_]{1,60}', text) else 'offsite_failed'


def status(state, values):
    config = settings(values); record = read_record(state)
    return {'enabled': config['enabled'], 'provider': config['provider'], 'keep': config['keep'], 'bucket': config['bucket'] or None,
            'last': record.get('last'), 'check': record.get('check'),
            # The newest copy that did reach the storage, for when the latest attempt is running or failed.
            'last_sent': max(record['sent'].values(), key=lambda entry: entry['at'], default=None),
            'sent': [entry['key'] for entry in record['sent'].values()][-config['keep']:]}


def main(state, rest):
    """`nocheh offsite list|fetch|decrypt`: get a backup back from an off-site copy, for example on a new
    machine. Storage settings come from this installation, or from NOCHEH_OFFSITE_* variables when there is
    none; the passphrase is asked for when NOCHEH_OFFSITE_PASSPHRASE is not set. Then run `nocheh restore`."""
    import argparse, getpass, sys
    parser = argparse.ArgumentParser(prog='nocheh offsite', description=main.__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    listing = sub.add_parser('list', help='List the copies in the bucket')
    fetch = sub.add_parser('fetch', help='Download a copy and turn it back into a backup folder')
    fetch.add_argument('--key', help='Which copy (default: the newest)'); fetch.add_argument('--output', type=Path, required=True)
    for command in (listing, fetch):
        command.add_argument('--workspace', help="Whose copies (default: this folder's workspace, or personal)")
    decrypt = sub.add_parser('decrypt', help='Turn a downloaded copy back into a backup folder')
    decrypt.add_argument('copy', type=Path); decrypt.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(rest)
    try: import cryptography  # noqa: F401  (opening a copy needs it; check before any download)
    except ImportError:
        print(json.dumps({'status': 'failed', 'error': 'offsite_needs_cryptography',
                          'hint': 'Install the Python cryptography package (for example: pip install cryptography), then run this again.'}))
        return 1
    from tools.operations.installation.configuration import load, env_path
    saved = load(state) if env_path(state).exists() else {}
    values = {**saved, **{key: value for key, value in os.environ.items() if key.startswith('NOCHEH_OFFSITE')}}
    values['NOCHEH_OFFSITE'] = 's3'
    if getattr(args, 'workspace', None):
        from tools.operations.installation.workspaces import check_name
        values['NOCHEH_WORKSPACE'] = check_name(args.workspace)
    passphrase = lambda: values.get('NOCHEH_OFFSITE_PASSPHRASE') or getpass.getpass('Off-site passphrase: ')
    try:
        if args.action == 'decrypt':
            result = decrypt_backup(args.copy, args.output.resolve(), passphrase())
            print(json.dumps({'status': 'decrypted', 'output': str(args.output.resolve()), 'created_at': result.get('created_at')})); return 0
        config = settings(values)
        for key in ('endpoint', 'bucket', 'access_key', 'secret_key'):
            if not config[key]: parser.error('missing off-site setting: ' + key)
        storage = Storage(config)
        if args.action == 'list':
            print(json.dumps(storage.list(), indent=2)); return 0
        output = args.output.resolve(); copies = storage.list()
        key = args.key or (copies[-1]['key'] if copies else None)
        if not key: raise OffsiteError('offsite_no_copy')
        with tempfile.TemporaryDirectory(dir=output.parent) as work:
            copy = Path(work) / 'copy'; storage.get(key, copy)
            result = decrypt_backup(copy, output, passphrase())
        print(json.dumps({'status': 'fetched', 'key': key, 'output': str(output), 'created_at': result.get('created_at')})); return 0
    except OffsiteError as error:
        print(json.dumps({'error': str(error)}), file=sys.stderr); return 1
