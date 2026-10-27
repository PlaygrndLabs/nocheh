"""The owner's Notion sign-in for Notion's hosted MCP server.

The dashboard starts a sign-in: a public client registered once per dashboard
address, OAuth with PKCE, and Notion sending the browser back to the dashboard,
which hands the code here. On a Business plan an MCP token can be saved instead.
The sign-in is kept in the installation's admin folder with the other keys,
readable only by the management and executor services; no view returns it.
Access tokens are refreshed under one lock, and each new refresh token is saved
before it is used, as Notion requires.
"""
import base64
import fcntl
import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path

ISSUER = 'https://mcp.notion.com'
MCP_URL = ISSUER + '/mcp'
AUTHORIZE, TOKEN, REGISTER = ISSUER + '/authorize', ISSUER + '/token', ISSUER + '/register'
# Notion answers with the newest version it supports; these are the ones this client speaks.
VERSIONS = ('2025-11-25', '2025-06-18', '2025-03-26')
PENDING_SECONDS = 600


def path(state):
    return Path(state) / 'admin/connections/notion.json'


@contextmanager
def locked(state):
    folder = path(state).parent
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (folder / 'notion.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def read(state):
    file = path(state)
    if file.is_symlink(): raise ValueError('notion_connection_path_denied')
    return json.loads(file.read_text()) if file.exists() else {}


def write(state, value):
    file = path(state); temporary = file.with_suffix('.tmp')
    with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as handle:
        json.dump(value, handle); handle.flush(); os.fsync(handle.fileno())
    temporary.replace(file)


def post(url, body, form=True, opener=None):
    data = urllib.parse.urlencode(body).encode() if form else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method='POST', headers={
        'Content-Type': 'application/x-www-form-urlencoded' if form else 'application/json',
        'Accept': 'application/json', 'User-Agent': 'Nocheh'})
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler(urllib.request.getproxies()))
    with opener.open(request, timeout=20) as response:
        return json.loads(response.read(1024 * 1024) or b'{}')


def status(state):
    grant = read(state).get('grant') or {}
    return {'connected': bool(grant.get('access_token')), 'method': grant.get('method'),
            'workspace': grant.get('workspace_name'), 'connected_at': grant.get('connected_at'),
            'reconnect': bool(grant.get('reconnect'))}


def redirect(address):
    """The dashboard page Notion returns to: this computer's dashboard, or an https address."""
    parsed = urllib.parse.urlsplit(address if isinstance(address, str) else '')
    local = parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost')
    if not (local or parsed.scheme == 'https') or parsed.username or parsed.password or parsed.fragment \
            or parsed.path not in ('', '/') or parsed.query != 'connect=notion':
        raise ValueError('invalid_notion_redirect')
    return address


def start(state, address, post=post):
    address = redirect(address)
    with locked(state):
        saved = read(state); clients = saved.setdefault('clients', {})
        if address not in clients:
            # Registering again would orphan earlier sign-ins, so each address registers once.
            client = post(REGISTER, {'client_name': 'Nocheh', 'redirect_uris': [address], 'grant_types': ['authorization_code', 'refresh_token'],
                                     'response_types': ['code'], 'token_endpoint_auth_method': 'none'}, form=False)
            if not isinstance(client.get('client_id'), str): raise ValueError('notion_registration_failed')
            clients[address] = client['client_id']
        verifier = secrets.token_urlsafe(32); nonce = secrets.token_urlsafe(24)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        saved['pending'] = {'state': nonce, 'verifier': verifier, 'redirect': address, 'expires': time.time() + PENDING_SECONDS}
        write(state, saved)
    query = urllib.parse.urlencode({'response_type': 'code', 'client_id': clients[address], 'redirect_uri': address, 'state': nonce,
                                    'code_challenge': challenge, 'code_challenge_method': 'S256', 'prompt': 'consent'})
    return {'url': AUTHORIZE + '?' + query}


