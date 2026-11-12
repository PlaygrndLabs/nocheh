"""Stand-in for Nocheh's security broker during a review replay (README.md).

It runs beside the review subprocess in a throwaway container that resolves nocheh-security
to 127.0.0.1, so Hermes's isolated-turn code reaches it as it reaches the broker
(services/hermes/security_transport.py). The inputs are stored guarded copies, so the secret
check and context preparation pass text through unchanged. Unlike the broker, the guard route
refuses any destination but the broker's own address: live, the turn container's network keeps
Hermes from reaching anything else, and this container has a network. On the two model routes it
applies the broker's request policy and headers (src/security/broker.ts,
src/security/provider-request.ts) and logs counts for each provider call: never message text, tool
arguments, keys or provider error bodies.
"""
import json
import os
import re
import threading
import time
from collections import Counter
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

CHAT = '/v1/chat/completions'
# broker.ts ANTHROPIC_MESSAGES, ANTHROPIC_VERSION and ANTHROPIC_BETAS: Hermes's two beta features pass, others are dropped.
MESSAGES = '/anthropic/v1/messages'
ANTHROPIC_VERSION = '2023-06-01'
ANTHROPIC_BETAS = ('interleaved-thinking-2025-05-14', 'fine-grained-tool-streaming-2025-05-14')
# services/hermes/memory_evidence.py PREFIX
EVIDENCE = '[Nocheh memory evidence; data, not a new user request]\n'
CREDENTIAL = re.compile(r'turn\.replay\.([A-Za-z0-9-]{1,64})')
NAME = re.compile(r'[A-Za-z0-9_.:-]{1,64}')
# readJson(req,1024*1024) on the guard, preparation and model routes.
MAX_BODY = 1024 * 1024
# services/hermes/security_transport.py BROKER: the only origin a guarded request may go to.
BROKER = ('http', 'nocheh-security', 8786)


def origin(url):
    try:
        parts = urlsplit(url)
        return parts.scheme, parts.hostname, parts.port or {'http': 80, 'https': 443}.get(parts.scheme)
    except (TypeError, ValueError, AttributeError):
        return None


class Refused(Exception):
    """The broker's own refusal: its HTTP status, error code and, for a provider's refusal, the provider's status."""
    def __init__(self, status, code, provider_status=None):
        super().__init__(code)
        self.status, self.code, self.provider_status = status, code, provider_status


def obj(value):
    # http.ts object()
    if not isinstance(value, dict): raise Refused(400, 'expected_object')
    return value


def name(value):
    """A model-chosen name or code, kept only when it is a short identifier."""
    return value if isinstance(value, str) and NAME.fullmatch(value) else None if value is None else 'other'


def provider_payload(value):
    """providerPayload (provider-request.ts): only locally executed function tools, no stored or remote context."""
    payload = obj(value)
    tools = payload.get('tools')
    if 'tools' in payload and (not isinstance(tools, list) or any(not isinstance(t, dict) or t.get('type') != 'function' for t in tools)):
        raise Refused(403, 'hosted_provider_tools_denied')
    if 'web_search_options' in payload: raise Refused(403, 'hosted_provider_tools_denied')
    choice = payload.get('tool_choice')
    if isinstance(choice, (dict, list)) and obj(choice).get('type') != 'function': raise Refused(403, 'hosted_provider_tools_denied')

    def inspect(item):
        if isinstance(item, list):
            for entry in item: inspect(entry)
        if not isinstance(item, dict): return
        if any(key in item for key in ('previous_response_id', 'conversation', 'file_id', 'file_url', 'vector_store_ids')):
            raise Refused(403, 'opaque_provider_context_denied')
        if 'image_url' in item:
            image = item['image_url'] if isinstance(item['image_url'], str) else obj(item['image_url']).get('url')
            if not isinstance(image, str) or not image.startswith('data:'): raise Refused(403, 'remote_provider_media_denied')
        for entry in item.values(): inspect(entry)
    inspect({key: item for key, item in payload.items() if key != 'tools'})
    if isinstance(payload.get('input'), list):
        return {**payload, 'input': [item for item in payload['input']
                                     if not (isinstance(item, dict) and item.get('type') == 'reasoning' and 'encrypted_content' in item)]}
    return payload


