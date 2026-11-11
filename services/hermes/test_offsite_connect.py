import base64
import hashlib
import json
import re
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from services.hermes.test_offsite import Bucket
from tools.operations.installation import offsite, offsite_connect
from tools.operations.installation.configuration import initialize, load
from tools.operations.installation.settings import revision, save, view

ACCOUNT = 'a' * 32
OTHER_ACCOUNT = 'b' * 32
SETUP = 'cfat_example-setup-token-value'


class Cloudflare(BaseHTTPRequestHandler):
    """A small stand-in for the parts of Cloudflare's API the connect flow uses."""
    accounts, tokens, buckets, locks, calls = [], {}, set(), {}, []
    r2_on, can_mint, minted = True, True, 0

    def log_message(self, *args):
        pass

    def _answer(self, code, result=None, errors=()):
        body = json.dumps({'success': code < 400, 'result': result, 'errors': [{'code': c, 'message': m} for c, m in errors]}).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def _route(self, method):
        path = urllib.parse.urlsplit(self.path).path.removeprefix('/client/v4')
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'null')
        token = self.headers.get('Authorization', '').removeprefix('Bearer ')
        Cloudflare.calls.append((method, path, body))
        if token not in Cloudflare.tokens: return self._answer(400, errors=[(6111, 'Invalid format for Authorization header')])
        if method == 'GET' and path == '/accounts': return self._answer(200, Cloudflare.accounts)
        found = re.fullmatch(r'/accounts/([0-9a-f]{32})(/.*)', path)
        if not found: return self._answer(404, errors=[(7003, 'No route')])
        account, rest = found.groups()
        if rest == '/tokens/verify': return self._answer(200, {'id': Cloudflare.tokens[token]['id'], 'status': 'active'})
        if rest == '/r2/buckets' and method == 'POST':
            if not Cloudflare.r2_on: return self._answer(403, errors=[(10042, 'Please enable R2 through the Cloudflare Dashboard.')])
            if body['name'] in Cloudflare.buckets: return self._answer(409, errors=[(10004, 'The bucket you tried to create already exists.')])
            Cloudflare.buckets.add(body['name']); return self._answer(200, {'name': body['name']})
        if rest.startswith('/r2/buckets/'):
            bucket = rest.split('/')[3]
            if bucket not in Cloudflare.buckets: return self._answer(404, errors=[(10006, 'The specified bucket does not exist.')])
            if rest.endswith('/lock'):
                if method == 'PUT': Cloudflare.locks[bucket] = body['rules']; return self._answer(200, {})
                return self._answer(200, {'rules': Cloudflare.locks.get(bucket, [])})
            return self._answer(200, {'name': bucket})
        if rest.startswith('/tokens/permission_groups'):
            if not Cloudflare.can_mint: return self._answer(403, errors=[(10000, 'Authentication error')])
            return self._answer(200, [{'id': 'g-zone', 'name': 'Zone Read'}, {'id': 'g-write', 'name': 'Workers R2 Storage Bucket Item Write'},
                                      {'id': 'g-read', 'name': 'Workers R2 Storage Bucket Item Read'}])
        if rest == '/tokens' and method == 'POST':
            Cloudflare.minted += 1; value = f'minted-value-{Cloudflare.minted}'
            Cloudflare.tokens[value] = {'id': f'minted-{Cloudflare.minted}', 'policies': body['policies']}
            return self._answer(200, {'id': f'minted-{Cloudflare.minted}', 'value': value})
        if rest.startswith('/tokens/') and method == 'DELETE':
            gone = rest.split('/')[2]
            for value, row in list(Cloudflare.tokens.items()):
                if row['id'] == gone: del Cloudflare.tokens[value]
            return self._answer(200, {'id': gone})
        return self._answer(404, errors=[(7003, 'No route')])

    def do_GET(self): self._route('GET')
    def do_POST(self): self._route('POST')
    def do_PUT(self): self._route('PUT')
    def do_DELETE(self): self._route('DELETE')


