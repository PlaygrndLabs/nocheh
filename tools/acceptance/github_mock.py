"""A fake GitHub for the full tester's GitHub copy scenario (ADR-0209, ADR-0210). Made-up data only; never the real GitHub.

The host makes the fixture with `prepare` before the installation starts: the made-up repository example-org/widgets
as a bare copy served over dumb HTTP, and a made-up app key, an RSA key openssl makes at run time, in a 0600 file with
its modulus beside it. The model fixture mounts that folder read-only and serves:

- GitHub's create page for a manifest (`/github/web/settings/apps/new`), which takes only an app that reads code and
  nothing else, and answers with where GitHub sends the browser back, with a one-time code;
- the install page (`/github/web/apps/<slug>/installations/new`), which installs the app for example-org's
  repositories and answers with the way back;
- the REST calls github.py makes (`/github/api/...`): the manifest conversion, which hands over the app's key once; the
  app's own calls, each checked against the key's RS256 signature; and the installation keys it makes, each limited
  to what was asked;
- the repository's files for git's dumb HTTP (`/github/git/...`), behind Basic auth as `x-access-token` with an
  installation key that may read that repository's code;
- `/fixture/github`: which requests came and whether each was allowed, the manifests sent, the installation keys made
  (only the tester reads them), how many requests elsewhere on the model fixture held the app's key, an installation
  key or the key committed in notes.txt (none should: the model and Telegram see none), and `{revoked}`, which makes
  GitHub refuse the app, as when the owner deletes it.

The key is read from its file at each request, so the fixture starts even before its folder is readable.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import time
from pathlib import Path

LOGIN = 'octo-example'
ORGANIZATION = 'example-org'
APP_ID = 1001
INSTALLATION = 2002
# The fixture's repository: <root>/git/<owner>/<name>.git.
PATH = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}')
# SHA-256's DigestInfo prefix in an RSASSA-PKCS1-v1_5 signature.
SHA256_INFO = bytes.fromhex('3031300d060960864801650304020105000420')


def classic_token():
    """A classic token shape for the copy's notes.txt; the guard must mask it whenever a job reads it."""
    return 'gh' + 'p_' + 'y' * 36


def key_line(pem):
    """A line from the middle of the app's key: what must never leave github.py's process."""
    return pem.splitlines()[5]