ANTHROPIC_FIELDS = {'model', 'messages', 'system', 'max_tokens', 'stream', 'stop_sequences', 'metadata', 'tools', 'tool_choice',
                    'thinking', 'output_config', 'temperature', 'top_p', 'top_k', 'cache_control'}
ANTHROPIC_TOOL_FIELDS = {'name', 'description', 'input_schema', 'cache_control', 'strict', 'eager_input_streaming', 'type'}
ANTHROPIC_BLOCKS = {'text', 'image', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking'}
REASONING = ('thinking', 'redacted_thinking')


def anthropic_payload(value):
    """anthropicPayload (provider-request.ts): unknown fields refused, local tools only, and earlier reasoning not
    replayed: an assistant message's thinking blocks are dropped unless it holds nothing else."""
    payload = obj(value)
    if any(key not in ANTHROPIC_FIELDS for key in payload): raise Refused(403, 'provider_request_field_denied')
    tools = payload.get('tools')
    if 'tools' in payload and (not isinstance(tools, list) or any(
            not isinstance(t, dict) or ('type' in t and t['type'] != 'custom') or not isinstance(t.get('name'), str)
            or not isinstance(t.get('input_schema'), (dict, list)) or any(key not in ANTHROPIC_TOOL_FIELDS for key in t) for t in tools)):
        raise Refused(403, 'hosted_provider_tools_denied')
    if 'tool_choice' in payload and obj(payload['tool_choice']).get('type') not in ('auto', 'any', 'tool', 'none'):
        raise Refused(403, 'hosted_provider_tools_denied')
    if not isinstance(payload.get('messages'), list): raise Refused(400, 'invalid_model_request')

    def blocks(content):
        if isinstance(content, str): return
        if not isinstance(content, list): raise Refused(400, 'invalid_model_request')
        for block in content:
            block = obj(block)
            if block.get('type') not in ANTHROPIC_BLOCKS: raise Refused(403, 'opaque_provider_context_denied')
            if block['type'] == 'image' and obj(block.get('source')).get('type') != 'base64': raise Refused(403, 'remote_provider_media_denied')
            if block['type'] == 'tool_result' and 'content' in block: blocks(block['content'])
    if 'system' in payload: blocks(payload['system'])
    for message in payload['messages']:
        if obj(message).get('role') not in ('user', 'assistant', 'system'): raise Refused(400, 'invalid_model_request')
        blocks(message.get('content'))

    def inspect(item):
        if isinstance(item, list):
            for entry in item: inspect(entry)
        if not isinstance(item, dict): return
        if any(key in item for key in ('file_id', 'container', 'mcp_servers', 'url')): raise Refused(403, 'opaque_provider_context_denied')
        for key, entry in item.items():
            if not (item.get('type') == 'tool_use' and key == 'input'): inspect(entry)
    inspect({key: item for key, item in payload.items() if key != 'tools'})

    def strip(message):
        content = message.get('content')
        if message.get('role') != 'assistant' or not isinstance(content, list): return message
        reasoning = [isinstance(block, dict) and block.get('type') in REASONING for block in content]
        if not any(reasoning) or all(reasoning): return message
        return {**message, 'content': [block for block, drop in zip(content, reasoning) if not drop]}
    return {**payload, 'messages': [strip(message) for message in payload['messages']]}


def inspect_guarded(payload):
    """inspectRequest (src/guard.ts), which the broker's guard route runs before preparing: an opaque reference or
    attachment cannot be read as text. Everything else passes unchanged, as the inputs are already guarded copies."""
    if len(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()) > 512 * 1024: raise Refused(413, 'guard_request_too_large')
    opaque = ('previous_response_id', 'encrypted_content', 'image_url', 'input_audio', 'audio_url', 'file_data', 'file_id', 'image', 'audio', 'document')

    def walk(item, literal):
        if isinstance(item, list):
            for entry in item: walk(entry, literal)
        if not isinstance(item, dict): return
        if not literal and (any(item.get(key) is not None for key in opaque)
                            or item.get('type') in ('input_image', 'input_audio', 'input_file', 'image', 'audio', 'document')):
            raise Refused(422, 'uninspectable_model_context')
        for key, entry in item.items(): walk(entry, literal or (item.get('type') == 'tool_use' and key == 'input'))
    walk(payload, False)


def evidence_position(payload):
    """Where the memory evidence block sits in a model request: the first block of the first message, its own message, elsewhere, or absent."""
    messages = payload.get('messages') if isinstance(payload, dict) else None
    if not isinstance(messages, list): return 'absent'

    def starts(text): return isinstance(text, str) and text.startswith(EVIDENCE)
    for index, message in enumerate(messages):
        content = message.get('content') if isinstance(message, dict) else None
        if starts(content): return 'separate_message'
        if isinstance(content, list):
            for position, block in enumerate(content):
                if isinstance(block, dict) and starts(block.get('text')):
                    return 'first_block' if index == 0 and position == 0 else 'other'
    return 'absent'


def sse(raw):
    """The JSON data of each server-sent event; a non-JSON line such as [DONE] is skipped."""
    for event in raw.decode('utf-8', 'replace').replace('\r\n', '\n').split('\n\n'):
        lines = [line[5:] for line in event.split('\n') if line.startswith('data:')]
        try: yield json.loads('\n'.join(line[1:] if line.startswith(' ') else line for line in lines))
        except ValueError: continue


def arguments(value):
    if isinstance(value, dict): return value
    try: return json.loads(value) if isinstance(value, str) and value else {}
    except ValueError: return {}


def memory_ops(args):
    """(action, target) of each operation of one memory tool call: Hermes 0.23's ``operations`` list, or the legacy single action."""
    if not isinstance(args, dict): return []
    target = args.get('target')
    operations = args.get('operations')
    if isinstance(operations, list) and operations:
        return [[name(op.get('action')) if isinstance(op, dict) else 'other',
                 name((op.get('target') if isinstance(op, dict) else None) or target)] for op in operations]
    return [[name(args.get('action')), name(target)]] if args.get('action') is not None else []


def messages_response(value):
    """Normalized blocks, stop reason, usage and error of a non-streamed Messages API response."""
    blocks = [{'type': b.get('type'), 'name': b.get('name'), 'input': b.get('input'), 'chars': len(b.get('thinking') or '')}
              for b in value.get('content') or [] if isinstance(b, dict)]
    return blocks, value.get('stop_reason'), value.get('usage') or {}, None


def stream_error(event):
    """The type of an error event inside a stream that already answered 200, such as overloaded_error; Hermes retries
    such a call within the same loop iteration, so it is no call of its own."""
    error = event.get('error')
    if event.get('type') != 'error' and not isinstance(error, dict): return None
    return (name((error.get('type') or error.get('code')) if isinstance(error, dict) else None) or 'error')


def messages_stream(events):
    blocks, parts, usage, stop, error = {}, {}, {}, None, None
    for event in events:
        kind = event.get('type')
        error = error or stream_error(event)
        if kind == 'message_start':
            usage.update((event.get('message') or {}).get('usage') or {})
        elif kind == 'content_block_start':
            block = event.get('content_block') or {}
            blocks[event.get('index')] = {'type': block.get('type'), 'name': block.get('name'), 'input': block.get('input'),
                                          'chars': len(block.get('thinking') or '')}
            parts[event.get('index')] = []
        elif kind == 'content_block_delta' and event.get('index') in blocks:
            delta = event.get('delta') or {}
            if delta.get('type') == 'input_json_delta': parts[event['index']].append(delta.get('partial_json') or '')
            elif delta.get('type') == 'thinking_delta': blocks[event['index']]['chars'] += len(delta.get('thinking') or '')
        elif kind == 'message_delta':
            stop = (event.get('delta') or {}).get('stop_reason') or stop
            usage.update({key: count for key, count in (event.get('usage') or {}).items() if count is not None})
    for index, block in blocks.items():
        if parts[index]: block['input'] = arguments(''.join(parts[index]))
    return [blocks[index] for index in sorted(blocks, key=lambda i: (i is None, i))], stop, usage, error


def chat_response(value):
    choice = (value.get('choices') or [{}])[0] or {}
    message = choice.get('message') or {}
    blocks = [{'type': 'tool_use', 'name': (call.get('function') or {}).get('name'), 'input': arguments((call.get('function') or {}).get('arguments'))}
              for call in message.get('tool_calls') or [] if isinstance(call, dict)]
    reasoning = message.get('reasoning_content') or message.get('reasoning')
    if isinstance(reasoning, str) and reasoning: blocks.append({'type': 'thinking', 'chars': len(reasoning)})
    return blocks, choice.get('finish_reason'), value.get('usage') or {}, None


def chat_stream(events):
    calls, usage, stop, reasoning, error = {}, {}, None, 0, None
    for event in events:
        error = error or stream_error(event)
        if isinstance(event.get('usage'), dict): usage = event['usage']
        for choice in event.get('choices') or []:
            delta = choice.get('delta') or {}
            text = delta.get('reasoning_content') or delta.get('reasoning')
            if isinstance(text, str): reasoning += len(text)
            for call in delta.get('tool_calls') or []:
                entry = calls.setdefault(call.get('index', 0), {'name': None, 'arguments': []})
                function = call.get('function') or {}
                entry['name'] = function.get('name') or entry['name']
                entry['arguments'].append(function.get('arguments') or '')
            stop = choice.get('finish_reason') or stop
    blocks = [{'type': 'tool_use', 'name': calls[i]['name'], 'input': arguments(''.join(calls[i]['arguments']))} for i in sorted(calls)]
    if reasoning: blocks.append({'type': 'thinking', 'chars': reasoning})
    return blocks, stop, usage, error


def tokens(route, usage):
    """Usage as uncached input, cache reads and writes, output and reasoning tokens."""
    count = lambda value: value if type(value) is int and value >= 0 else 0
    if route == 'messages':
        return {'input': count(usage.get('input_tokens')), 'cache_read': count(usage.get('cache_read_input_tokens')),
                'cache_write': count(usage.get('cache_creation_input_tokens')), 'output': count(usage.get('output_tokens')), 'reasoning': 0}
    cached = count((usage.get('prompt_tokens_details') or {}).get('cached_tokens'))
    return {'input': max(0, count(usage.get('prompt_tokens')) - cached), 'cache_read': cached, 'cache_write': 0,
            'output': count(usage.get('completion_tokens')), 'reasoning': count((usage.get('completion_tokens_details') or {}).get('reasoning_tokens'))}


def response_metrics(route, streamed, raw):
    """Counts from one provider response that answered 200: stop reason, tool calls, memory operations, usage, thinking,
    the type of an error inside the stream, and whether the provider reported no usage (its cost is then unknown)."""
    try:
        if streamed: blocks, stop, usage, error = (messages_stream if route == 'messages' else chat_stream)(list(sse(raw)))
        else: blocks, stop, usage, error = (messages_response if route == 'messages' else chat_response)(json.loads(raw))
    except (ValueError, AttributeError, TypeError):
        return {'parse_error': True}
    calls = [block for block in blocks if block.get('type') == 'tool_use']
    thinking = [block for block in blocks if block.get('type') in REASONING]
    return {'stop': name(stop), 'tool_calls': len(calls), 'tools': [name(call.get('name')) for call in calls],
            'memory_ops': [op for call in calls if call.get('name') == 'memory' for op in memory_ops(call.get('input'))],
            'usage': tokens(route, usage), 'thinking_blocks': len(thinking), 'thinking_chars': sum(block.get('chars') or 0 for block in thinking),
            **({'stream_error': error} if error else {}), **({} if isinstance(usage, dict) and usage else {'usage_missing': True})}


def error_type(raw):
    """The provider's error type only, never its message."""
    try:
        error = json.loads(raw).get('error')
        return name(error.get('type') or error.get('code')) if isinstance(error, dict) else None
    except (ValueError, AttributeError):
        return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # The broker fetches with redirect:'error'.
    def redirect_request(self, *args, **kwargs):
        raise urllib.error.URLError('redirect_refused')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args): pass

    def reply(self, status, body, content_type='application/json; charset=utf-8'):
        self.replied = True
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        if length > MAX_BODY: raise Refused(413, 'body_too_large')
        try: return json.loads(raw)
        except ValueError: raise Refused(400, 'invalid_json') from None

    def record(self, entry):
        self.recorded = True
        self.server.record(entry)

    def run_id(self, path):
        # broker.ts anthropicCredential: on the Messages route Anthropic's key header carries the turn's credential.
        authorization, key = self.headers.get('Authorization'), self.headers.get('x-api-key')
        if path == MESSAGES and key is not None:
            if authorization is not None: raise Refused(401, 'unauthorized')
            authorization = 'Bearer ' + key
        match = CREDENTIAL.fullmatch((authorization or '')[7:]) if (authorization or '').startswith('Bearer ') else None
        if not match: raise Refused(401, 'unauthorized')
        return match.group(1)

    def do_GET(self): self.handle_request()

    def do_POST(self): self.handle_request()

    do_PUT = do_PATCH = do_DELETE = do_POST

    def handle_request(self):
        path = urlsplit(self.path).path
        if self.command == 'GET' and path == '/health': return self.reply(200, {'ok': True, 'service': 'review-replay-relay'})
        run, self.recorded, self.replied = None, False, False
        try:
            run = self.run_id(path)
            if self.command == 'POST' and path == '/v1/guard':
                body = obj(self.body())
                # The broker does not read the destination (broker.ts: "Destination is not forwarded"); live, the turn's
                # network allows nothing but the broker. Here only the broker's address passes; the log keeps the host.
                target = origin(body.get('destination'))
                if target not in self.server.allowed:
                    self.record({'kind': 'other', 'run_id': run, 'method': 'POST', 'path': path, 'status': 403, 'refused': 'replay_destination_denied',
                                 'host': name(target[1]) if target else None})
                    raise Refused(403, 'replay_destination_denied')
                payload = body.get('payload')
                inspect_guarded(payload)
                self.server.evidence[run] = evidence_position(payload)
                return self.reply(200, {'guarded': True, 'payload': payload})
            if self.command == 'POST' and path == '/v1/context/prepare':
                # The stores route answers with the same JSON value, each text replaced by its prepared copy.
                return self.reply(200, self.body())
            if path in (CHAT, MESSAGES):
                if self.command != 'POST' or urlsplit(self.path).query: raise Refused(403, 'security_route_denied')
                return self.model_call(run, path)
            # A provider's model list: the broker allows no GET outside its fixed archive routes. Anything else a
            # review never asks for, so it shows in the log.
            if self.command == 'GET' and path.rstrip('/').endswith('/models'): raise Refused(403, 'security_route_denied')
            raise Refused(404, 'not_found')
        except Refused as error:
            if not self.recorded:
                self.server.record({'kind': 'other', 'run_id': run, 'method': self.command, 'path': path[:200], 'status': error.status, 'refused': error.code})
            return self.reply(error.status, {'error': error.code, **({'provider_status': error.provider_status} if error.provider_status else {})})
        except Exception:
            # The broker's answer to its own failure; the record keeps the path, never the error's text.
            if not self.recorded: self.server.record({'kind': 'other', 'run_id': run, 'method': self.command, 'path': path[:200], 'status': 503, 'refused': 'relay_error'})
            if not self.replied: self.reply(503, {'error': 'security_service_unavailable'})

    def model_call(self, run, path):
        # A call keeps being read from the provider, and is billed, after its run's process ends; the driver waits for it.
        with self.server.lock: self.server.inflight[run] += 1
        try: return self.forward(run, path)
        finally:
            with self.server.lock:
                self.server.inflight[run] -= 1
                self.server.settled.notify_all()

    def forward(self, run, path):
        route = 'messages' if path == MESSAGES else 'chat'
        entry = {'kind': 'call', 'run_id': run, 'route': route, 'evidence': self.server.evidence.pop(run, 'no_guard_call')}
        started = time.monotonic()
        try:
            request = self.body()
            payload = anthropic_payload(request) if route == 'messages' else provider_payload(request)
            if self.server.model and payload.get('model') != self.server.model: raise Refused(403, 'model_configuration_mismatch')
        except Refused as error:
            self.record({**entry, 'status': error.status, 'refused': error.code})
            raise
        # The thinking and effort settings sent, by name.
        setting = lambda key, field: payload[key].get(field) if isinstance(payload.get(key), dict) else None
        entry.update(stream=payload.get('stream') is True, messages=len(payload['messages']) if isinstance(payload.get('messages'), list) else 0,
                     thinking=name(setting('thinking', 'type')),
                     effort=name(payload.get('reasoning_effort') or setting('reasoning', 'effort') or setting('output_config', 'effort')))
        if not self.server.key:
            self.record({**entry, 'status': 503, 'refused': 'provider_not_configured'})
            raise Refused(503, 'provider_not_configured')
        if route == 'messages':
            betas = [beta.strip() for beta in (self.headers.get('anthropic-beta') or '').split(',') if beta.strip() in ANTHROPIC_BETAS]
            headers = {'content-type': 'application/json', 'x-api-key': self.server.key, 'anthropic-version': ANTHROPIC_VERSION, 'user-agent': 'Nocheh',
                       **({'anthropic-beta': ','.join(dict.fromkeys(betas))} if betas else {})}
            url = self.server.upstream + '/v1/messages'
        else:
            headers = {'content-type': 'application/json', 'authorization': 'Bearer ' + self.server.key, 'user-agent': 'Nocheh'}
            url = self.server.upstream + '/v1/chat/completions'
        data = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            # The broker's 120 s deadline for one request.
            with opener.open(urllib.request.Request(url, data=data, headers=headers, method='POST'), timeout=120) as response:
                status, content_type, raw = response.status, response.headers.get('Content-Type'), response.read()
        except urllib.error.HTTPError as error:
            with error: raw = error.read(64 * 1024)
            self.record({**entry, 'status': error.code, 'error_type': error_type(raw), 'latency_ms': round((time.monotonic() - started) * 1000)})
            # ProviderFailure: the broker passes on 401, 403 and 429, answers 503 for any other status, and sends the
            # provider's status but never its body (services/hermes/usage.py reads that answer).
            raise Refused(error.code if error.code in (401, 403, 429) else 503, 'provider_request_failed', error.code) from None
        except Exception:
            self.record({**entry, 'status': 0, 'error_type': 'network', 'latency_ms': round((time.monotonic() - started) * 1000)})
            raise Refused(503, 'security_service_unavailable') from None
        self.record({**entry, 'status': status, 'latency_ms': round((time.monotonic() - started) * 1000), **response_metrics(route, entry['stream'], raw)})
        # The identical bytes, streamed or not; the broker answers 200 for any successful provider response.
        self.reply(200, raw, content_type or 'application/octet-stream')


