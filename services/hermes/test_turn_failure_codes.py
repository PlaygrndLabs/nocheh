import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from . import mcp_fixture


def sse(event, data):
    return f'event: {event}\ndata: {json.dumps(data)}\n\n'.encode()


START = [
    sse('message_start', {'type': 'message_start', 'message': {
        'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'model': 'synthetic', 'content': [],
        'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 10, 'output_tokens': 1}}}),
    sse('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
    sse('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 'The weather'}}),
]
END = [
    sse('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
    sse('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 5}}),
    sse('message_stop', {'type': 'message_stop'}),
]


def broker(script, guard):
    """A stand-in for Nocheh's security broker on the Anthropic Messages route and for its secret check.
    Model calls are answered as scripted: 'drop' streams the start of an answer and then cuts the connection, as the
    broker does when the safety epoch moves on mid-answer; 'ok' streams a whole answer. Secret checks are answered as
    scripted too: 'pass' returns the payload guarded; ('json', status, body) is the secret check's refusal."""
    calls = []
    checks = []

    class Broker(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def do_GET(self):
            body = json.dumps({'data': [{'id': 'synthetic', 'type': 'model', 'max_input_tokens': 200000}], 'has_more': False}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get('content-length', 0)))
            if self.path == '/v1/guard':
                action = guard[min(len(checks), len(guard) - 1)]
                checks.append(action)
                status, body = (200, {'guarded': True, 'payload': json.loads(raw)['payload']}) if action[0] == 'pass' else (action[1], action[2])
                body = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            action = script[min(len(calls), len(script) - 1)]
            calls.append(action)
            self.send_response(200)
            self.send_header('content-type', 'text/event-stream')
            self.send_header('transfer-encoding', 'chunked')
            self.end_headers()
            for part in START + ([] if action[0] == 'drop' else END):
                self.wfile.write(b'%x\r\n' % len(part) + part + b'\r\n')
                self.wfile.flush()
            if action[0] == 'drop':
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()

    server = ThreadingHTTPServer(('127.0.0.1', 0), Broker)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, calls, checks


# One reply turn in its own process, as in production: the real secret check call, against the stand-in's
# /v1/guard, and Nocheh's usage codes as the turn reports them.
CHILD = ("import sys\nfrom unittest.mock import patch\n"
         "from services.hermes import archive_tools,assistant_turn,subscription\n"
         "with patch.object(subscription,'BROKER_ANTHROPIC_URL',sys.argv[1]),"
         "patch.object(archive_tools,'request',lambda path,value:value if path=='/v1/context/prepare' else {'hits':[]}):\n"
         "    assistant_turn.main()\n")


class TurnFailureCodeTests(unittest.TestCase):
    def turn(self, script, guard, tools=mcp_fixture.TOOLS, down=False):
        server, calls, checks = broker(script, guard)
        root = Path(__file__).resolve().parents[2]
        url = 'http://127.0.0.1:%d' % server.server_address[1]
        try:
            with tempfile.TemporaryDirectory() as folder, mcp_fixture.Endpoint(tools=tools) as endpoint:
                profile = Path(folder) / 'profile'
                (profile / 'native-state').mkdir(parents=True)
                (profile / 'memories').mkdir()
                if down:
                    endpoint.server.shutdown()
                    endpoint.server.server_close()
                body = {'session_id': 's', 'chat_id': '-20', 'user_id': '5', 'owner': True, 'text': 'weather?', 'channel': 'telegram',
                        'memory_context': 'evidence', 'model': 'synthetic', 'api_key': 'synthetic', 'stream': True,
                        'base_url': url + '/anthropic', 'provider': 'anthropic', 'api_mode': 'anthropic_messages',
                        'archive_credential': 'turn.synthetic', 'turn_deadline_epoch': time.time() + 120}
                process = subprocess.run([sys.executable, '-c', CHILD, url + '/anthropic'], input=json.dumps(body), cwd=root,
                                         env={**os.environ, 'HERMES_HOME': str(profile), 'GUARD_URL': url, 'ARCHIVE_URL': endpoint.url},
                                         capture_output=True, text=True, timeout=240)
                self.assertEqual(process.returncode, 0, process.stderr[-3000:])
                # Hermes writes some notices to the terminal itself; the turn's own lines are JSON.
                lines = [json.loads(line) for line in process.stdout.splitlines() if line.startswith('{')]
                return lines[-1], calls, checks
        finally:
            server.shutdown()
            server.server_close()

    def test_a_reply_cut_off_by_a_new_safety_epoch_is_a_stop_not_a_provider_error(self):
        # The owner saves a memory while a reply streams: the safety epoch moves on, the broker cuts the old epoch's
        # answer, and the secret check refuses the turn's next call. The provider client reports that refusal as a lost
        # connection, and Hermes names it by the secret check's 409 as a malformed request. It is no provider error:
        # Nocheh runs the reply again in the new epoch.
        # The broker answers guard_transition_pending while the new epoch is being published, audience_context_changed for a
        # turn of the old epoch once it is, and guard_context_changed when it is published during the check itself.
        for code in ('audience_context_changed', 'guard_transition_pending', 'guard_context_changed'):
            with self.subTest(code=code):
                changed = ('json', 409, {'error': code})
                result, calls, checks = self.turn([('drop',)], [('pass',), changed])
                self.assertEqual(result['state'], 'failed')
                self.assertEqual((calls, checks[:2]), ([('drop',)], [('pass',), changed]), 'nothing of the old epoch reached the provider again')
                self.assertEqual(result['failure_reason'], 'context_changed')
                self.assertNotIn('failure_cause', result)

    def test_a_refused_secret_check_names_nochehs_own_error(self):
        result, calls, checks = self.turn([('ok',)], [('json', 409, {'error': 'detector_contract_rejected'})])
        self.assertEqual((result['state'], calls), ('failed', []))
        self.assertEqual((result['failure_reason'], result.get('failure_cause')), ('nocheh_error', 'detector_contract_rejected'))

    def test_a_turn_without_nochehs_data_tools_stops_before_the_model(self):
        # Nocheh's endpoint is down, or it lists fewer tools than the turn expects: the turn names the cause and no model call runs.
        for case in ({'down': True}, {'tools': mcp_fixture.TOOLS[:-1]}):
            with self.subTest(**case):
                started = time.monotonic()
                result, calls, checks = self.turn([('ok',)], [('pass',)], **case)
                self.assertEqual((result['state'], result['error_code'], calls, checks), ('failed', 'data_tools_unavailable', [], []))
                self.assertEqual((result['failure_reason'], result.get('failure_cause')), ('nocheh_error', 'data_tools_unavailable'))
                self.assertLess(time.monotonic() - started, 60)

    def test_a_turn_that_answered_keeps_no_failure(self):
        result, calls, checks = self.turn([('ok',)], [('pass',)])
        self.assertEqual((result['state'], calls), ('done', [('ok',)]))
        self.assertNotIn('failure_reason', result)


if __name__ == '__main__':
    unittest.main()
