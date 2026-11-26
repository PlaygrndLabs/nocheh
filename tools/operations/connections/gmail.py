"""The owner's own Gmail, read only (ADR-0272).

Reading mail is a Google "restricted" scope. The owner makes a Google Cloud project in Personal mode, which
needs no review and keeps its sign-in, and pastes its OAuth client here. The dashboard then starts a sign-in:
OAuth with PKCE and offline access, Google sending the browser back to the dashboard, which hands the code here.
The client and the sign-in are kept in the installation's admin folder, admin/connections/gmail.json, readable
only by the management and executor services; no view returns the secret or a token. Lookups are a few fixed
reads: search mail, read a message, read a thread. The store decides where they may run.
"""
import base64
import hashlib
import html
import json
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

from tools.operations.connections import fixture as fixture_service, secret_file

NAME = 'gmail'
AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN = 'https://oauth2.googleapis.com/token'
REVOKE = 'https://oauth2.googleapis.com/revoke'
# Gmail names the signed-in account's own mailbox 'me'.
MAILBOX = 'me'
API = '/'.join(('https://gmail.googleapis.com/gmail/v1', 'users', MAILBOX))
# The tester's fake Google, used only in a fixture installation and only at this exact address.
FIXTURE_GMAIL_URL = fixture_service.HOST + '/gmail'
SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
PENDING_SECONDS = 600
CLIENT_ID = re.compile(r'[0-9]{1,40}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com')
MESSAGE_ID = re.compile(r'[A-Za-z0-9_-]{6,64}')
LOOKUPS = ('search_mail', 'read_message', 'read_thread')
SEARCH_LIMIT = 20
MESSAGE_TEXT = 20000
THREAD_TEXT = 60000


def path(state): return secret_file.path(state, NAME)
def locked(state): return secret_file.locked(state, NAME)
def read(state): return secret_file.read(state, NAME)
def write(state, value): return secret_file.write(state, NAME, value)


def fixture(): return fixture_service.on('NOCHEH_GMAIL_URL', FIXTURE_GMAIL_URL)


def token_url(): return FIXTURE_GMAIL_URL + '/token' if fixture() else TOKEN


def revoke_url(): return FIXTURE_GMAIL_URL + '/revoke' if fixture() else REVOKE


def api_url(): return FIXTURE_GMAIL_URL + urllib.parse.urlsplit(API).path if fixture() else API


def opener():
    return fixture_service.opener(fixture())


