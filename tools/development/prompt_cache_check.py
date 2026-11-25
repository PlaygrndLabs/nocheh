"""How much of a chat's replies Anthropic's prompt cache would read, measured on real Hermes turns (ADR-0307).

Each reply runs Hermes in its own process, as a sealed turn does, against a local stand-in for Anthropic's Messages API
that keeps a prompt cache by Anthropic's rules: a request reads the longest start, ending at a cache mark or up to 20
blocks before one, that an earlier request wrote and that has not expired; it writes up to its last mark, for five
minutes or an hour as the mark says. The clock is simulated, so pauses between replies cost no waiting. Requests go
through Nocheh's request boundary and memory evidence as in a reply, with an identity secret check. No key, no network.

Run with the Hermes environment of the Hermes Python tests, from the repository root:

  PYTHONPATH=<hermes checkout>:. <hermes venv>/bin/python -m tools.development.prompt_cache_check \\
      --ttl auto --placement after --gaps 0,60,600,120,1800,90,2400,60,200,45 --forwards 3,6

It prints one line per model call and a total: input tokens read, written and sent uncached, the share read, and the
input cost in token-units (uncached 1, read 0.1, five-minute write 1.25, one-hour write 2). Token counts are estimated
at four characters a token. `--placement first --ttl 5m --no-steady-schedules --forwards ...` reproduces the layout
before ADR-0307. The stand-in model answers in text and never calls a tool.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TTL_SECONDS = {'5m': 300, '1h': 3600}
LOOKBACK = 20


def tokens(value):
    return max(1, len(json.dumps(value, ensure_ascii=False, sort_keys=True)) // 4)


def blocks(payload):
    """The request as Anthropic reads it, block by block: tools, system, then each message's blocks."""
    out = []
    for tool in payload.get('tools') or []:
        out.append(({k: v for k, v in tool.items() if k != 'cache_control'}, tool.get('cache_control')))
    system = payload.get('system')
    for block in [{'type': 'text', 'text': system}] if isinstance(system, str) else system or []:
        out.append(({k: v for k, v in block.items() if k != 'cache_control'}, block.get('cache_control')))
    for message in payload.get('messages') or []:
        content = message.get('content')
        for block in [{'type': 'text', 'text': content}] if isinstance(content, str) else content or []:
            out.append(({'role': message['role'], **{k: v for k, v in block.items() if k != 'cache_control'}},
                        block.get('cache_control')))
    return out


class Cache:
    """Anthropic's prompt cache, by prefix hash, on a simulated clock."""

    def __init__(self):
        self.now = 0.0
        self.entries = {}
        self.calls = []

    def request(self, payload, turn):
        digest = hashlib.sha256(json.dumps({'model': payload.get('model'), 'tool_choice': payload.get('tool_choice'),
                                            'thinking': payload.get('thinking')}, sort_keys=True).encode())
        hashes, sizes, marks, size = [], [], [], 0
        for index, (block, mark) in enumerate(blocks(payload)):
            digest.update(json.dumps(block, ensure_ascii=False, sort_keys=True).encode())
            size += tokens(block)
            hashes.append(digest.copy().hexdigest()); sizes.append(size)
            if mark:
                marks.append((index, mark.get('ttl', '5m')))
        read_at = -1
        for index, _ in marks:
            for back in range(index, max(-1, index - LOOKBACK - 1), -1):
                if self.entries.get(hashes[back], -1) >= self.now:
                    read_at = max(read_at, back); break
        last = max((index for index, _ in marks), default=-1)
        read = sizes[read_at] if read_at >= 0 else 0
        write = sizes[last] - read if last > read_at else 0
        for index, ttl in marks:
            if index >= read_at or hashes[index] in self.entries:
                self.entries[hashes[index]] = max(self.entries.get(hashes[index], 0), self.now + TTL_SECONDS.get(ttl, 300))
        ttl = sorted({ttl for _, ttl in marks})
        self.calls.append({'turn': turn, 'total': size, 'read': read, 'write': write, 'uncached': size - read - write, 'ttl': ttl})
        return read, write, size - read - write


