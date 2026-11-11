"""Connects off-site copies to the owner's storage from one pasted credential (ADR-0236).

Cloudflare R2: the owner makes one setup token on a Cloudflare page that opens already filled in. Nocheh finds the
account, creates a bucket of its own, locks every copy for LOCK_DAYS, makes a second token that can only read and
write objects in that bucket, tests it, saves its S3 keys and deletes the setup token. Backblaze B2: the owner pastes a
key limited to one bucket, and Nocheh reads the storage address and the bucket from Backblaze.

Neither path sees the passphrase, and no answer or record ever carries a token or key."""
import base64
import hashlib
import json
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from tools.operations.installation.offsite import PREFIX, OffsiteError, Storage

CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'
BACKBLAZE_AUTHORIZE = 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account'
BUCKET = 'nocheh-backups'
# A bucket Nocheh made: the first one, or one with a random ending when another installation took the first name.
OWN_BUCKET = re.compile(r'nocheh-backups(-[0-9a-f]{8})?')
LOCK_RULE = 'nocheh-copies'
LOCK_DAYS = 7
TOKEN_NAME = 'Nocheh off-site copies'
# "Object Read & Write" in Cloudflare's words: objects in the named buckets only, never bucket settings or locks.
OBJECT_GROUPS = ('Workers R2 Storage Bucket Item Write', 'Workers R2 Storage Bucket Item Read')
CHECK_KEY = 'nocheh-check/connect'
# Cloudflare's error codes for a token it does not accept at all.
TOKEN_REFUSED = {1000, 6003, 6111}
R2_OFF = 10042


class CloudflareError(Exception):
    def __init__(self, status, answer):
        errors = answer.get('errors') if isinstance(answer, dict) else None
        self.status = status
        self.codes = {error.get('code') for error in errors or [] if isinstance(error, dict)}
        # Only matched against, never shown or logged: it may echo account details.
        self.text = ' '.join(str(error.get('message', '')) for error in errors or [] if isinstance(error, dict)).lower()


def _json(raw):
    try: return json.loads(raw or b'{}')
    except ValueError: return {}


def _credential(value, code):
    text = value.strip() if isinstance(value, str) else ''
    if not 0 < len(text) <= 1024 or not text.isprintable() or ' ' in text: raise OffsiteError(code)
    return text


class Cloudflare:
    def __init__(self, token, opener=None):
        self.token, self.opener = token, opener or urllib.request.build_opener()

    def call(self, method, path, body=None):
        request = urllib.request.Request(CLOUDFLARE_API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                         headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'User-Agent': 'Nocheh'})
        try:
            with self.opener.open(request, timeout=30) as response: answer = _json(response.read(4 * 1024 * 1024))
        except urllib.error.HTTPError as error:
            raise CloudflareError(error.code, _json(error.read(65536))) from None
        except OSError:
            raise OffsiteError('offsite_cloudflare_unreachable') from None
        if not isinstance(answer, dict) or answer.get('success') is not True: raise CloudflareError(200, answer)
        return answer.get('result')


def _refused(error):
    return error.status == 401 or bool(error.codes & TOKEN_REFUSED)


def _accounts(api):
    try: rows = api.call('GET', '/accounts?per_page=50')
    except CloudflareError as error:
        if _refused(error): raise OffsiteError('offsite_cloudflare_token_refused') from None
        return []
    return [{'id': row['id'], 'name': str(row.get('name') or '')[:200]} for row in rows or []
            if isinstance(row, dict) and re.fullmatch(r'[0-9a-f]{32}', str(row.get('id', '')))]


def _setup_token(api, account):
    """The setup token's own id, and where tokens of its kind are made: account tokens or user tokens."""
    for tokens in (f'/accounts/{account}/tokens', '/user/tokens'):
        try: found = api.call('GET', tokens + '/verify')
        except CloudflareError: continue
        if isinstance(found, dict) and found.get('status') == 'active' and found.get('id'): return tokens, str(found['id'])
    raise OffsiteError('offsite_cloudflare_token_refused')


