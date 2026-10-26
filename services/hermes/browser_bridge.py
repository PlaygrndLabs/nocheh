"""Native browser chat bridge: the PTY command for Nocheh's browser TUI.

Hermes 0.22.5's TUI reaches its gateway only over a WebSocket. This process runs Nocheh's stdio
browser gateway, serves one token-guarded loopback socket that relays the legacy newline JSON-RPC
wire to and from it, and runs the TUI on the PTY with HERMES_TUI_GATEWAY_URL pointing at that socket.
"""
import asyncio
import collections
import hmac
import json
import os
import secrets
import sys
from http import HTTPStatus

ROOT = '/opt/hermes'
TUI = ('/usr/local/bin/node', '/opt/hermes/ui-tui/dist/entry.js')
GATEWAY = (sys.executable, '-m', 'services.hermes.browser_gateway')
# Above browser_gateway's own 36 MiB request bound, so oversized input gets its typed error.
FRAME_LIMIT = 40 * 1024 * 1024


def is_ready(line):
    try: return json.loads(line).get('params', {}).get('type') == 'gateway.ready'
    except (ValueError, AttributeError): return False


class Bridge:
    """One gateway process at a time; a reconnect gets the ready frame again, a dead gateway is restarted."""

    def __init__(self, gateway=GATEWAY, cwd=ROOT):
        self.argv, self.cwd = tuple(gateway), cwd
        self.process = None; self.connection = None; self.greeted = None
        self.ready = None; self.pending = collections.deque()
        self.lock = asyncio.Lock()

    async def start(self):
        env = dict(os.environ)
        # Same boundary the TUI used when it spawned the gateway itself: Hermes source first, and a
        # cwd that workspace files cannot shadow.
        env['PYTHONPATH'] = ROOT + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
        env['HERMES_PYTHON_SRC_ROOT'] = ROOT
        env.pop('HERMES_TUI_GATEWAY_URL', None)
        self.ready, self.greeted = None, None; self.pending.clear()
        process = self.process = await asyncio.create_subprocess_exec(*self.argv, cwd=self.cwd, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=FRAME_LIMIT)
        asyncio.create_task(self.supervise(process))

    async def supervise(self, process):
        await asyncio.gather(self.relay(process, process.stdout, False), self.relay(process, process.stderr, True),
                             return_exceptions=True)
        await process.wait()
        if self.process is process and self.connection is not None:
            await self.connection.close(1011, 'gateway exited')

    async def relay(self, process, stream, stderr):
        while line := await stream.readline():
            if self.process is not process: return
            text = line.decode('utf-8', 'replace').rstrip('\r\n')
            if stderr:
                text = json.dumps({'jsonrpc': '2.0', 'method': 'event',
                                   'params': {'type': 'gateway.stderr', 'payload': {'line': text[-4096:]}}})
            elif self.ready is None and is_ready(text):
                self.ready = text; await self.flush(); continue
            self.pending.append(text); await self.flush()

    async def flush(self):
        from websockets.exceptions import ConnectionClosed
        async with self.lock:
            connection = self.connection
            if connection is None or self.ready is None: return
            try:
                if self.greeted is not connection:
                    await connection.send(self.ready); self.greeted = connection
                while self.pending:
                    await connection.send(self.pending[0]); self.pending.popleft()
            except ConnectionClosed: pass

    async def handle(self, connection):
        from websockets.exceptions import ConnectionClosed
        if self.process is None or self.process.returncode is not None: await self.start()
        previous, self.connection = self.connection, connection
        if previous is not None: await previous.close(1012, 'replaced')
        await self.flush()
        process = self.process
        try:
            async for message in connection:
                data = message.encode() if isinstance(message, str) else message
                process.stdin.write(data.rstrip(b'\r\n') + b'\n')
                await process.stdin.drain()
        except (ConnectionClosed, ConnectionResetError, BrokenPipeError): pass
        finally:
            if self.connection is connection: self.connection = None

    async def stop(self):
        process = self.process
        if process is None or process.returncode is not None: return
        process.stdin.close()
        try: await asyncio.wait_for(process.wait(), 15)
        except TimeoutError:
            process.kill(); await process.wait()


async def run(tui=TUI, gateway=GATEWAY, cwd=ROOT):
    from websockets.asyncio.server import serve
    path = '/' + secrets.token_urlsafe(32)
    bridge = Bridge(gateway, cwd)

    def admit(connection, request):
        if not hmac.compare_digest(request.path.encode(), path.encode()):
            return connection.respond(HTTPStatus.FORBIDDEN, 'forbidden\n')

    async with serve(bridge.handle, '127.0.0.1', 0, process_request=admit, max_size=FRAME_LIMIT,
                     compression=None, ping_interval=None) as server:
        port = next(iter(server.sockets)).getsockname()[1]
        await bridge.start()
        # The gateway already mirrors every event to the sidebar; an attached TUI would mirror them twice.
        env = {key: value for key, value in os.environ.items() if key != 'HERMES_TUI_SIDECAR_URL'}
        env['HERMES_TUI_GATEWAY_URL'] = f'ws://127.0.0.1:{port}{path}'
        try:
            code = await (await asyncio.create_subprocess_exec(*tui, env=env)).wait()
        finally:
            await bridge.stop()
    return code if code >= 0 else 128 - code


if __name__ == '__main__': sys.exit(asyncio.run(run()))