class Relay(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A review process that ends mid-request drops its connection; nothing to print.
        pass

    def __init__(self, port=8786, log=None, upstream=None, key=None, model=None, allowed=()):
        super().__init__(('127.0.0.1', port), Handler)
        self.upstream = (upstream or os.environ.get('REPLAY_UPSTREAM') or 'https://api.anthropic.com').rstrip('/')
        self.key = os.environ.get('REPLAY_PROVIDER_KEY', '') if key is None else key
        self.model, self.log, self.lock = model, log, threading.Lock()
        self.records, self.evidence, self.inflight = [], {}, Counter()
        self.settled = threading.Condition(self.lock)
        # Origins a guarded request may go to: the broker's, and the driver's broker address if it differs.
        self.allowed = {BROKER, *(origin(url) for url in allowed)}
        if log:
            os.close(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600))
            os.chmod(log, 0o600)

    def record(self, entry):
        with self.lock:
            self.records.append(entry)
            if self.log:
                with open(self.log, 'a', encoding='utf-8') as file: file.write(json.dumps(entry, separators=(',', ':')) + '\n')

    def settle(self, run, timeout):
        """Wait until no model call of the run is still being read from the provider; False if one still is."""
        with self.settled: return self.settled.wait_for(lambda: not self.inflight[run], timeout)

    def take(self, run=None):
        """The records of one run, or with no run every record held, removed from memory; the log keeps them."""
        with self.lock:
            taken = [entry for entry in self.records if run is None or entry.get('run_id') == run]
            self.records = [entry for entry in self.records if run is not None and entry.get('run_id') != run]
            return taken


def start(**options):
    server = Relay(**options)
    threading.Thread(target=server.serve_forever, daemon=True, name='review-replay-relay').start()
    return server


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Broker stand-in for a review replay; the driver normally starts it itself.')
    parser.add_argument('--port', type=int, default=8786)
    parser.add_argument('--log', help='JSON lines of counts per provider call (mode 0600)')
    parser.add_argument('--model', help='Refuse model calls for any other model, as the broker does')
    args = parser.parse_args()
    Relay(args.port, args.log, model=args.model).serve_forever()


if __name__ == '__main__':
    main()