def serve(cache, state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            if not self.path.rstrip('/').endswith('/v1/messages') or 'model' not in body:
                self.send_response(404); self.send_header('content-length', '0'); self.end_headers()
                return
            read, write, uncached = cache.request(body, state['turn'])
            usage = {'input_tokens': uncached, 'output_tokens': 5, 'cache_read_input_tokens': read,
                     'cache_creation_input_tokens': write}
            text = f"answer {state['turn']} " + 'with the points the person asked about ' * 30
            message = {'id': 'msg_check', 'type': 'message', 'role': 'assistant', 'model': body['model'],
                       'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn', 'stop_sequence': None, 'usage': usage}
            if not body.get('stream'):
                data = json.dumps(message).encode()
                self.send_response(200); self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(data))); self.end_headers(); self.wfile.write(data)
                return
            self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers()
            for name, data in (
                    ('message_start', {'type': 'message_start', 'message': {**message, 'content': [], 'stop_reason': None}}),
                    ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                    ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}}),
                    ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                    ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 5}}),
                    ('message_stop', {'type': 'message_stop'})):
                self.wfile.write(f'event: {name}\ndata: {json.dumps(data)}\n\n'.encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--ttl', default='auto', choices=['5m', '1h', 'auto'])
    parser.add_argument('--placement', default='after', choices=['first', 'after'])
    parser.add_argument('--gaps', default='0,60,600,120,1800,90,2400,60,200,45', help='seconds before each reply')
    parser.add_argument('--forwards', default='', help='replies (from 1) to a forwarded message, which may not set a schedule')
    parser.add_argument('--steady-schedules', action=argparse.BooleanOptionalAction, default=True,
                        help='a forward keeps the schedule tool (ADR-0307); --no-steady-schedules drops it, as before')
    parser.add_argument('--memory', default='changing', choices=['none', 'same', 'changing'])
    parser.add_argument('--scale', type=int, default=3, help='size of memory and messages')
    args = parser.parse_args()
    cache, state = Cache(), {'turn': 0}
    server = serve(cache, state)
    forwards = {int(n) for n in args.forwards.split(',') if n}
    now = 0.0
    with tempfile.TemporaryDirectory(prefix='nocheh-cache-check-') as home:
        for turn, gap in enumerate((float(n) for n in args.gaps.split(',')), 1):
            now += gap; cache.now = now; state['turn'] = turn
            schedules = args.steady_schedules or turn not in forwards
            env = {**os.environ, 'HERMES_HOME': home, 'CHECK_CLOCK': str(now), 'CHECK_TURN': str(turn),
                   'CHECK_URL': f'http://127.0.0.1:{server.server_address[1]}/anthropic', 'CHECK_TTL': args.ttl,
                   'CHECK_PLACEMENT': args.placement, 'CHECK_MEMORY': args.memory, 'CHECK_SCALE': str(args.scale),
                   'CHECK_SCHEDULES': '1' if schedules else '0'}
            done = subprocess.run([sys.executable, '-m', 'tools.development.prompt_cache_check', '--reply'], cwd=ROOT, env=env,
                                  capture_output=True, text=True, timeout=300)
            if done.returncode:
                sys.stderr.write(done.stdout[-2000:] + done.stderr[-4000:]); raise SystemExit(1)
    server.shutdown()
    for call in cache.calls:
        print(json.dumps(call))
    total = {name: sum(call[name] for call in cache.calls) for name in ('total', 'read', 'write', 'uncached')}
    cost = sum(c['uncached'] + .1 * c['read'] + (2 if c['ttl'] == ['1h'] else 1.25) * c['write'] for c in cache.calls)
    print(json.dumps({'ttl': args.ttl, 'placement': args.placement, 'forwards': sorted(forwards),
                      'steady_schedules': args.steady_schedules, **total,
                      'read_share': round(total['read'] / max(1, total['total']), 3), 'input_cost_units': round(cost)}))


def reply():
    """One reply in a fresh process, on the simulated clock."""
    import time
    offset = float(os.environ['CHECK_CLOCK']); wall = time.time
    time.time = lambda: wall() + offset
    import yaml
    turn, scale = int(os.environ['CHECK_TURN']), int(os.environ['CHECK_SCALE'])
    profile = Path(os.environ['HERMES_HOME'])
    (profile / 'config.yaml').write_text(yaml.safe_dump({
        'model': {'provider': 'anthropic', 'default': 'claude-sonnet-5-5'}, 'prompt_caching': {'cache_ttl': os.environ['CHECK_TTL']},
        'memory': {'memory_enabled': True, 'user_profile_enabled': True, 'provider': ''}, 'tools': {'tool_search': {'enabled': 'off'}},
        'curator': {'enabled': False}}))
    from services.hermes import memory_evidence, native_store, request_boundary
    from services.hermes.assistant_turn import bind_profile_home
    from services.hermes.prepared_context import install as prepare_native
    bind_profile_home(profile); prepare_native()
    request_boundary.install(request_boundary.Boundary('on', transform=lambda url, payload: payload))
    message = (f'message {turn} from the person ' + 'with what they need today ' * 20 * scale +
               f'\n\n[Archive source: nocheh:event:check-{turn}]')
    restore = lambda: None
    if os.environ['CHECK_MEMORY'] != 'none':
        recalled = {'summary': 'The person runs a small studio and plans the week ahead. ' * 60 * scale,
                    'facts': [f'fact {n} about the person' for n in range(150 * scale)] +
                             ([f'a fact learned before reply {turn}'] if os.environ['CHECK_MEMORY'] == 'changing' else [])}
        restore = memory_evidence.install(recalled, {}, os.environ['CHECK_PLACEMENT'], message)
    schedules = os.environ['CHECK_SCHEDULES'] == '1'
    if schedules:
        os.environ['HERMES_GATEWAY_SESSION'] = '1'
    from run_agent import AIAgent
    database = native_store.open_writer(profile)
    session = 'nocheh-check'
    history = list(native_store.conversation(database, session)) if native_store.session_row(database, session) else []
    agent = AIAgent(provider='anthropic', api_mode='anthropic_messages', model='claude-sonnet-5-5', api_key='check',
                    base_url=os.environ['CHECK_URL'], enabled_toolsets=['memory', 'session_search', 'skills'] + (['cronjob'] if schedules else []),
                    session_id=session, persistence=database, platform='telegram', chat_id='1', user_id='1', chat_type='dm',
                    skip_context_files=True, skip_memory=False, skip_background_review=True, quiet_mode=True, save_trajectories=False,
                    max_iterations=4, ephemeral_system_prompt='Reply rules for this chat. ' * 200 + (' Schedules rules.' if schedules else ''))
    agent._skip_mcp_refresh = True
    memory_evidence.collect(agent)
    try:
        agent.run_conversation(message, conversation_history=history)
    finally:
        agent.close(); database.close(); restore()


if __name__ == '__main__':
    reply() if '--reply' in sys.argv else main()
