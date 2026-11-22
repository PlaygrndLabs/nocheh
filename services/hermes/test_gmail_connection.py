"""The owner's own Gmail: the Personal mode client, the sign-in, and the three read-only lookups (ADR-0272)."""
import base64
import io
import json
import stat
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
from pathlib import Path

from tools.operations.connections import gmail

ADDRESS = 'http://localhost:8783/?connect=gmail'
CLIENT = '123456789012-abcdef0123456789.apps.googleusercontent.com'


def encoded(text): return base64.urlsafe_b64encode(text.encode()).decode().rstrip('=')


def refused(code, body):
    return urllib.error.HTTPError('https://example.invalid', code, 'refused', {}, io.BytesIO(json.dumps(body).encode()))


class GmailTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.addCleanup(self.folder.cleanup)
        self.state = Path(self.folder.name); self.calls = []; self.reads = []

    def post(self, url, body):
        self.calls.append((url, body))
        if body.get('grant_type') == 'authorization_code':
            return {'access_token': 'access-1', 'refresh_token': 'refresh-1', 'expires_in': 3599, 'scope': gmail.SCOPE}
        if body.get('grant_type') == 'refresh_token':
            return {'access_token': 'access-2', 'expires_in': 3599}
        return {}

    def get(self, url, token):
        path = url[len(gmail.API):]; self.reads.append((path, token))
        if path == '/profile': return {'emailAddress': 'owner@example.com'}
        if path.startswith('/messages?'):
            return {'messages': [{'id': 'msg00001', 'threadId': 'thr00001'}], 'resultSizeEstimate': 1}
        if path.startswith('/messages/msg00001?format=metadata'):
            return {'id': 'msg00001', 'threadId': 'thr00001', 'snippet': 'The made-up invoice &amp; notes',
                    'payload': {'headers': [{'name': 'From', 'value': 'Someone <someone@example.com>'}, {'name': 'Subject', 'value': 'Invoice'}]}}
        full = {'id': 'msg00001', 'threadId': 'thr00001', 'labelIds': ['INBOX'], 'payload': {
            'mimeType': 'multipart/mixed', 'headers': [{'name': 'Subject', 'value': 'Invoice'}], 'parts': [
                {'mimeType': 'multipart/alternative', 'parts': [
                    {'mimeType': 'text/html', 'body': {'data': encoded('<p>Hello <b>there</b></p>')}},
                    {'mimeType': 'text/plain', 'body': {'data': encoded('Hello there\n' + 'x' * 30000)}}]},
                {'mimeType': 'application/pdf', 'filename': 'invoice.pdf', 'body': {'attachmentId': 'att', 'size': 1234}}]}}
        if path == '/messages/msg00001?format=full': return full
        if path == '/threads/thr00001?format=full': return {'id': 'thr00001', 'messages': [full, full, full, full]}
        raise refused(404, {})

    def connect(self):
        gmail.save_client(self.state, ' ' + CLIENT + ' ', 'secret-value-1')
        url = urllib.parse.urlsplit(gmail.start(self.state, ADDRESS)['url'])
        query = dict(urllib.parse.parse_qsl(url.query))
        gmail.finish(self.state, 'code-1', query['state'], post=self.post, get=self.get)
        return query

    def test_sign_in_uses_the_owners_client_pkce_and_offline_access_and_never_shows_secrets(self):
        with self.assertRaises(ValueError) as caught: gmail.start(self.state, ADDRESS)
        self.assertEqual(str(caught.exception), 'gmail_client_missing')
        for client, secret in (('not-a-client', 'secret-value-1'), (CLIENT, 'short'), (CLIENT, 'has space here')):
            with self.assertRaises(ValueError): gmail.save_client(self.state, client, secret)
        query = self.connect()
        self.assertEqual((query['client_id'], query['redirect_uri'], query['scope'], query['access_type'], query['code_challenge_method']),
                         (CLIENT, ADDRESS, gmail.SCOPE, 'offline', 'S256'))
        exchange = self.calls[-1][1]
        self.assertEqual((exchange['client_secret'], exchange['redirect_uri']), ('secret-value-1', ADDRESS))
        shown = gmail.status(self.state)
        self.assertEqual((shown['client'], shown['connected'], shown['email']), (CLIENT, True, 'owner@example.com'))
        self.assertNotIn('secret-value-1', json.dumps(shown)); self.assertNotIn('refresh-1', json.dumps(shown))
        self.assertEqual(stat.S_IMODE(gmail.path(self.state).stat().st_mode), 0o600)
        for address in ('http://example.com/?connect=gmail', 'https://example.com/?connect=notion', 'https://example.com/x?connect=gmail'):
            with self.assertRaises(ValueError): gmail.start(self.state, address)

    def test_a_sign_in_without_mail_reading_or_an_old_state_is_refused(self):
        gmail.save_client(self.state, CLIENT, 'secret-value-1')
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(gmail.start(self.state, ADDRESS)['url']).query))
        with self.assertRaises(ValueError) as caught: gmail.finish(self.state, 'code-1', 'another-state', post=self.post, get=self.get)
        self.assertEqual(str(caught.exception), 'gmail_sign_in_expired')
        narrow = lambda url, body: {'access_token': 'a', 'refresh_token': 'r', 'scope': 'openid'}
        with self.assertRaises(ValueError) as caught: gmail.finish(self.state, 'code-1', query['state'], post=narrow, get=self.get)
        self.assertEqual(str(caught.exception), 'gmail_scope_missing')
        self.assertFalse(gmail.status(self.state)['connected'])

    def test_a_new_client_forgets_the_sign_in_and_disconnect_revokes_it(self):
        self.connect()
        gmail.save_client(self.state, CLIENT, 'secret-value-2')
        self.assertTrue(gmail.status(self.state)['connected'], 'the same client keeps the sign-in')
        gmail.save_client(self.state, '999999999999-zzzz.apps.googleusercontent.com', 'secret-value-3')
        self.assertFalse(gmail.status(self.state)['connected'])
        self.connect(); gmail.disconnect(self.state, post=self.post)
        self.assertEqual(self.calls[-1], (gmail.REVOKE, {'token': 'refresh-1'}))
        self.assertFalse(gmail.status(self.state)['connected'])

    def test_the_access_token_is_refreshed_and_a_refused_refresh_asks_to_connect_again(self):
        self.connect()
        self.assertEqual(gmail.bearer(self.state, post=self.post), 'access-1')
        self.assertEqual(gmail.bearer(self.state, post=self.post, now=lambda: time.time() + 4000), 'access-2')
        saved = gmail.read(self.state)['grant']; self.assertEqual(saved['refresh_token'], 'refresh-1', 'Google keeps the refresh token')
        def gone(url, body): raise refused(400, {'error': 'invalid_grant'})
        with self.assertRaises(ValueError) as caught: gmail.bearer(self.state, post=gone, now=lambda: time.time() + 8000)
        self.assertEqual(str(caught.exception), 'gmail_reconnect_needed')
        self.assertTrue(gmail.status(self.state)['reconnect'])

    def look(self, tool, **given):
        return gmail.lookup(self.state, {'connection': 'gmail', 'tool': tool, 'input': given}, post=self.post, get=self.get)['response']

    def test_lookups_search_read_a_message_and_read_a_thread_small(self):
        self.connect()
        found = self.look('search_mail', query='from:someone@example.com')
        self.assertEqual(found['messages'], [{'id': 'msg00001', 'thread': 'thr00001', 'from': 'Someone <someone@example.com>',
                                              'subject': 'Invoice', 'snippet': 'The made-up invoice & notes'}])
        self.assertIn('q=from%3Asomeone%40example.com', self.reads[-2][0])
        message = self.look('read_message', id='msg00001')
        self.assertTrue(message['text'].startswith('Hello there')); self.assertEqual(len(message['text']), gmail.MESSAGE_TEXT)
        self.assertTrue(message['cut'])
        self.assertEqual(message['attachments'], [{'name': 'invoice.pdf', 'type': 'application/pdf', 'size': 1234}])
        thread = self.look('read_thread', id='thr00001')
        self.assertEqual(sum(len(row['text']) for row in thread['messages']), gmail.THREAD_TEXT)
        self.assertTrue(thread['cut'])
        self.assertTrue(all(token == 'access-1' for _, token in self.reads[1:]))

    def test_a_bad_input_sends_nothing_and_google_errors_come_back_plain(self):
        self.connect(); before = len(self.reads)
        for tool, given in (('search_mail', {'query': 'a\nb'}), ('search_mail', {}), ('read_message', {'id': '../x'}), ('nothing', {})):
            with self.assertRaises(ValueError) as caught: self.look(tool, **given)
            self.assertEqual(str(caught.exception), 'invalid_gmail_lookup', (tool, given))
        self.assertEqual(len(self.reads), before)
        with self.assertRaises(ValueError) as caught: self.look('read_message', id='missing1')
        self.assertEqual(str(caught.exception), 'gmail_message_not_found')
        def off(url, token): raise refused(403, {'error': {'status': 'PERMISSION_DENIED', 'details': [{'reason': 'SERVICE_DISABLED'}]}})
        with self.assertRaises(ValueError) as caught:
            gmail.lookup(self.state, {'connection': 'gmail', 'tool': 'read_message', 'input': {'id': 'msg00001'}}, post=self.post, get=off)
        self.assertEqual(str(caught.exception), 'gmail_api_off')

    def test_html_only_mail_is_made_plain(self):
        text, files = gmail.body_of({'mimeType': 'text/html', 'body': {'data': encoded('<style>x{}</style><p>One &amp; two</p><br>Three')}})
        self.assertNotIn('x{}', text); self.assertIn('One & two', text); self.assertEqual(files, [])


if __name__ == '__main__':
    unittest.main()
