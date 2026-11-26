"""A fake Notion and a fake Gmail for the full tester's connector scenarios. Made-up data only; never the real services.

The model fixture serves them where an installation with NOCHEH_INSTALLATION_FIXTURE=1 sends Notion and Gmail calls
(tools/operations/connections/fixture.py):

- `/notion/mcp`: Notion's hosted MCP server as Nocheh speaks to it, stateless JSON-RPC: initialize, the initialized
  notice, tools/list and tools/call for a few read tools and two change tools. Each request needs a Bearer token the
  tester named on `/fixture/notion`; any other is refused with 401. Every page a token reads carries that token's mark,
  so a reply shows whose Notion it came from.
- `/gmail/token`, `/gmail/revoke` and the mailbox under `/gmail/gmail/v1`: Google's code and refresh exchanges and the
  Gmail reads Nocheh makes (profile, a search, a message, a thread). Mail carries the mark the tester set.
- `/fixture/notion` and `/fixture/gmail`: GET answers the requests that came, in order; POST sets the tokens and marks,
  and empties the list.
"""
import base64
import json
import secrets

NOTION_READS = ('notion-search', 'notion-fetch', 'notion-get-self')
NOTION_CHANGES = ('notion-create-pages', 'notion-update-page')
GMAIL_CODE = 'fixture-gmail-code'
GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
GMAIL_MESSAGE, GMAIL_THREAD = 'msgfixture01', 'thrfixture01'


def schema(**properties):
    return {'type': 'object', 'properties': properties}


NOTION_TOOLS = [
    {'name': 'notion-search', 'description': 'Search the made-up workspace.', 'inputSchema': schema(query={'type': 'string'})},
    {'name': 'notion-fetch', 'description': 'Read one made-up page.', 'inputSchema': schema(id={'type': 'string'})},
    {'name': 'notion-get-self', 'description': 'Who this sign-in is.', 'inputSchema': schema()},
    {'name': 'notion-create-pages', 'description': 'Add made-up pages.', 'inputSchema': schema(pages={'type': 'array'})},
    {'name': 'notion-update-page', 'description': 'Change a made-up page.', 'inputSchema': schema(page_id={'type': 'string'})},
]