def _bucket_refused(error):
    if R2_OFF in error.codes or 'enable r2' in error.text or 'purchase r2' in error.text: raise OffsiteError('offsite_cloudflare_r2_off') from None
    if error.status == 403 or 10000 in error.codes: raise OffsiteError('offsite_cloudflare_needs_r2_permission') from None
    raise OffsiteError('offsite_cloudflare_bucket_failed') from None


def _bucket(api, account, saved):
    """The bucket an earlier connect saved, or a new one. Connecting again keeps the bucket and the copies in it. A bucket
    this installation did not save is never taken over: another installation may keep and prune its own copies there."""
    path = f'/accounts/{account}/r2/buckets'
    if saved:
        try: api.call('GET', f'{path}/{saved}'); return saved
        except CloudflareError as error:
            if error.status != 404: _bucket_refused(error)
    for name in (BUCKET, f'{BUCKET}-{secrets.token_hex(4)}'):
        try: api.call('POST', path, {'name': name}); return name
        except CloudflareError as error:
            try: api.call('GET', f'{path}/{name}')
            except CloudflareError: _bucket_refused(error)
    raise OffsiteError('offsite_cloudflare_bucket_failed')


def _lock(api, account, bucket):
    """Copies under PREFIX cannot be deleted or replaced for LOCK_DAYS, even with the saved keys."""
    path = f'/accounts/{account}/r2/buckets/{bucket}/lock'
    # A PUT replaces every rule, so the owner's own rules are read first and kept. When they cannot be read,
    # nothing is written: a guess would delete them.
    try: rules = (api.call('GET', path) or {}).get('rules')
    except CloudflareError as error:
        if error.status != 404: raise OffsiteError('offsite_cloudflare_lock_failed') from None
        rules = []
    if not isinstance(rules or [], list): raise OffsiteError('offsite_cloudflare_lock_failed')
    rule = {'id': LOCK_RULE, 'enabled': True, 'prefix': PREFIX, 'condition': {'type': 'Age', 'maxAgeSeconds': LOCK_DAYS * 86400}}
    kept = [item for item in rules or [] if isinstance(item, dict) and item.get('id') != LOCK_RULE]
    try: api.call('PUT', path, {'rules': kept + [rule]})
    except CloudflareError: raise OffsiteError('offsite_cloudflare_lock_failed') from None


def _groups(api, tokens):
    found = {}
    for query in ('',) + tuple('?name=' + urllib.parse.quote(name) for name in OBJECT_GROUPS):
        try: rows = api.call('GET', tokens + '/permission_groups' + query)
        except CloudflareError as error:
            if error.status == 403 or 10000 in error.codes or 9109 in error.codes: raise OffsiteError('offsite_cloudflare_needs_token_permission') from None
            raise OffsiteError('offsite_cloudflare_token_failed') from None
        for row in rows or []:
            if isinstance(row, dict) and row.get('name') in OBJECT_GROUPS and row.get('id'): found[row['name']] = str(row['id'])
        if len(found) == len(OBJECT_GROUPS): return [{'id': found[name]} for name in OBJECT_GROUPS]
    raise OffsiteError('offsite_cloudflare_token_failed')


def _ours(api, tokens, token_id):
    """Only a key an earlier connect made is deleted, never one the owner made by hand."""
    try: found = api.call('GET', f'{tokens}/{urllib.parse.quote(token_id, safe="")}')
    except (CloudflareError, OffsiteError): return False
    return isinstance(found, dict) and found.get('name') == TOKEN_NAME


def _forget(api, tokens, token_id):
    try: api.call('DELETE', f'{tokens}/{urllib.parse.quote(token_id, safe="")}'); return True
    except (CloudflareError, OffsiteError): return False