def post(url, body):
    request = urllib.request.Request(url, data=urllib.parse.urlencode(body).encode(), method='POST', headers={
        'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'Nocheh'})
    with opener().open(request, timeout=20) as response:
        return json.loads(response.read(1024 * 1024) or b'{}')


def get(url, token):
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': 'Nocheh'})
    with opener().open(request, timeout=30) as response:
        return json.loads(response.read(8 * 1024 * 1024) or b'{}')


def status(state):
    saved = read(state); client = saved.get('client') or {}; grant = saved.get('grant') or {}
    return {'client': client.get('id'), 'connected': bool(grant.get('access_token')), 'email': grant.get('email'),
            'connected_at': grant.get('connected_at'), 'reconnect': bool(grant.get('reconnect'))}


def save_client(state, client_id, client_secret):
    """The OAuth client of the owner's Personal mode project. A new client forgets the old sign-in."""
    client_id = client_id.strip() if isinstance(client_id, str) else ''
    client_secret = client_secret.strip() if isinstance(client_secret, str) else ''
    if not CLIENT_ID.fullmatch(client_id): raise ValueError('invalid_gmail_client')
    if not 8 <= len(client_secret) <= 256 or not client_secret.isprintable() or ' ' in client_secret: raise ValueError('invalid_gmail_client')
    with locked(state):
        saved = read(state)
        if (saved.get('client') or {}).get('id') != client_id: saved.pop('grant', None)
        saved['client'] = {'id': client_id, 'secret': client_secret}; saved.pop('pending', None); write(state, saved)
    return status(state)


def redirect(address):
    """The dashboard page Google returns to: this computer's dashboard, or an https address."""
    parsed = urllib.parse.urlsplit(address if isinstance(address, str) else '')
    local = parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost')
    if not (local or parsed.scheme == 'https') or parsed.username or parsed.password or parsed.fragment \
            or parsed.path not in ('', '/') or parsed.query != 'connect=gmail':
        raise ValueError('invalid_gmail_redirect')
    return address


def start(state, address):
    address = redirect(address)
    with locked(state):
        saved = read(state); client = saved.get('client') or {}
        if not client.get('id'): raise ValueError('gmail_client_missing')
        verifier = secrets.token_urlsafe(48); nonce = secrets.token_urlsafe(24)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        saved['pending'] = {'state': nonce, 'verifier': verifier, 'redirect': address, 'expires': time.time() + PENDING_SECONDS}
        write(state, saved)
    query = urllib.parse.urlencode({'response_type': 'code', 'client_id': client['id'], 'redirect_uri': address, 'scope': SCOPE,
                                    'state': nonce, 'code_challenge': challenge, 'code_challenge_method': 'S256',
                                    'access_type': 'offline', 'prompt': 'consent'})
    return {'url': AUTHORIZE + '?' + query}


def fresh(token, refresh=None):
    access, refresh = token.get('access_token'), token.get('refresh_token') or refresh
    if not isinstance(access, str) or not isinstance(refresh, str): raise ValueError('gmail_sign_in_refused')
    return {'access_token': access, 'refresh_token': refresh,
            'expires_at': time.time() + max(60, min(int(token.get('expires_in') or 3600), 86400))}


def finish(state, code, nonce, post=post, get=get):
    if not isinstance(code, str) or not 0 < len(code) <= 2048 or not isinstance(nonce, str): raise ValueError('invalid_gmail_sign_in')
    with locked(state):
        saved = read(state); pending = saved.get('pending') or {}; client = saved.get('client') or {}
        if not client.get('id') or not secrets.compare_digest(pending.get('state', ''), nonce) or pending.get('expires', 0) < time.time():
            raise ValueError('gmail_sign_in_expired')
        try:
            token = post(token_url(), {'grant_type': 'authorization_code', 'code': code, 'client_id': client['id'], 'client_secret': client['secret'],
                                 'redirect_uri': pending['redirect'], 'code_verifier': pending['verifier']})
        except urllib.error.HTTPError:
            raise ValueError('gmail_sign_in_refused') from None
        except OSError:
            raise ValueError('gmail_unavailable') from None
        # Google lets the person untick a permission on its consent page; without mail reading there is nothing to use.
        if SCOPE not in str(token.get('scope', '')).split(): raise ValueError('gmail_scope_missing')
        grant = fresh(token)
        try: email = get(api_url() + '/profile', grant['access_token']).get('emailAddress')
        except urllib.error.HTTPError as error: raise ValueError(api_error(error)) from None
        except OSError: raise ValueError('gmail_unavailable') from None
        saved.pop('pending')
        saved['grant'] = {**grant, 'email': email if isinstance(email, str) else None, 'connected_at': int(time.time())}
        write(state, saved)
    return status(state)


def disconnect(state, post=post):
    with locked(state):
        saved = read(state); grant = saved.pop('grant', None); saved.pop('pending', None); write(state, saved)
    if grant and grant.get('refresh_token'):
        # Best effort: the sign-in is already forgotten here whatever Google answers.
        try: post(revoke_url(), {'token': grant['refresh_token']})
        except Exception: pass
    return status(state)


def bearer(state, post=post, now=time.time):
    """A current access token, refreshed when it is about to expire. Raises a plain code when Google needs signing in again."""
    with locked(state):
        saved = read(state); grant = saved.get('grant') or {}; client = saved.get('client') or {}
        if not grant.get('access_token'):
            raise ValueError('gmail_reconnect_needed' if grant.get('reconnect') else 'gmail_not_connected')
        if grant['expires_at'] - 300 > now(): return grant['access_token']
        try:
            token = post(token_url(), {'grant_type': 'refresh_token', 'refresh_token': grant['refresh_token'],
                                 'client_id': client.get('id'), 'client_secret': client.get('secret')})
        except urllib.error.HTTPError as error:
            body = {}
            try: body = json.loads(error.read(65536) or b'{}')
            except Exception: pass
            if error.code in (400, 401) and body.get('error') in ('invalid_grant', 'invalid_client', 'unauthorized_client'):
                # Terminal: forget the tokens and ask the owner to connect again; never retry.
                saved['grant'] = {key: grant.get(key) for key in ('email', 'connected_at')} | {'reconnect': True}
                write(state, saved)
                raise ValueError('gmail_reconnect_needed') from None
            raise ValueError('gmail_unavailable') from None
        except OSError:
            raise ValueError('gmail_unavailable') from None
        grant.update(fresh(token, grant['refresh_token'])); saved['grant'] = grant; write(state, saved)
        return grant['access_token']


def api_error(error):
    """Google's answer in a plain code: the Gmail API switched off in the project, a lost permission, or a missing message."""
    body = b''
    try: body = error.read(65536)
    except Exception: pass
    if error.code == 403 and (b'accessNotConfigured' in body or b'SERVICE_DISABLED' in body): return 'gmail_api_off'
    if error.code in (401, 403): return 'gmail_reconnect_needed'
    if error.code == 404: return 'gmail_message_not_found'
    return 'gmail_unavailable'


# Lookups: a few fixed reads, shaped small.

def headers_of(payload):
    wanted = {'from': 'from', 'to': 'to', 'cc': 'cc', 'subject': 'subject', 'date': 'date'}; found = {}
    for header in (payload or {}).get('headers') or []:
        if isinstance(header, dict) and isinstance(header.get('name'), str) and header['name'].lower() in wanted:
            found.setdefault(wanted[header['name'].lower()], str(header.get('value', ''))[:1000])
    return found


def decoded(data):
    try: return base64.urlsafe_b64decode(data + '=' * (-len(data) % 4)).decode('utf-8', errors='replace')
    except (ValueError, TypeError): return ''


def plain(markup):
    text = re.sub(r'(?is)<(script|style)\b.*?</\1>', ' ', markup)
    text = re.sub(r'(?i)<br\s*/?>|</(p|div|tr|li|h[1-6])>', '\n', text)
    text = html.unescape(re.sub(r'<[^>]+>', ' ', text))
    return re.sub(r'\n\s*\n+', '\n\n', re.sub(r'[ \t\f\v]+', ' ', text)).strip()


def body_of(payload):
    """The message's text: its plain part, else its HTML made plain; and its attachments by name only."""
    texts, markups, files = [], [], []
    def walk(part, depth=0):
        if not isinstance(part, dict) or depth > 20: return
        kind = str(part.get('mimeType', '')).lower(); body = part.get('body') if isinstance(part.get('body'), dict) else {}
        if part.get('filename'):
            files.append({'name': str(part['filename'])[:300], 'type': kind[:100], 'size': body.get('size')})
        elif isinstance(body.get('data'), str):
            if kind == 'text/plain': texts.append(decoded(body['data']))
            elif kind == 'text/html': markups.append(decoded(body['data']))
        for child in part.get('parts') or []: walk(child, depth + 1)
    walk(payload)
    text = '\n\n'.join(texts) if any(t.strip() for t in texts) else plain('\n'.join(markups))
    return text, files[:50]


def message_row(message, limit):
    text, files = body_of(message.get('payload'))
    return {'id': message.get('id'), 'thread': message.get('threadId'), **headers_of(message.get('payload')),
            'labels': [label for label in message.get('labelIds') or [] if isinstance(label, str)][:20],
            'text': text[:limit], 'cut': len(text) > limit, 'attachments': files}


def lookup(state, args, post=post, get=get):
    """One lookup: {'response': its answer}. Raises ValueError('invalid_gmail_lookup') for anything the store would refuse too."""
    given = args.get('input') if isinstance(args.get('input'), dict) else {}; tool = args.get('tool')
    if tool not in LOOKUPS: raise ValueError('invalid_gmail_lookup')
    if tool == 'search_mail':
        query = given.get('query')
        if not (isinstance(query, str) and 0 < len(query) <= 300 and not re.search(r'[\0\r\n]', query)): raise ValueError('invalid_gmail_lookup')
    else:
        name = given.get('id')
        if not (isinstance(name, str) and MESSAGE_ID.fullmatch(name)): raise ValueError('invalid_gmail_lookup')
    token = bearer(state, post=post)
    def read_api(path):
        try: return get(api_url() + path, token)
        except urllib.error.HTTPError as error: raise ValueError(api_error(error)) from None
        except OSError: raise ValueError('gmail_unavailable') from None
    if tool == 'search_mail':
        found = read_api('/messages?' + urllib.parse.urlencode({'q': query, 'maxResults': SEARCH_LIMIT}))
        rows = []
        for item in (found.get('messages') or [])[:SEARCH_LIMIT]:
            if not isinstance(item, dict) or not MESSAGE_ID.fullmatch(str(item.get('id', ''))): continue
            meta = read_api('/messages/' + item['id'] + '?' + urllib.parse.urlencode(
                [('format', 'metadata')] + [('metadataHeaders', name) for name in ('From', 'To', 'Subject', 'Date')]))
            rows.append({'id': meta.get('id'), 'thread': meta.get('threadId'), **headers_of(meta.get('payload')),
                         'snippet': html.unescape(str(meta.get('snippet', '')))[:300]})
        return {'response': {'query': query, 'estimate': found.get('resultSizeEstimate'), 'messages': rows,
                             'more': bool(found.get('nextPageToken'))}}
    if tool == 'read_message':
        return {'response': message_row(read_api('/messages/' + name + '?format=full'), MESSAGE_TEXT)}
    thread = read_api('/threads/' + name + '?format=full'); left = THREAD_TEXT; rows = []
    for message in (thread.get('messages') or [])[:100]:
        if not isinstance(message, dict): continue
        row = message_row(message, max(0, min(MESSAGE_TEXT, left))); left -= len(row['text']); rows.append(row)
    return {'response': {'thread': thread.get('id'), 'messages': rows, 'cut': left <= 0}}
