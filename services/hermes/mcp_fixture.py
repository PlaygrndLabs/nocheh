"""A made-up Nocheh MCP endpoint for the Hermes tests: stateless JSON-RPC over HTTP, as Nocheh serves at /mcp.

It lists Nocheh's data tools with plain object schemas and answers every call with ``answer(name, arguments)``
(by default ``{}``), so a test can connect the real Hermes MCP client the way a turn does.
"""
import contextlib
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# The bare names Nocheh's MCP server lists; Hermes offers each one as mcp__nocheh__<name>.
TOOLS = ('archive_search', 'archive_read', 'archive_page', 'memory_search', 'memory_recall', 'action_request', 'background_job',
         'telegram_destinations', 'shell', 'browser', 'mcp', 'owner_read', 'tasks', 'notion', 'action_status', 'knowledge_inspect',
         'knowledge_propose', 'knowledge_status')
NAMES = frozenset('mcp__nocheh__' + name for name in TOOLS)


class Endpoint:
    def __init__(self, answer=None, tools=TOOLS):
        self.answer = answer or (lambda name, arguments: {})
        self.tools, self.requests = tools, []
        endpoint = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, status, value=None):
                body = b'' if value is None else json.dumps(value).encode()
                self.send_response(status)
                if value is not None:
                    self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def refuse(self):
                # Nocheh's endpoint is POST only; a probe or stream request is recorded and refused.
                endpoint.requests.append({'method': self.command, 'authorization': self.headers.get('authorization'),
                                          'deadline': self.headers.get('x-nocheh-turn-deadline')})
                self.send(405)

            do_GET = do_HEAD = do_DELETE = refuse

            def do_POST(self):
                if self.path != '/mcp':
                    return self.send(404)
                message = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
                endpoint.requests.append({'method': message.get('method'), 'authorization': self.headers.get('authorization'),
                                          'deadline': self.headers.get('x-nocheh-turn-deadline'), 'params': message.get('params')})
                if 'id' not in message:
                    return self.send(202)
                self.send(200, {'jsonrpc': '2.0', 'id': message['id'], **endpoint.result(message.get('method'), message.get('params') or {})})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = 'http://127.0.0.1:%d' % self.server.server_address[1]

    def result(self, method, params):
        if method == 'initialize':
            return {'result': {'protocolVersion': '2025-11-25', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'nocheh', 'version': 'test'}}}
        if method == 'ping':
            return {'result': {}}
        if method == 'tools/list':
            return {'result': {'tools': [{'name': name, 'description': 'Synthetic ' + name.replace('_', ' ') + '.',
                                          'inputSchema': {'type': 'object', 'properties': {}}} for name in self.tools]}}
        if method == 'tools/call':
            value = self.answer(params.get('name'), params.get('arguments') or {})
            return {'result': {'content': [{'type': 'text', 'text': value if isinstance(value, str) else json.dumps(value)}], 'isError': False}}
        return {'error': {'code': -32601, 'message': 'Method not found'}}

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


@contextlib.contextmanager
def connected(answer=None, tools=TOOLS, credential='turn.synthetic', deadline=None):
    """Nocheh's data tools in this process's Hermes registry, connected the way a turn connects them; disconnected after."""
    import time
    from unittest.mock import patch
    from .assistant_turn import connect_data_tools, disconnect_data_tools
    with Endpoint(answer, tools) as endpoint, patch.dict(os.environ, {'ARCHIVE_URL': endpoint.url}):
        try:
            connect_data_tools(credential, deadline or time.time() + 120)
            yield endpoint
        finally:
            disconnect_data_tools()