def finish(state, code, nonce, post=post):
    if not isinstance(code, str) or not 0 < len(code) <= 2048 or not isinstance(nonce, str): raise ValueError('invalid_notion_sign_in')
    with locked(state):
        saved = read(state); pending = saved.get('pending') or {}
        if not secrets.compare_digest(pending.get('state', ''), nonce) or pending.get('expires', 0) < time.time():
            raise ValueError('notion_sign_in_expired')
        client = saved['clients'][pending['redirect']]
        try:
            token = post(TOKEN, {'grant_type': 'authorization_code', 'code': code, 'client_id': client,
                                 'redirect_uri': pending['redirect'], 'code_verifier': pending['verifier']})
        except urllib.error.HTTPError:
            raise ValueError('notion_sign_in_refused') from None
        saved.pop('pending')
        saved['grant'] = {**fresh(token), 'method': 'oauth', 'client_id': client, 'workspace_name': token.get('workspace_name'),
                          'workspace_id': token.get('workspace_id'), 'connected_at': int(time.time())}
        write(state, saved)
    return status(state)


def fresh(token):
    if not isinstance(token.get('access_token'), str) or not isinstance(token.get('refresh_token'), str): raise ValueError('notion_sign_in_refused')
    return {'access_token': token['access_token'], 'refresh_token': token['refresh_token'],
            'expires_at': time.time() + max(60, min(int(token.get('expires_in') or 3600), 86400))}


def save_token(state, value, check=None):
    """A Business plan's MCP token from Notion's developer portal; it does not expire on its own."""
    token = value.strip() if isinstance(value, str) else ''
    if not 0 < len(token) <= 4096 or not token.isprintable() or ' ' in token: raise ValueError('invalid_notion_token')
    (check or verify)(token)
    with locked(state):
        saved = read(state)
        saved['grant'] = {'method': 'token', 'access_token': token, 'connected_at': int(time.time())}
        saved.pop('pending', None); write(state, saved)
    return status(state)


def verify(token, opener=None):
    """Opens an MCP session with the token, so a wrong one is refused when it is saved."""
    request = urllib.request.Request(MCP_URL, method='POST', headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
        'User-Agent': 'Nocheh'}, data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': VERSIONS[0], 'capabilities': {}, 'clientInfo': {'name': 'nocheh', 'version': '0.2'}}}).encode())
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler(urllib.request.getproxies()))
    try:
        with opener.open(request, timeout=20): pass
    except urllib.error.HTTPError as error:
        raise ValueError('notion_token_refused' if error.code in (401, 403) else 'notion_unavailable') from None
    except OSError:
        raise ValueError('notion_unavailable') from None


def disconnect(state, post=post):
    with locked(state):
        saved = read(state); grant = saved.pop('grant', None); saved.pop('pending', None); write(state, saved)
    if grant and grant.get('method') == 'oauth':
        # Best effort: the sign-in is already forgotten here whatever Notion answers.
        try: post(TOKEN, {'token': grant['refresh_token'], 'client_id': grant['client_id'], 'token_type_hint': 'refresh_token'})
        except Exception: pass
    return status(state)


def bearer(state, post=post, now=time.time):
    """A current access token, refreshed when it is about to expire. Raises a plain code when Notion needs signing in again."""
    with locked(state):
        saved = read(state); grant = saved.get('grant') or {}
        if not grant.get('access_token'):
            raise ValueError('notion_reconnect_needed' if grant.get('reconnect') else 'notion_not_connected')
        if grant['method'] == 'token' or grant['expires_at'] - 300 > now(): return grant['access_token']
        try:
            token = post(TOKEN, {'grant_type': 'refresh_token', 'refresh_token': grant['refresh_token'], 'client_id': grant['client_id']})
        except urllib.error.HTTPError as error:
            body = {}
            try: body = json.loads(error.read(65536) or b'{}')
            except Exception: pass
            if error.code in (400, 401) and body.get('error') == 'invalid_grant':
                # Terminal: forget the tokens and ask the owner to connect again; never retry.
                saved['grant'] = {key: grant.get(key) for key in ('method', 'workspace_name', 'workspace_id', 'connected_at')} | {'reconnect': True}
                write(state, saved)
                raise ValueError('notion_reconnect_needed') from None
            raise ValueError('notion_unavailable') from None
        except OSError:
            raise ValueError('notion_unavailable') from None
        grant.update(fresh(token)); saved['grant'] = grant; write(state, saved)
        return grant['access_token']
