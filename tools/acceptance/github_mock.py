"""A fake GitHub for the full tester's GitHub copy scenario (ADR-0209). Made-up data only; never the real GitHub.

The host makes the fixture with `prepare` before the installation starts: the made-up repository example-org/widgets
as a bare copy served over dumb HTTP, and a fine-grained fixture token built from parts at run time, in a 0600 file.
The model fixture mounts that folder read-only and serves, each behind the file's token:

- the REST calls github.py makes (`/github/api/...`), with the token's expiry header;
- the repository's files for git's dumb HTTP (`/github/git/...`), behind Basic auth as `x-access-token`;
- `/fixture/github`: which requests came, whether each carried the token, how many requests elsewhere on the model
  fixture held it or the key committed in notes.txt (none should: the model and Telegram see neither), and
  `{revoked}`, which makes every GitHub call answer 401.

The token is read from the file at each request, so the fixture starts even before its folder is readable, and no
answer or record holds it.
"""
import base64
import os
import re
import secrets
import shutil
import stat
import time
from pathlib import Path

LOGIN = 'octo-example'
# The fixture's repository: <root>/git/<owner>/<name>.git.
PATH = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}')


def fixture_token():
    """A fine-grained token shape, built from parts so no literal in the repository looks like one."""
    return 'github_' + 'pat_' + 'FIXTURE' + secrets.token_hex(16)


def classic_token():
    """A classic token shape for the copy's notes.txt; the guard must mask it whenever a job reads it."""
    return 'gh' + 'p_' + 'y' * 36


def prepare(root):
    """On the host, before the installation renders: the served bare copy and the token file. Returns the token and
    the tip commit."""
    from services.hermes.repo_fixture import made, served
    root = Path(root)
    work = root.parent / (root.name + '-work')
    root.mkdir(mode=0o700)
    try:
        repository, commit = made(work, notes=b'NOTESMARK ' + classic_token().encode() + b'\n')
        served(repository, root / 'git')
    finally:
        shutil.rmtree(work, ignore_errors=True)
    token = fixture_token()
    path = root / 'token'
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
        file.write(token)
    return token, commit


class GithubMock:
    def __init__(self, root):
        self.root = Path(root)
        self.revoked = False
        self.requests = []
        # Requests to the model fixture outside /github whose body or query held the token, or the committed key.
        self.elsewhere = 0
        self.committed = 0

    def token(self):
        try:
            return (self.root / 'token').read_text().strip() or None
        except OSError:
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

    def allowed(self, header, basic=False):
        """Whether an Authorization header carries the file's token: Bearer for the API, Basic for git."""
        token = self.token()
        if self.revoked or not token or not isinstance(header, str):
            return False
        if basic:
            if not header.startswith('Basic '):
                return False
            try:
                _, _, password = base64.b64decode(header[6:], validate=True).decode().partition(':')
            except ValueError:
                return False
            return secrets.compare_digest(password, token)
        return header.startswith('Bearer ') and secrets.compare_digest(header[7:], token)

    def seen(self, request, authorized):
        self.requests.append({'at': time.time(), 'method': request.method, 'path': request.url.path,
                              'authorized': authorized, 'scheme': (request.headers.get('authorization') or ' ').split(' ')[0] or None})

    def install(self, app):
        from fastapi import Request
        from fastapi.responses import JSONResponse, Response

        def refused():
            return JSONResponse({'message': 'Bad credentials'}, status_code=401)

        def missing():
            return JSONResponse({'message': 'Not Found'}, status_code=404)

        @app.middleware('http')
        async def watch(request: Request, call_next):
            # Only the GitHub routes may ever see the token. Neither it nor the key in the copy's notes.txt, which the
            # guard masks, may reach the model or Telegram.
            if not request.url.path.startswith('/github/'):
                token, body, query = self.token(), await request.body(), str(request.url.query)
                if token and (token in query or token.encode() in body):
                    self.elsewhere += 1
                if classic_token() in query or classic_token().encode() in body:
                    self.committed += 1
            return await call_next(request)

        @app.get('/github/api/user')
        async def user(request: Request):
            authorized = self.allowed(request.headers.get('authorization'))
            self.seen(request, authorized)
            if not authorized:
                return refused()
            expires = time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(time.time() + 90 * 86400))
            return JSONResponse({'login': LOGIN, 'id': 1}, headers={'github-authentication-token-expiration': expires})

        @app.get('/github/api/user/repos')
        async def repos(request: Request):
            authorized = self.allowed(request.headers.get('authorization'))
            self.seen(request, authorized)
            if not authorized:
                return refused()
            page = request.query_params.get('page', '1')
            return JSONResponse([self.describe(full, folder) for full, folder in self.repositories()] if page == '1' else [])

        @app.get('/github/api/repos/{owner}/{name}')
        async def repo(owner: str, name: str, request: Request):
            authorized = self.allowed(request.headers.get('authorization'))
            self.seen(request, authorized)
            if not authorized:
                return refused()
            folder = self.repository(owner, name)
            return JSONResponse(self.describe(owner + '/' + name, folder)) if folder else missing()

        @app.get('/github/api/repos/{owner}/{name}/commits/{branch:path}')
        async def commit(owner: str, name: str, branch: str, request: Request):
            authorized = self.allowed(request.headers.get('authorization'))
            self.seen(request, authorized)
            if not authorized:
                return refused()
            folder = self.repository(owner, name)
            tip = self.tip(folder, branch) if folder else None
            if not tip or request.headers.get('accept') != 'application/vnd.github.sha':
                return missing()
            return Response(tip, media_type='application/vnd.github.sha')

        @app.get('/github/git/{path:path}')
        async def files(path: str, request: Request):
            authorized = self.allowed(request.headers.get('authorization'), basic=True)
            self.seen(request, authorized)
            if not authorized:
                return Response('Unauthorized', status_code=401, headers={'WWW-Authenticate': 'Basic realm="fixture"'})
            if not PATH.fullmatch(path) or '..' in path.split('/'):
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
            return {'requests': self.requests, 'revoked': self.revoked, 'elsewhere': self.elsewhere, 'committed': self.committed}

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