def prepare(root):
    """On the host, before the installation renders: the served bare copy and the app's key. Returns a line of the key
    and the tip commit."""
    from services.hermes.repo_fixture import made, served
    root = Path(root)
    work = root.parent / (root.name + '-work')
    root.mkdir(mode=0o700)
    try:
        repository, commit = made(work, notes=b'NOTESMARK ' + classic_token().encode() + b'\n')
        served(repository, root / 'git')
    finally:
        shutil.rmtree(work, ignore_errors=True)
    # PKCS#1, as GitHub hands a key over; LibreSSL writes it without being asked and has no -traditional.
    made_key = subprocess.run(['openssl', 'genrsa', '-traditional', '2048'], capture_output=True, text=True)
    if made_key.returncode:
        made_key = subprocess.run(['openssl', 'genrsa', '2048'], capture_output=True, text=True, check=True)
    pem = made_key.stdout
    with os.fdopen(os.open(root / 'app.pem', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
        file.write(pem)
    modulus = subprocess.run(['openssl', 'rsa', '-noout', '-modulus'], input=pem, capture_output=True, text=True, check=True).stdout
    (root / 'app.modulus').write_text(modulus.strip().split('=', 1)[1])
    return key_line(pem), commit


def unpadded(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


class GithubMock:
    def __init__(self, root):
        self.root = Path(root)
        self.revoked = False
        self.requests = []
        self.manifests = []
        # One-time codes from the create page, the app once converted, whether it is installed, and the keys made.
        self.codes = {}
        self.app = None
        self.installed = False
        self.issued = {}
        # Requests to the model fixture outside /github whose body or query held a key, or the committed key.
        self.elsewhere = 0
        self.committed = 0

    def pem(self):
        try:
            return (self.root / 'app.pem').read_text() or None
        except OSError:
            return None

    def modulus(self):
        try:
            return int((self.root / 'app.modulus').read_text().strip(), 16)
        except (OSError, ValueError):
            return None

    def repository(self, owner, name):
        """The served bare copy of owner/name, or None."""
        full = owner + '/' + name
        if not NAME.fullmatch(full):
            return None
        folder = self.root / 'git' / (full + '.git')
        return folder if folder.is_dir() and not folder.is_symlink() else None

    def repositories(self):
        found = []
        base = self.root / 'git'
        for owner in sorted(base.iterdir()) if base.is_dir() else []:
            for folder in sorted(owner.glob('*.git')):
                found.append((owner.name + '/' + folder.name[:-4], folder))
        return found

    @staticmethod
    def branch(folder):
        head = (folder / 'HEAD').read_text().strip()
        return head[len('ref: refs/heads/'):] if head.startswith('ref: refs/heads/') else 'main'

    @staticmethod
    def tip(folder, branch):
        """The branch's commit from info/refs, which update-server-info wrote."""
        for line in (folder / 'info/refs').read_text().splitlines():
            commit, _, ref = line.partition('\t')
            if ref == 'refs/heads/' + branch:
                return commit
        return None

    @staticmethod
    def size_kb(folder):
        total = sum(path.stat().st_size for path in folder.rglob('*') if path.is_file())
        return max(1, total // 1024)

    def describe(self, full, folder):
        return {'full_name': full, 'default_branch': self.branch(folder), 'private': True, 'size': self.size_kb(folder)}

    def signed(self, header):
        """Whether an Authorization header carries the app's own token: an RS256 JWT by the app's key, for at most
        ten minutes, naming the app."""
        modulus = self.modulus()
        if self.revoked or self.app is None or not modulus or not isinstance(header, str) or not header.startswith('Bearer '):
            return False
        try:
            head, claims, signature = header[7:].split('.')
            if json.loads(unpadded(head)) != {'alg': 'RS256', 'typ': 'JWT'}:
                return False
            body = json.loads(unpadded(claims))
            size = (modulus.bit_length() + 7) // 8
            digest = SHA256_INFO + hashlib.sha256((head + '.' + claims).encode()).digest()
            expected = b'\x00\x01' + b'\xff' * (size - len(digest) - 3) + b'\x00' + digest
            seen = pow(int.from_bytes(unpadded(signature), 'big'), 65537, modulus).to_bytes(size, 'big')
        except (ValueError, TypeError, OverflowError):
            return False
        now = time.time()
        return secrets.compare_digest(seen, expected) and str(body.get('iss')) == str(APP_ID) and body.get('iat', now + 61) <= now + 60 \
            and now < body.get('exp', 0) and body['exp'] - body['iat'] <= 600

    def key_for(self, header, basic=False):
        """The installation key an Authorization header carries: Bearer for the API, Basic for git."""
        if self.revoked or not isinstance(header, str):
            return None
        if basic:
            if not header.startswith('Basic '):
                return None
            try:
                user, _, token = base64.b64decode(header[6:], validate=True).decode().partition(':')
            except ValueError:
                return None
            if user != 'x-access-token':
                return None
        elif header.startswith('Bearer '):
            token = header[7:]
        else:
            return None
        issued = self.issued.get(token)
        return issued if issued and issued['expires'] > time.time() else None

    @staticmethod
    def reads(issued, owner, name, code=False):
        """Whether an installation key may read that repository, and its code when `code`."""
        return issued is not None and owner == ORGANIZATION and (issued['repositories'] is None or name.lower() in issued['repositories']) \
            and (not code or issued['permissions'].get('contents') == 'read')

    def seen(self, request, authorized):
        self.requests.append({'at': time.time(), 'method': request.method, 'path': request.url.path,
                              'authorized': authorized, 'scheme': (request.headers.get('authorization') or ' ').split(' ')[0] or None})

    def secrets_in(self, text):
        """How many of the app's key and the installation keys a request outside /github carried."""
        pem = self.pem()
        found = [pem.splitlines()[5]] if pem else []
        return sum(1 for value in found + list(self.issued) if value in text)

    def install(self, app):
        from fastapi import Request
        from fastapi.responses import JSONResponse, Response

        def refused():
            return JSONResponse({'message': 'Bad credentials'}, status_code=401)

        def missing():
            return JSONResponse({'message': 'Not Found'}, status_code=404)

        def unprocessable(message):
            return JSONResponse({'message': message}, status_code=422)

        async def form(request):
            """A browser posts the create form; the tester posts JSON in its place."""
            raw = (await request.body()).decode()
            if request.headers.get('content-type', '').startswith('application/x-www-form-urlencoded'):
                from urllib.parse import parse_qs
                return {key: values[0] for key, values in parse_qs(raw).items()}
            try:
                body = json.loads(raw or '{}')
            except ValueError:
                return {}
            return body if isinstance(body, dict) else {}

        @app.middleware('http')
        async def watch(request: Request, call_next):
            # Only the GitHub routes may ever see a key. Neither the app's key, an installation key nor the key in the
            # copy's notes.txt, which the guard masks, may reach the model or Telegram.
            if not request.url.path.startswith('/github/'):
                body, query = (await request.body()).decode(errors='replace'), str(request.url.query)
                self.elsewhere += self.secrets_in(query + '\n' + body)
                if classic_token() in query or classic_token() in body:
                    self.committed += 1
            return await call_next(request)

        @app.post('/github/web/settings/apps/new')
        async def create(request: Request):
            self.seen(request, True)
            try:
                manifest = json.loads((await form(request)).get('manifest') or 'null')
            except ValueError:
                manifest = None
            state = request.query_params.get('state') or ''
            if not isinstance(manifest, dict) or manifest.get('default_permissions') != {'contents': 'read', 'metadata': 'read'} \
                    or manifest.get('default_events') != [] or manifest.get('public') is not False or 'hook_attributes' in manifest \
                    or not str(manifest.get('redirect_url', '')).endswith('/connect/github') or manifest.get('setup_url') != manifest['redirect_url'] \
                    or not re.fullmatch(r'Nocheh-[a-f0-9]{6}', str(manifest.get('name'))) or not state:
                return unprocessable('Invalid manifest')
            self.manifests.append(manifest)
            code = secrets.token_hex(10)
            self.codes[code] = manifest
            return {'redirect': manifest['redirect_url'] + '?code=' + code + '&state=' + state}

        @app.post('/github/api/app-manifests/{code}/conversions')
        async def conversion(code: str, request: Request):
            manifest = self.codes.pop(code, None)
            pem = self.pem()
            self.seen(request, manifest is not None)
            if manifest is None or pem is None or request.headers.get('authorization'):
                return missing()
            slug = manifest['name'].lower()
            self.app = {'id': APP_ID, 'slug': slug, 'setup_url': manifest['setup_url']}
            return {'id': APP_ID, 'slug': slug, 'name': manifest['name'], 'owner': {'login': LOGIN, 'type': 'User'},
                    'html_url': 'https://github.com/apps/' + slug, 'client_id': 'Iv1.fixture',
                    'client_secret': 'FIXTURECLIENT' + secrets.token_hex(16), 'webhook_secret': 'FIXTUREHOOK' + secrets.token_hex(16), 'pem': pem}

        @app.post('/github/web/apps/{slug}/installations/new')
        async def installed(slug: str, request: Request):
            self.seen(request, self.app is not None)
            if self.app is None or slug != self.app['slug']:
                return missing()
            self.installed = True
            return {'redirect': self.app['setup_url'] + '?installation_id=' + str(INSTALLATION) + '&setup_action=install'}

        @app.get('/github/api/app/installations')
        async def installations(request: Request):
            authorized = self.signed(request.headers.get('authorization'))
            self.seen(request, authorized)
            if not authorized:
                return refused()
            return [{'id': INSTALLATION, 'account': {'login': ORGANIZATION, 'type': 'Organization'}}] if self.installed else []

        @app.get('/github/api/repos/{owner}/{name}/installation')
        async def installation(owner: str, name: str, request: Request):
            authorized = self.signed(request.headers.get('authorization'))
            self.seen(request, authorized)
            if not authorized:
                return refused()
            return {'id': INSTALLATION} if self.installed and owner == ORGANIZATION and self.repository(owner, name) else missing()

        @app.post('/github/api/app/installations/{number}/access_tokens')
        async def key(number: int, request: Request):
            authorized = self.signed(request.headers.get('authorization'))
            self.seen(request, authorized)
            if not authorized:
                return refused()
            if not self.installed or number != INSTALLATION:
                return missing()
            try:
                body = json.loads(await request.body())
            except ValueError:
                body = None
            permissions = (body or {}).get('permissions')
            wanted = (body or {}).get('repositories')
            if not isinstance(permissions, dict) or not set(permissions.items()) <= {('contents', 'read'), ('metadata', 'read')} \
                    or wanted is not None and not (isinstance(wanted, list) and all(isinstance(item, str) and self.repository(ORGANIZATION, item) for item in wanted)):
                return unprocessable('Invalid permissions or repositories')
            token = 'gh' + 's_' + secrets.token_hex(18)
            expires = time.time() + 3600
            self.issued[token] = {'repositories': None if wanted is None else [item.lower() for item in wanted], 'permissions': permissions, 'expires': expires}
            return {'token': token, 'expires_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(expires)), 'permissions': permissions}

        @app.get('/github/api/installation/repositories')
        async def listed(request: Request):
            issued = self.key_for(request.headers.get('authorization'))
            self.seen(request, issued is not None)
            if issued is None:
                return refused()
            page = request.query_params.get('page', '1')
            rows = [self.describe(full, folder) for full, folder in self.repositories() if self.reads(issued, *full.split('/'))]
            return {'total_count': len(rows), 'repositories': rows if page == '1' else []}

        @app.get('/github/api/repos/{owner}/{name}')
        async def repo(owner: str, name: str, request: Request):
            issued = self.key_for(request.headers.get('authorization'))
            self.seen(request, issued is not None)
            if issued is None:
                return refused()
            folder = self.repository(owner, name) if self.reads(issued, owner, name) else None
            return JSONResponse(self.describe(owner + '/' + name, folder)) if folder else missing()

        @app.get('/github/api/repos/{owner}/{name}/commits/{branch:path}')
        async def commit(owner: str, name: str, branch: str, request: Request):
            issued = self.key_for(request.headers.get('authorization'))
            self.seen(request, issued is not None)
            if issued is None:
                return refused()
            folder = self.repository(owner, name) if self.reads(issued, owner, name, code=True) else None
            tip = self.tip(folder, branch) if folder else None
            if not tip or request.headers.get('accept') != 'application/vnd.github.sha':
                return missing()
            return Response(tip, media_type='application/vnd.github.sha')

        @app.get('/github/git/{path:path}')
        async def files(path: str, request: Request):
            issued = self.key_for(request.headers.get('authorization'), basic=True)
            parts = path.split('/')
            authorized = len(parts) > 2 and parts[1].endswith('.git') and self.reads(issued, parts[0], parts[1][:-4], code=True)
            self.seen(request, authorized)
            if not authorized:
                return Response('Unauthorized', status_code=401, headers={'WWW-Authenticate': 'Basic realm="fixture"'})
            if not PATH.fullmatch(path) or '..' in parts:
                return Response(status_code=404)
            file = self.root / 'git' / path
            try:
                mode = os.lstat(file).st_mode
            except OSError:
                return Response(status_code=404)
            if not stat.S_ISREG(mode):
                return Response(status_code=404)
            # A plain type: git then reads info/refs as the dumb protocol.
            return Response(file.read_bytes(), media_type='text/plain' if path.endswith('/info/refs') else 'application/octet-stream')

        @app.get('/fixture/github')
        async def snapshot():
            return {'requests': self.requests, 'revoked': self.revoked, 'elsewhere': self.elsewhere, 'committed': self.committed,
                    'manifests': self.manifests, 'issued': [{'token': token, 'repositories': row['repositories'], 'permissions': row['permissions']}
                                                            for token, row in self.issued.items()]}

        @app.post('/fixture/github')
        async def configure(request: Request):
            try:
                body = await request.json()
            except ValueError:
                body = None
            if not isinstance(body, dict) or set(body) != {'revoked'} or type(body['revoked']) is not bool:
                return JSONResponse({'error': 'invalid_fixture_control'}, status_code=400)
            self.revoked = body['revoked']
            return {'revoked': self.revoked}