class Backblaze(BaseHTTPRequestHandler):
    answer = {}

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.headers.get('Authorization') != 'Basic ' + base64.b64encode(b'0041example:K004secret').decode():
            self.send_response(401); self.send_header('Content-Length', '0'); self.end_headers(); return
        body = json.dumps(Backblaze.answer).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)


def serve(handler):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class ConnectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.servers = [serve(Cloudflare), serve(Bucket), serve(Backblaze)]

    @classmethod
    def tearDownClass(cls):
        for server in cls.servers: server.shutdown(); server.server_close()

    def setUp(self):
        cloudflare, bucket, backblaze = (server.server_port for server in self.servers)
        Cloudflare.accounts = [{'id': ACCOUNT, 'name': 'Example home'}]
        Cloudflare.tokens = {SETUP: {'id': 'setup-id'}}
        Cloudflare.buckets, Cloudflare.locks, Cloudflare.calls = set(), {}, []
        Cloudflare.r2_on, Cloudflare.can_mint, Cloudflare.minted = True, True, 0
        Bucket.objects.clear(); Bucket.uploads.clear(); Bucket.requests.clear()
        self.folder = tempfile.TemporaryDirectory(); self.state = Path(self.folder.name); initialize(self.state)
        storage = f'http://127.0.0.1:{bucket}'

        class Redirected(offsite.Storage):
            """Sends the storage test to the local stand-in; the saved address stays the real one."""
            def __init__(self, config, opener=None): super().__init__({**config, 'endpoint': storage}, opener)

        self.patches = [patch.object(offsite_connect, 'CLOUDFLARE_API', f'http://127.0.0.1:{cloudflare}/client/v4'),
                        patch.object(offsite_connect, 'BACKBLAZE_AUTHORIZE', f'http://127.0.0.1:{backblaze}/b2api/v4/b2_authorize_account'),
                        patch.object(offsite_connect, 'Storage', Redirected),
                        patch.dict('os.environ', {'NO_PROXY': '127.0.0.1', 'no_proxy': '127.0.0.1'})]
        for item in self.patches: item.start()
        self.waits = []

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.folder.cleanup()

    def connect(self, **request):
        return offsite_connect.cloudflare(self.state, request.get('token', SETUP), request.get('account'), wait=self.waits.append)

    def test_one_token_makes_the_bucket_a_bucket_only_key_and_the_lock_then_deletes_itself(self):
        result = self.connect()
        self.assertEqual({key: result[key] for key in ('status', 'bucket', 'account', 'lock_days', 'setup_token_deleted')},
                         {'status': 'connected', 'bucket': 'nocheh-backups', 'account': 'Example home', 'lock_days': 7, 'setup_token_deleted': True})
        values = load(self.state)
        self.assertEqual(values['NOCHEH_OFFSITE_PROVIDER'], 'cloudflare')
        self.assertEqual(values['NOCHEH_OFFSITE_ENDPOINT'], f'https://{ACCOUNT}.r2.cloudflarestorage.com')
        self.assertEqual((values['NOCHEH_OFFSITE_BUCKET'], values['NOCHEH_OFFSITE_REGION']), ('nocheh-backups', 'auto'))
        # Cloudflare's S3 keys: the token id, and the SHA-256 of its value.
        self.assertEqual(values['NOCHEH_OFFSITE_ACCESS_KEY_ID'], 'minted-1')
        self.assertEqual(values['NOCHEH_OFFSITE_SECRET_ACCESS_KEY'], hashlib.sha256(b'minted-value-1').hexdigest())
        # Off-site copies stay off until the owner saves a passphrase.
        self.assertEqual(values['NOCHEH_OFFSITE'], 'off')
        # The new key reaches objects in this one bucket only.
        policy = Cloudflare.tokens['minted-value-1']['policies']
        self.assertEqual(policy, [{'effect': 'allow', 'permission_groups': [{'id': 'g-write'}, {'id': 'g-read'}],
                                   'resources': {f'com.cloudflare.edge.r2.bucket.{ACCOUNT}_default_nocheh-backups': '*'}}])
        self.assertEqual(Cloudflare.locks['nocheh-backups'], [{'id': 'nocheh-copies', 'enabled': True, 'prefix': offsite.PREFIX,
                                                               'condition': {'type': 'Age', 'maxAgeSeconds': 7 * 86400}}])
        self.assertNotIn(SETUP, Cloudflare.tokens)
        # The storage test wrote, read back and removed one object with the new key.
        self.assertEqual(Bucket.objects, {})
        self.assertEqual([method for method, _, _ in Bucket.requests], ['PUT', 'GET', 'DELETE'])
        self.assertTrue(all(auth.startswith('AWS4-HMAC-SHA256 Credential=minted-1/') for _, auth, _ in Bucket.requests))
        # No answer, record or setting carries the setup token.
        self.assertNotIn(SETUP, json.dumps(result)); self.assertNotIn(SETUP, Path(self.state, '.env').read_text())

    def test_connecting_again_keeps_the_bucket_and_the_owners_rules_and_retires_the_old_key(self):
        self.connect()
        Cloudflare.locks['nocheh-backups'].insert(0, {'id': 'owner-rule', 'enabled': True, 'condition': {'type': 'Indefinite'}})
        Cloudflare.tokens['cfat_second-setup'] = {'id': 'setup-2'}
        self.connect(token='cfat_second-setup')
        self.assertEqual([rule['id'] for rule in Cloudflare.locks['nocheh-backups']], ['owner-rule', 'nocheh-copies'])
        self.assertEqual(load(self.state)['NOCHEH_OFFSITE_ACCESS_KEY_ID'], 'minted-2')
        self.assertEqual(sorted(row['id'] for row in Cloudflare.tokens.values()), ['minted-2'])

    def test_several_accounts_ask_which_one(self):
        Cloudflare.accounts = [{'id': ACCOUNT, 'name': 'Example home'}, {'id': OTHER_ACCOUNT, 'name': 'Example work'}]
        before = view(self.state)['revision']
        self.assertEqual(self.connect(), {'status': 'choose_account', 'accounts': Cloudflare.accounts})
        self.assertEqual(view(self.state)['revision'], before)
        with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_cloudflare_account_invalid'): self.connect(account='c' * 32)
        self.assertEqual(self.connect(account=OTHER_ACCOUNT)['status'], 'connected')
        self.assertEqual(load(self.state)['NOCHEH_OFFSITE_ENDPOINT'], f'https://{OTHER_ACCOUNT}.r2.cloudflarestorage.com')

    def test_a_token_that_lists_no_account_needs_the_account_id(self):
        Cloudflare.accounts = []
        with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_cloudflare_account_needed'): self.connect()
        self.assertEqual(self.connect(account=ACCOUNT)['status'], 'connected')

    def test_refusals_say_what_to_fix_and_save_nothing(self):
        before = view(self.state)['revision']
        for change, code in ((lambda: None, 'offsite_cloudflare_token_refused'),
                             (lambda: setattr(Cloudflare, 'r2_on', False), 'offsite_cloudflare_r2_off'),
                             (lambda: (setattr(Cloudflare, 'r2_on', True), setattr(Cloudflare, 'can_mint', False)), 'offsite_cloudflare_needs_token_permission')):
            change()
            with self.assertRaisesRegex(offsite.OffsiteError, code):
                self.connect(token='cfat_unknown' if code.endswith('refused') else SETUP)
        with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_cloudflare_token_invalid'): self.connect(token='two words')
        self.assertEqual(view(self.state)['revision'], before)
        self.assertIn(SETUP, Cloudflare.tokens)

    def test_a_new_key_is_retried_until_it_works_and_removed_when_it_never_does(self):
        original, refusals = Bucket.do_PUT, []

        def slow(handler):
            if len(refusals) < 2:
                refusals.append(1); handler._parts(); handler._body()
                return handler._send(403, b'<Error><Code>InvalidAccessKeyId</Code></Error>')
            return original(handler)
        with patch.object(Bucket, 'do_PUT', slow): self.assertEqual(self.connect()['status'], 'connected')
        self.assertEqual(self.waits, [2, 3])
        Cloudflare.tokens['cfat_second-setup'] = {'id': 'setup-2'}
        before = view(self.state)['revision']
        refuse = lambda handler: (handler._parts(), handler._body(), handler._send(403, b'<Error><Code>AccessDenied</Code></Error>'))
        with patch.object(Bucket, 'do_PUT', refuse):
            with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_storage_AccessDenied'): self.connect(token='cfat_second-setup')
        self.assertEqual(view(self.state)['revision'], before)
        # The key that never worked is deleted; the saved one and the unused setup token stay.
        self.assertEqual(sorted(row['id'] for row in Cloudflare.tokens.values()), ['minted-1', 'setup-2'])

    def test_backblaze_reads_the_address_and_bucket_from_a_bucket_only_key(self):
        Backblaze.answer = {'accountId': 'example', 'apiInfo': {'storageApi': {
            's3ApiUrl': 'https://s3.us-west-004.backblazeb2.com',
            'allowed': {'buckets': [{'id': 'b1', 'name': 'example-backups'}], 'capabilities': ['listFiles', 'readFiles', 'writeFiles', 'deleteFiles']}}}}
        result = offsite_connect.backblaze(self.state, '0041example', 'K004secret', wait=self.waits.append)
        self.assertEqual((result['status'], result['bucket']), ('connected', 'example-backups'))
        values = load(self.state)
        self.assertEqual([values[key] for key in ('NOCHEH_OFFSITE_PROVIDER', 'NOCHEH_OFFSITE_ENDPOINT', 'NOCHEH_OFFSITE_BUCKET', 'NOCHEH_OFFSITE_REGION',
                                                  'NOCHEH_OFFSITE_ACCESS_KEY_ID', 'NOCHEH_OFFSITE_SECRET_ACCESS_KEY')],
                         ['backblaze', 'https://s3.us-west-004.backblazeb2.com', 'example-backups', 'us-west-004', '0041example', 'K004secret'])
        self.assertNotIn('K004secret', json.dumps({key: value for key, value in result.items() if key != 'settings'}))
        self.assertNotIn('K004secret', json.dumps(result['settings']))

    def test_backblaze_refuses_a_key_for_every_bucket_a_read_only_key_and_a_wrong_key(self):
        before = view(self.state)['revision']
        everything = {'apiInfo': {'storageApi': {'s3ApiUrl': 'https://s3.us-west-004.backblazeb2.com',
                                                 'allowed': {'buckets': None, 'capabilities': ['listFiles', 'readFiles', 'writeFiles']}}}}
        reading = {'apiInfo': {'storageApi': {'s3ApiUrl': 'https://s3.us-west-004.backblazeb2.com',
                                              'allowed': {'bucketName': 'example-backups', 'capabilities': ['listFiles', 'readFiles']}}}}
        for answer, key, code in ((everything, 'K004secret', 'key_not_limited'), (reading, 'K004secret', 'key_read_only'), (reading, 'K004wrong', 'key_refused')):
            Backblaze.answer = answer
            with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_backblaze_' + code):
                offsite_connect.backblaze(self.state, '0041example', key, wait=self.waits.append)
        self.assertEqual(view(self.state)['revision'], before)

    def test_the_dashboard_operation_routes_each_provider(self):
        with patch.object(offsite_connect, 'cloudflare', return_value={'status': 'connected'}) as cloudflare:
            offsite_connect.connect(self.state, {'provider': 'cloudflare', 'token': SETUP, 'account': ''})
        cloudflare.assert_called_once_with(self.state, SETUP, None)
        with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_provider_unknown'): offsite_connect.connect(self.state, {'provider': 'ftp'})

    def test_other_settings_saved_meanwhile_are_kept(self):
        save(self.state, {'NOCHEH_OFFSITE_KEEP': '7'}, revision(load(self.state)))
        self.connect()
        self.assertEqual(load(self.state)['NOCHEH_OFFSITE_KEEP'], '7')


if __name__ == '__main__':
    unittest.main()
