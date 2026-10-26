"""Browser chat bridge tests with a stand-in gateway and TUI; no Hermes process runs."""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from .browser_bridge import run

GATEWAY = r'''
import json, os, sys
sys.stderr.write('booting\n'); sys.stderr.flush()
print(json.dumps({'jsonrpc': '2.0', 'method': 'event', 'params': {'type': 'gateway.ready', 'payload': {}}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request['method'] == 'exit': sys.exit(0)
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': {
        'method': request['method'], 'cwd': os.getcwd(), 'path': os.environ['PYTHONPATH'].split(os.pathsep)[0],
        'url': os.environ.get('HERMES_TUI_GATEWAY_URL'), 'pid': os.getpid(),
        'sidecar': os.environ.get('HERMES_TUI_SIDECAR_URL')}}), flush=True)
'''

TUI = r'''
import asyncio, json, os, sys
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

async def frames(ws, count):
    return [json.loads(await ws.recv()) for _ in range(count)]

async def main():
    url = os.environ['HERMES_TUI_GATEWAY_URL']; seen = {'sidecar': os.environ.get('HERMES_TUI_SIDECAR_URL')}
    try:
        async with connect(url + 'x'): seen['forged'] = 'open'
    except InvalidStatus as error: seen['forged'] = error.response.status_code
    async with connect(url) as ws:
        seen['first'] = await frames(ws, 2)
        await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'session.create', 'params': {}}))
        seen['reply'] = await frames(ws, 1)
    async with connect(url) as ws:
        seen['again'] = await frames(ws, 1)
        await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'session.resume', 'params': {}}))
        seen['resumed'] = await frames(ws, 1)
        await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 3, 'method': 'exit', 'params': {}}))
        try: await ws.recv()
        except ConnectionClosed as closed: seen['closed'] = closed.rcvd.code
    async with connect(url) as ws:
        seen['restarted'] = await frames(ws, 2)
        await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 4, 'method': 'session.resume', 'params': {}}))
        seen['restarted'] += await frames(ws, 1)
    open(sys.argv[1], 'w').write(json.dumps(seen))

asyncio.run(main()); sys.exit(3)
'''


class BrowserBridgeTests(unittest.TestCase):
    def test_relays_the_legacy_wire_to_the_stdio_gateway(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / 'seen.json'
            with patch.dict(os.environ, {'HERMES_TUI_SIDECAR_URL': 'ws://127.0.0.1:8785/api/pub'}):
                code = asyncio.run(asyncio.wait_for(run((sys.executable, '-c', TUI, str(out)), (sys.executable, '-c', GATEWAY), temp), 60))
            self.assertEqual(code, 3)
            seen = json.loads(out.read_text())
        self.assertEqual(seen['forged'], 403)
        ready, stderr = seen['first']
        self.assertEqual(ready['params']['type'], 'gateway.ready')
        self.assertEqual(stderr['params'], {'type': 'gateway.stderr', 'payload': {'line': 'booting'}})
        reply = seen['reply'][0]['result']
        self.assertEqual(reply['method'], 'session.create')
        self.assertEqual((os.path.realpath(reply['cwd']), reply['path'], reply['url']), (os.path.realpath(temp), '/opt/hermes', None))
        # Only the gateway mirrors events to the sidebar.
        self.assertEqual((reply['sidecar'], seen['sidecar']), ('ws://127.0.0.1:8785/api/pub', None))
        # A reconnect is greeted again by the same gateway process.
        self.assertEqual(seen['again'][0]['params']['type'], 'gateway.ready')
        self.assertEqual(seen['resumed'][0]['id'], 2)
        # A gateway that exits closes the socket; the next connection gets a fresh gateway.
        self.assertEqual(seen['closed'], 1011)
        self.assertEqual([frame.get('params', {}).get('type') for frame in seen['restarted'][:2]], ['gateway.ready', 'gateway.stderr'])
        self.assertNotEqual(seen['restarted'][2]['result']['pid'], seen['resumed'][0]['result']['pid'])


if __name__ == '__main__': unittest.main()
