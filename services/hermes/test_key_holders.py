"""Who holds which key (ADR-0295): Nocheh's master key stays in Nocheh's own services, Hermes and the launcher hold the
agent login, and only Hermes holds its dashboard's session token.

This checks Compose environments only. hermes-agent-sb runs as root with the Docker socket and can read other containers'
configuration (and with it SERVICE_TOKEN), and the dashboard and executor read .env; a
Docker API proxy for the launcher comes later."""
import json
import os
import re
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HOLDERS = {'SERVICE_TOKEN': {'nocheh-app', 'nocheh-security', 'nocheh-telegram'},
           'AGENT_KEY': {'nocheh-app', 'nocheh-security', 'hermes', 'hermes-agent-sb'},
           'NOCHEH_HERMES_SESSION_TOKEN': {'hermes'}}
KEY = 'holder-test-agent-key-not-a-real-credential'


def environment(service):
    value = service.get('environment') or {}
    return dict(item.split('=', 1) if '=' in item else (item, '') for item in value) if isinstance(value, list) else value


def services(*names):
    """The services of these Compose files merged as Compose merges them, by service and environment name. The dev file's
    `!reset` and `!override` tags touch no environment here; an `!override` environment would replace, as in Compose."""
    import yaml
    class Loader(yaml.SafeLoader): pass
    Loader.add_constructor('!reset', lambda loader, node: None)
    Loader.add_constructor('!override', lambda loader, node: {'!override': loader.construct_mapping(node, deep=True)}
                           if isinstance(node, yaml.MappingNode) else loader.construct_sequence(node, deep=True))
    merged = {}
    for name in names:
        for service, value in (yaml.load((ROOT / name).read_text(), Loader=Loader).get('services') or {}).items():
            current = merged.setdefault(service, {'environment': {}})
            added = (value or {}).get('environment')
            if isinstance(added, dict) and '!override' in added: current['environment'] = environment({'environment': added['!override']})
            else: current['environment'] = {**current['environment'], **environment(value or {})}
    return merged


class KeyHolderTests(unittest.TestCase):
    def test_each_key_reaches_exactly_its_holders(self):
        import yaml
        compose = yaml.safe_load((ROOT / 'docker-compose.yml').read_text())
        for files in (('docker-compose.yml',), ('docker-compose.yml', 'docker-compose.dev.yml')):
            found = services(*files)
            for key, holders in HOLDERS.items():
                with self.subTest(files=files, key=key):
                    self.assertEqual({name for name, service in found.items() if key in service['environment']}, holders)
        # Explicit entries, never the shared anchor that every Nocheh service merges.
        self.assertNotIn('AGENT_KEY', compose['x-service']['environment'])
        self.assertIn('SERVICE_TOKEN', compose['x-service']['environment'])
        for name in HOLDERS['AGENT_KEY']:
            self.assertEqual(compose['services'][name]['environment']['AGENT_KEY'], '${AGENT_KEY:?Run ./bin/nocheh up}')
        self.assertEqual(compose['services']['hermes']['environment']['NOCHEH_HERMES_SESSION_TOKEN'],
                         '${NOCHEH_HERMES_SESSION_TOKEN:?Run ./bin/nocheh up}')

    def test_no_hermes_code_reads_the_master_key(self):
        reads = re.compile(r'''(secret|environment_secret)\(\s*['"]SERVICE_TOKEN|environ\[\s*['"]SERVICE_TOKEN|'''
                           r'''environ\.get\(\s*['"]SERVICE_TOKEN|getenv\(\s*['"]SERVICE_TOKEN''')
        sources = [path for path in sorted((ROOT / 'services/hermes').glob('*.py')) if not path.name.startswith('test_')]
        self.assertTrue(sources)
        for path in sources:
            self.assertIsNone(reads.search(path.read_text()), path.name)
        # It minted passes with the master key and posted to Nocheh as its admin.
        self.assertFalse((ROOT / 'services/hermes/verify_assistant.py').exists())
        from . import native_admin
        self.assertFalse(hasattr(native_admin, 'audience_revision'), '/v1/memory/spaces has no handler and is no agent route')

    def test_hermes_calls_nocheh_with_the_agent_login(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def answer(self):
                length = int(self.headers.get('Content-Length') or 0)
                if length: self.rfile.read(length)
                seen.append((self.command, self.path, self.headers.get('Authorization')))
                data = json.dumps({'labels': {}, 'revision': 'r', 'retired': [], 'answered': {}, 'retired_records': [],
                                   'profiles': [], 'state': 'local', 'carry': False}).encode()
                self.send_response(200); self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
            do_GET = do_POST = answer
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        url = 'http://127.0.0.1:%d' % server.server_port
        from . import environment as keys
        from .native_admin import Administration
        from .scheduler import Scheduler
        from .managed_async import ManagedAsync
        from .runtime_profiles import ProfileCatalog
        from .note_sources import service_post
        from .profile_notes import service_post as notes_carry
        from .retired_history import service_lookup
        from .request_boundary import guard_rpc
        from .scopes import Scopes
        from services.chats import Served
        try:
            with tempfile.TemporaryDirectory() as folder, \
                 patch.dict(os.environ, {'AGENT_KEY': KEY, 'ARCHIVE_URL': url, 'GUARD_URL': url, 'NOCHEH_RUNTIME_HOME': folder,
                                         'NO_PROXY': '*', 'no_proxy': '*'}), patch.object(keys, '_AGENT_KEY', None):
                for name in ('SERVICE_TOKEN', 'HTTP_PROXY', 'http_proxy'): os.environ.pop(name, None)
                policy = Scopes({'enabled': False}, Served.of('42'))
                admin = Administration(None, folder, 'model', policy, keys.agent_key())
                Scheduler(admin, lambda: None).call('runs', {})
                managed = ManagedAsync(admin, lambda: None)
                try: managed.http('claim', {}, 'background')
                finally: managed.stop()
                ProfileCatalog(folder, policy, admin.agent_key).http('/v1/runtime/profiles')
                with patch.dict(os.environ, {'NOCHEH_STORAGE_LAYOUT': 'original-only-v1'}):
                    self.assertEqual(Administration(None, folder, 'model', policy, KEY).profile_catalog.agent_key, KEY)
                service_post({}); service_lookup([]); notes_carry({})
                try: guard_rpc('model', {})
                except Exception: pass
        finally: server.shutdown(); server.server_close(); thread.join()
        self.assertEqual({path for _, path, _ in seen}, {'/v1/scheduler/runs', '/v1/background/claim', '/v1/runtime/profiles',
                                                         '/internal/notes/sources', '/internal/sources/retired', '/internal/notes/carry',
                                                         '/v1/guard'})
        self.assertEqual({authorization for _, _, authorization in seen}, {'Bearer ' + KEY})


if __name__ == '__main__': unittest.main()
