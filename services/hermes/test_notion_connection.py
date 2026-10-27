"""The owner's Notion sign-in and Notion calls through its MCP server."""
import io
import json
import stat
import tempfile
import unittest
import urllib.error
import urllib.parse
from pathlib import Path

from tools.operations.connections import notion
from tools.operations.security.tool_execution import execute, mcp_call

ADDRESS = 'http://127.0.0.1:8783/?connect=notion'


class NotionSignInTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.addCleanup(self.folder.cleanup)
        self.state = Path(self.folder.name); self.calls = []

    def post(self, url, body, form=True):
        self.calls.append((url, body))
        if url == notion.REGISTER: return {'client_id': 'client-1'}
        if body.get('grant_type') == 'authorization_code':
            return {'access_token': 'access-1', 'refresh_token': 'refresh-1', 'expires_in': 28800, 'workspace_name': 'Home'}
        if body.get('grant_type') == 'refresh_token':
            return {'access_token': 'access-2', 'refresh_token': 'refresh-2', 'expires_in': 28800}
        return {}

    def sign_in(self):
        url = urllib.parse.urlsplit(notion.start(self.state, ADDRESS, post=self.post)['url'])
        query = dict(urllib.parse.parse_qsl(url.query))
        notion.finish(self.state, 'code-1', query['state'], post=self.post)
        return query

    def test_sign_in_registers_once_uses_pkce_and_never_shows_tokens(self):
        query = self.sign_in()
        self.assertEqual((query['client_id'], query['redirect_uri'], query['code_challenge_method']), ('client-1', ADDRESS, 'S256'))
        exchange = self.calls[-1][1]
        self.assertEqual((exchange['code'], exchange['redirect_uri']), ('code-1', ADDRESS))
        self.assertEqual(len(exchange['code_verifier']), 43)
        self.assertNotIn('access', json.dumps(notion.status(self.state)))
        self.assertEqual(notion.status(self.state)['workspace'], 'Home')
        self.assertEqual(stat.S_IMODE(notion.path(self.state).stat().st_mode), 0o600)
        notion.start(self.state, ADDRESS, post=self.post)
        self.assertEqual([url for url, _ in self.calls].count(notion.REGISTER), 1, 'registering again would orphan the sign-in')

    def test_only_the_dashboard_return_address_and_the_latest_sign_in_are_accepted(self):
        for address in ('http://192.168.1.4:8783/?connect=notion', 'http://127.0.0.1:8783/?connect=other', 'https://evil.example/x?connect=notion'):
            with self.subTest(address=address), self.assertRaisesRegex(ValueError, 'invalid_notion_redirect'):
                notion.start(self.state, address, post=self.post)
        notion.start(self.state, ADDRESS, post=self.post)
        with self.assertRaisesRegex(ValueError, 'notion_sign_in_expired'):
            notion.finish(self.state, 'code-1', 'forged', post=self.post)

    def test_refresh_saves_each_new_token_and_an_ended_grant_asks_to_connect_again(self):
        self.sign_in()
        self.assertEqual(notion.bearer(self.state, post=self.post), 'access-1')
        later = lambda: 10 ** 12
        self.assertEqual(notion.bearer(self.state, post=self.post, now=later), 'access-2')
        self.assertEqual(json.loads(notion.path(self.state).read_text())['grant']['refresh_token'], 'refresh-2')
        def ended(url, body, form=True):
            raise urllib.error.HTTPError(url, 400, 'Bad Request', {}, io.BytesIO(b'{"error":"invalid_grant"}'))
        with self.assertRaisesRegex(ValueError, 'notion_reconnect_needed'):
            notion.bearer(self.state, post=ended, now=later)
        self.assertEqual((notion.status(self.state)['connected'], notion.status(self.state)['reconnect']), (False, True))
        with self.assertRaisesRegex(ValueError, 'notion_reconnect_needed'):
            notion.bearer(self.state, post=self.post)

    def test_a_token_is_checked_when_saved_and_disconnect_forgets_and_revokes(self):
        def refuse(token): raise ValueError('notion_token_refused')
        with self.assertRaisesRegex(ValueError, 'notion_token_refused'):
            notion.save_token(self.state, 'ntn_wrong', check=refuse)
        self.assertEqual(notion.save_token(self.state, ' ntn_right ', check=lambda token: None)['method'], 'token')
        self.assertEqual(notion.bearer(self.state, post=self.post, now=lambda: 10 ** 12), 'ntn_right', 'a token does not expire on its own')
        self.sign_in()
        self.assertFalse(notion.disconnect(self.state, post=self.post)['connected'])
        self.assertEqual(self.calls[-1][1]['token'], 'refresh-1')
        with self.assertRaisesRegex(ValueError, 'notion_not_connected'):
            notion.bearer(self.state, post=self.post)

    def test_calls_go_only_to_notion_with_the_owner_sign_in_and_read_streamed_replies(self):
        notion.save_token(self.state, 'ntn_owner', check=lambda token: None)
        seen = []
        def remote(url, body, headers):
            seen.append((url, body.get('method'), headers.get('Authorization'), headers.get('MCP-Protocol-Version')))
            if body['method'] == 'initialize':
                return json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {'protocolVersion': '2025-06-18'}}).encode(), {'content-type': 'application/json'}
            if body['method'] == 'notifications/initialized': return b'', {}
            stream = ('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n'
                      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"found"}]}}\n\n')
            return stream.encode(), {'content-type': 'text/event-stream'}
        result = mcp_call({'connection': 'notion', 'tool': 'notion-search', 'input': {'query': 'books'}}, remote, self.state)
        self.assertEqual(result, {'response': {'content': [{'type': 'text', 'text': 'found'}]}, 'protocol': '2025-06-18'})
        self.assertEqual({url for url, *_ in seen}, {notion.MCP_URL})
        self.assertEqual({auth for _, _, auth, _ in seen}, {'Bearer ntn_owner'})
        self.assertEqual(seen[-1][3], '2025-06-18')
        def refused(url, body, headers): raise RuntimeError('remote_unauthorized')
        self.assertEqual(execute(self.state, {'kind': 'mcp', 'arguments': {'connection': 'notion', 'operation': 'list'}}, refused),
                         {'exit_code': 1, 'error': 'notion_reconnect_needed'})
        notion.disconnect(self.state)
        self.assertEqual(execute(self.state, {'kind': 'mcp', 'arguments': {'connection': 'notion', 'operation': 'list'}}, remote),
                         {'exit_code': 1, 'error': 'notion_not_connected'}, 'nothing is sent without a sign-in')


if __name__ == '__main__': unittest.main()