def _try_storage(config, opener, wait):
    """Writes, reads back and removes a small object. New keys can take a few seconds to work, so it retries."""
    storage = Storage(config, opener)
    for attempt in range(8):
        try: storage.request('PUT', CHECK_KEY, body=b'nocheh', headers={'content-type': 'text/plain'}); break
        except OffsiteError:
            if attempt == 7: raise
            wait(2 + attempt)
    if storage.request('GET', CHECK_KEY) != b'nocheh': raise OffsiteError('offsite_storage_check_failed')
    try: storage.request('DELETE', CHECK_KEY)
    except OffsiteError: pass


def _store(state, changes):
    """Saves the storage settings; answers the new settings view and the revision it saved on."""
    from tools.operations.installation.configuration import load
    from tools.operations.installation.settings import revision, save
    before = revision(load(state))
    return save(state, changes, before), before


def _saved(state):
    from tools.operations.installation.configuration import env_path, load
    return load(state) if env_path(state).exists() else {}


def cloudflare(state, token, account=None, opener=None, store=_store, wait=time.sleep):
    api = Cloudflare(_credential(token, 'offsite_cloudflare_token_invalid'), opener)
    accounts = _accounts(api)
    if account:
        if not re.fullmatch(r'[0-9a-f]{32}', str(account)) or (accounts and account not in {row['id'] for row in accounts}):
            raise OffsiteError('offsite_cloudflare_account_invalid')
    elif len(accounts) == 1: account = accounts[0]['id']
    elif accounts: return {'status': 'choose_account', 'accounts': accounts}
    else: raise OffsiteError('offsite_cloudflare_account_needed')
    tokens, setup = _setup_token(api, account)
    endpoint = f'https://{account}.r2.cloudflarestorage.com'
    saved = _saved(state)
    # Only this installation's own earlier connect to this account counts; settings typed by hand never do.
    earlier = saved.get('NOCHEH_OFFSITE_PROVIDER') == 'cloudflare' and saved.get('NOCHEH_OFFSITE_ENDPOINT') == endpoint \
        and OWN_BUCKET.fullmatch(saved.get('NOCHEH_OFFSITE_BUCKET') or '')
    # Checked before the bucket is made, so a token without this permission leaves nothing behind.
    groups = _groups(api, tokens)
    bucket = _bucket(api, account, saved['NOCHEH_OFFSITE_BUCKET'] if earlier else None)
    _lock(api, account, bucket)
    try:
        created = api.call('POST', tokens, {'name': TOKEN_NAME, 'policies': [{
            'effect': 'allow', 'permission_groups': groups, 'resources': {f'com.cloudflare.edge.r2.bucket.{account}_default_{bucket}': '*'}}]})
    except CloudflareError as error:
        raise OffsiteError('offsite_cloudflare_needs_token_permission' if error.status == 403 or 10000 in error.codes
                           else 'offsite_cloudflare_token_failed') from None
    if not isinstance(created, dict) or not created.get('id') or not created.get('value'): raise OffsiteError('offsite_cloudflare_token_failed')
    # Cloudflare's S3 keys for a token: its id, and the SHA-256 of its value.
    key_id, secret = str(created['id']), hashlib.sha256(str(created['value']).encode()).hexdigest()
    try: _try_storage({'endpoint': endpoint, 'bucket': bucket, 'region': 'auto', 'access_key': key_id, 'secret_key': secret}, opener, wait)
    except Exception:
        _forget(api, tokens, key_id); raise
    previous = saved.get('NOCHEH_OFFSITE_ACCESS_KEY_ID') if earlier else None
    try:
        settings, saved_on = store(state, {'NOCHEH_OFFSITE_PROVIDER': 'cloudflare', 'NOCHEH_OFFSITE_ENDPOINT': endpoint, 'NOCHEH_OFFSITE_BUCKET': bucket,
                                           'NOCHEH_OFFSITE_REGION': 'auto', 'NOCHEH_OFFSITE_ACCESS_KEY_ID': key_id,
                                           'NOCHEH_OFFSITE_SECRET_ACCESS_KEY': secret})
    except Exception:
        _forget(api, tokens, key_id); raise
    # The key from an earlier connect is no longer used; the setup token is not needed again.
    if previous and previous not in (key_id, setup) and _ours(api, tokens, previous): _forget(api, tokens, previous)
    name = next((row['name'] for row in accounts if row['id'] == account), '')
    return {'status': 'connected', 'provider': 'cloudflare', 'bucket': bucket, 'account': name, 'lock_days': LOCK_DAYS,
            'setup_token_deleted': _forget(api, tokens, setup), 'settings': settings, 'saved_on': saved_on}