class ConnectorsMock:
    def __init__(self):
        # token -> the mark its pages carry.
        self.notion = {}
        self.gmail = {'mark': None, 'access': set(), 'refresh': set()}
        self.requests = {'notion': [], 'gmail': []}

    @staticmethod
    def bearer(request):
        value = request.headers.get('authorization') or ''
        return value[7:] if value.startswith('Bearer ') else None

    def notion_answer(self, token, tool, arguments):
        mark = self.notion[token]
        page = {'id': '0' * 31 + '1', 'title': 'Made-up plan ' + mark, 'text': 'The made-up plan for the week. ' + mark}
        if tool == 'notion-search':
            return {'results': [{'id': page['id'], 'title': page['title']}], 'query': arguments.get('query')}
        if tool == 'notion-fetch':
            return page
        if tool == 'notion-get-self':
            return {'user': {'name': 'Made-up ' + mark, 'email': 'someone@example.com'}}
        return {'ok': True, 'changed': tool, 'mark': mark}

    def install(self, app):
        from fastapi import Request
        from fastapi.responses import JSONResponse, Response

        def refused():
            return JSONResponse({'error': 'unauthorized'}, status_code=401)

        @app.post('/notion/mcp')
        async def notion_mcp(request: Request):
            token = self.bearer(request)
            try:
                body = json.loads(await request.body() or b'{}')
            except ValueError:
                body = {}
            method = body.get('method') if isinstance(body, dict) else None
            params = body.get('params') or {} if isinstance(body, dict) else {}
            seen = {'method': method, 'known': token in self.notion, 'token': token}
            if method == 'tools/call':
                seen.update(tool=params.get('name'), input=params.get('arguments'))
            self.requests['notion'].append(seen)
            if token not in self.notion:
                return refused()
            if method == 'notifications/initialized':
                return Response(status_code=202)
            if method == 'initialize':
                result = {'protocolVersion': '2025-11-25', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'notion-fixture', 'version': '1'}}
            elif method == 'tools/list':
                result = {'tools': NOTION_TOOLS}
            elif method == 'tools/call' and params.get('name') in NOTION_READS + NOTION_CHANGES:
                found = self.notion_answer(token, params['name'], params.get('arguments') or {})
                result = {'content': [{'type': 'text', 'text': json.dumps(found)}], 'structuredContent': found, 'isError': False}
            elif method == 'tools/call':
                result = {'content': [{'type': 'text', 'text': 'Unknown tool'}], 'isError': True}
            else:
                return JSONResponse({'jsonrpc': '2.0', 'id': body.get('id'), 'error': {'code': -32601, 'message': 'Method not found'}})
            return JSONResponse({'jsonrpc': '2.0', 'id': body.get('id'), 'result': result})

        @app.post('/gmail/token')
        async def gmail_token(request: Request):
            from urllib.parse import parse_qs
            form = {key: values[0] for key, values in parse_qs((await request.body()).decode()).items()}
            grant = form.get('grant_type')
            self.requests['gmail'].append({'path': '/token', 'grant': grant})
            if grant == 'authorization_code' and form.get('code') == GMAIL_CODE and form.get('code_verifier'):
                refresh = 'gmail-refresh-' + secrets.token_hex(8)
                self.gmail['refresh'].add(refresh)
            elif grant == 'refresh_token' and form.get('refresh_token') in self.gmail['refresh']:
                refresh = None
            else:
                return JSONResponse({'error': 'invalid_grant'}, status_code=400)
            access = 'gmail-access-' + secrets.token_hex(8)
            self.gmail['access'].add(access)
            return {'access_token': access, 'expires_in': 3599, 'scope': GMAIL_SCOPE, 'token_type': 'Bearer',
                    **({'refresh_token': refresh} if refresh else {})}

        @app.post('/gmail/revoke')
        async def gmail_revoke(request: Request):
            self.requests['gmail'].append({'path': '/revoke'})
            return {}

        @app.get('/gmail/gmail/v1/{kind}/{mailbox}/{rest:path}')
        async def gmail_read(kind: str, mailbox: str, rest: str, request: Request):
            token = self.bearer(request)
            # Gmail names the signed-in account's own mailbox 'me'; Nocheh reads no other.
            known = token in self.gmail['access'] and kind == 'users' and mailbox == 'me'
            self.requests['gmail'].append({'path': '/' + rest, 'query': str(request.url.query), 'known': known})
            if not known:
                return refused()
            mark = self.gmail['mark'] or 'GMAILMARK'
            headers = [{'name': 'From', 'value': 'Someone <someone@example.com>'}, {'name': 'To', 'value': 'owner@example.com'},
                       {'name': 'Subject', 'value': 'Made-up invoice ' + mark}, {'name': 'Date', 'value': 'Mon, 2 Mar 2026 09:00:00 +0000'}]
            text = base64.urlsafe_b64encode(('The made-up invoice is due Friday. ' + mark).encode()).decode().rstrip('=')
            message = {'id': GMAIL_MESSAGE, 'threadId': GMAIL_THREAD, 'labelIds': ['INBOX'], 'snippet': 'The made-up invoice ' + mark,
                       'payload': {'mimeType': 'text/plain', 'headers': headers, 'body': {'data': text}}}
            if rest == 'profile':
                return {'emailAddress': 'owner@example.com'}
            if rest == 'messages':
                return {'messages': [{'id': GMAIL_MESSAGE, 'threadId': GMAIL_THREAD}], 'resultSizeEstimate': 1}
            if rest == 'messages/' + GMAIL_MESSAGE:
                return message
            if rest == 'threads/' + GMAIL_THREAD:
                return {'id': GMAIL_THREAD, 'messages': [message]}
            return JSONResponse({'error': {'code': 404, 'message': 'Not Found'}}, status_code=404)

        @app.get('/fixture/notion')
        def notion_seen():
            return {'requests': self.requests['notion']}

        @app.post('/fixture/notion')
        async def notion_set(request: Request):
            body = json.loads(await request.body() or b'{}')
            self.notion = {str(token): str(mark) for token, mark in (body.get('tokens') or {}).items()}
            self.requests['notion'] = []
            return {'ok': True}

        @app.get('/fixture/gmail')
        def gmail_seen():
            return {'requests': self.requests['gmail']}

        @app.post('/fixture/gmail')
        async def gmail_set(request: Request):
            body = json.loads(await request.body() or b'{}')
            self.gmail['mark'] = body.get('mark')
            self.requests['gmail'] = []
            return {'ok': True}