def backblaze(state, key_id, key, opener=None, store=_store, wait=time.sleep):
    key_id, key = _credential(key_id, 'offsite_backblaze_key_invalid'), _credential(key, 'offsite_backblaze_key_invalid')
    basic = base64.b64encode(f'{key_id}:{key}'.encode()).decode()
    request = urllib.request.Request(BACKBLAZE_AUTHORIZE, headers={'Authorization': 'Basic ' + basic, 'User-Agent': 'Nocheh'})
    try:
        with (opener or urllib.request.build_opener()).open(request, timeout=30) as response: answer = _json(response.read(1024 * 1024))
    except urllib.error.HTTPError as error:
        raise OffsiteError('offsite_backblaze_key_refused' if error.code in (400, 401, 403) else 'offsite_backblaze_unavailable') from None
    except OSError:
        raise OffsiteError('offsite_backblaze_unreachable') from None
    info = answer.get('apiInfo') if isinstance(answer, dict) else None
    api = info.get('storageApi') if isinstance(info, dict) else None
    api = api if isinstance(api, dict) else {}
    allowed = api.get('allowed') if isinstance(api.get('allowed'), dict) else {}
    # Version 4 lists the buckets a key may reach; version 3 named one.
    buckets = allowed.get('buckets') or ([{'name': allowed['bucketName']}] if allowed.get('bucketName') else [])
    names = [str(row['name']) for row in buckets if isinstance(row, dict) and row.get('name')]
    if len(names) != 1: raise OffsiteError('offsite_backblaze_key_not_limited')
    if not {'listFiles', 'readFiles', 'writeFiles'} <= set(allowed.get('capabilities') or []): raise OffsiteError('offsite_backblaze_key_read_only')
    endpoint = str(api.get('s3ApiUrl') or '').rstrip('/')
    found = re.fullmatch(r'https://s3\.([a-z0-9-]{1,32})\.backblazeb2\.com', endpoint)
    if not found: raise OffsiteError('offsite_backblaze_unavailable')
    config = {'endpoint': endpoint, 'bucket': names[0], 'region': found.group(1), 'access_key': key_id, 'secret_key': key}
    _try_storage(config, opener, wait)
    settings, saved_on = store(state, {'NOCHEH_OFFSITE_PROVIDER': 'backblaze', 'NOCHEH_OFFSITE_ENDPOINT': endpoint, 'NOCHEH_OFFSITE_BUCKET': names[0],
                                       'NOCHEH_OFFSITE_REGION': found.group(1), 'NOCHEH_OFFSITE_ACCESS_KEY_ID': key_id,
                                       'NOCHEH_OFFSITE_SECRET_ACCESS_KEY': key})
    return {'status': 'connected', 'provider': 'backblaze', 'bucket': names[0], 'settings': settings, 'saved_on': saved_on}


def connect(state, request):
    request = request if isinstance(request, dict) else {}
    provider = request.get('provider')
    if provider == 'cloudflare': return cloudflare(state, request.get('token'), request.get('account') or None)
    if provider == 'backblaze': return backblaze(state, request.get('key_id'), request.get('key'))
    raise OffsiteError('offsite_provider_unknown')
