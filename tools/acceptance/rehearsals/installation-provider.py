"""Deterministic transports for the isolated installation rehearsal, never production.

Honcho's pinned mock implements the OpenAI wire formats and embeddings. The
responses below exercise Nocheh's detector/interpretation contracts; they are
scripted fixture answers and do not measure model accuracy or semantic recall.
With NOCHEH_FIXTURE_UPSTREAM set by the real-model rehearsal, the same service
instead relays chat, model lists and embeddings to owner-authorized providers.
"""
import hashlib
import json
import os
import re
import sys

if os.environ.get('NOCHEH_INSTALLATION_FIXTURE') != '1':
    raise SystemExit('explicit_fixture_required')
FIXTURE = 'http://model-fixture:8317/v1'


class ScriptedBrain:
    """Explicit fixture directives drive real Nocheh tool calls through Hermes.

    A directive such as ``[[search:query]]`` in the current user turn makes the
    model request one tool; the tool result then becomes the scripted answer.
    This tests the tool, guard and audience pipeline, never model judgement.
    Requests without a directive keep the deterministic mock behaviour.
    """
    DIRECTIVE = re.compile(r'\[\[(search|recall|action|owner|long|silent|empty-once|context|turn)(?::([^\]]*))?\]\]')
    # Any Nocheh tool with exact JSON arguments: [[tool:nocheh_tasks {"action":"list"}]].
    TOOL = re.compile(r'\[\[tool:(nocheh_[a-z_]+)\s+(\{.*?\})\]\]', re.S)
    TOOLS = {'search': 'nocheh_archive_search', 'recall': 'nocheh_memory_recall', 'action': 'nocheh_action_request',
             'owner': 'nocheh_owner_read'}

    def __init__(self, counts, canary):
        self.counts, self.canary, self.events, self.emptied = counts, canary, [], set()

    @staticmethod
    def text(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return '\n'.join(part.get('text', '') for part in content if isinstance(part, dict))
        return ''

    def record(self, **event):
        self.events = (self.events + [event])[-500:]

    def respond(self, body):
        names = {tool.get('function', {}).get('name') for tool in body.tools or [] if isinstance(tool, dict)}
        if not any(isinstance(name, str) and name.startswith('nocheh_') for name in names):
            return None
        messages = [message for message in body.messages if message.role != 'system']
        users = [index for index, message in enumerate(messages) if message.role == 'user']
        if not users:
            return None
        current = self.text(messages[users[-1]].content)
        match = self.DIRECTIVE.search(current)
        tool = self.TOOL.search(current)
        if not match and not tool:
            return None
        if self.canary in '\n'.join(self.text(message.content) for message in body.messages):
            self.counts['raw_canary_outside_detector'] += 1
            return {'error': 'unguarded_fixture_canary'}
        self.counts['chat'] += 1
        later = messages[users[-1] + 1:]
        # [[after:silent]] makes the answer after a tool result [NO_REPLY], as
        # Nocheh asks once an approval card already answers the request.
        silent_after = '[[after:silent]]' in current
        if tool:
            name, results = tool[1], [message for message in later if message.role == 'tool']
            if results:
                result = self.text(results[-1].content)
                self.record(directive='tool', argument=tool[2], phase='final', tool=name, result=result[:20000])
                return {'content': '[NO_REPLY]' if silent_after else '[brain] ' + name + ': ' + ' '.join(result.split())[:3000]}
            self.record(directive='tool', argument=tool[2], phase='call', tool=name)
            return {'tool': name, 'arguments': json.loads(tool[2])}
        kind, argument = match[1], (match[2] or '').strip()
        if kind in self.TOOLS:
            results = [message for message in later if message.role == 'tool']
            if results:
                name = self.TOOLS[kind]
                result = self.text(results[-1].content)
                self.record(directive=kind, argument=argument, phase='final', tool=name, result=result[:20000])
                return {'content': '[NO_REPLY]' if silent_after else '[brain] ' + name + ': ' + ' '.join(result.split())[:3000]}
            if kind == 'search':
                arguments = {'mode': 'text', 'query': argument, 'limit': 5}
            elif kind == 'recall':
                arguments = {'query': argument}
            elif kind == 'owner':
                arguments = {'view': argument or 'conversations'}
            else:
                destination, _, message = argument.partition('|')
                arguments = {'destination': destination.strip(), 'text': message.strip()}
            self.record(directive=kind, argument=argument, phase='call', tool=self.TOOLS[kind])
            return {'tool': self.TOOLS[kind], 'arguments': arguments}
        if kind == 'silent':
            self.record(directive=kind, argument=argument, phase='final')
            return {'content': '[NO_REPLY]'}
        if kind == 'empty-once' and argument not in self.emptied:
            self.emptied.add(argument)
            self.record(directive=kind, argument=argument, phase='empty')
            return {'content': ''}
        if kind == 'long':
            size = max(1, min(int(argument or '5000'), 20000))
            words, index = [], 0
            while len(' '.join(words)) < size:
                index += 1
                words.append('بخش' + str(index))
            self.record(directive=kind, argument=argument, phase='final', words=index)
            return {'content': ' '.join(words)}
        if kind == 'turn':
            # Whether the marker reaches the model in the current turn itself, outside this directive.
            present = bool(argument) and argument in current.replace(match[0], '')
            self.record(directive=kind, argument=argument, phase='final', present=present)
            return {'content': '[brain] turn ' + argument + (' present' if present else ' absent')}
        if kind == 'context':
            earlier = '\n'.join(self.text(message.content) for index, message in enumerate(body.messages)
                                if message is not messages[users[-1]])
            present = bool(argument) and argument in earlier
            self.record(directive=kind, argument=argument, phase='final', present=present)
            return {'content': '[brain] context ' + argument + (' present' if present else ' absent')}
        self.record(directive=kind, argument=argument, phase='final')
        return {'content': '[brain] recovered ' + argument}

    def render(self, body, scripted):
        from fastapi.responses import JSONResponse, StreamingResponse
        if 'error' in scripted:
            return JSONResponse({'error': {'message': scripted['error']}}, status_code=400)
        model = body.model or 'mock-model'
        identity = 'chatcmpl-brain-' + hashlib.sha256(json.dumps(scripted, sort_keys=True).encode()).hexdigest()[:24]
        content = scripted.get('content')
        calls = None
        if 'tool' in scripted:
            calls = [{'id': 'call_' + identity[-16:], 'type': 'function',
                      'function': {'name': scripted['tool'], 'arguments': json.dumps(scripted['arguments'], ensure_ascii=False)}}]
        usage = {'prompt_tokens': 1, 'completion_tokens': max(1, len(content or '') // 4), 'total_tokens': 2}
        finish = 'tool_calls' if calls else 'stop'
        if not body.stream:
            return {'id': identity, 'object': 'chat.completion', 'created': 1577836800, 'model': model,
                    'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content, 'refusal': None,
                                 'tool_calls': calls}, 'logprobs': None, 'finish_reason': finish}], 'usage': usage}
        base = {'id': identity, 'object': 'chat.completion.chunk', 'created': 1577836800, 'model': model}

        async def stream():
            def chunk(payload):
                return ('data: ' + json.dumps({**base, **payload}, ensure_ascii=False) + '\n\n').encode()
            delta = {'role': 'assistant', 'content': None if calls else ''}
            yield chunk({'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]})
            if calls:
                yield chunk({'choices': [{'index': 0, 'delta': {'tool_calls': [{'index': 0, **calls[0]}]}, 'finish_reason': None}]})
            elif content:
                yield chunk({'choices': [{'index': 0, 'delta': {'content': content}, 'finish_reason': None}]})
            yield chunk({'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}]})
            if body.stream_options is not None and body.stream_options.include_usage:
                yield chunk({'choices': [], 'usage': usage})
            yield b'data: [DONE]\n\n'
        return StreamingResponse(stream(), media_type='text/event-stream')


def provider():
    sys.path.insert(0, '/app')
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    from src.mock_provider import chat, embeddings
    import uvicorn
    original = chat._response_content
    counts = {'detector': 0, 'learning': 0, 'chat': 0, 'embeddings': 0, 'transcriptions': 0, 'images': 0, 'raw_canary_outside_detector': 0}
    canary = 'fixture-secret-ORCHID-2718'

    def answer(body):
        parts = [part for message in body.messages if isinstance(message.content, list) for part in message.content if isinstance(part, dict)]
        if any(part.get('type') == 'image_url' for part in parts):
            # Reading an image: its text and a short description.
            counts['images'] += 1
            return 'SIGNMARK88 Synthetic sign\nA made-up sign on a plain background.'
        texts = [message.content for message in body.messages if isinstance(message.content, str)]
        text = '\n'.join(texts)
        if texts and texts[0].startswith('Find secret values in the supplied data.'):
            counts['detector'] += 1
            return json.dumps({'literals': [canary] if canary in text else []})
        if canary in text:
            counts['raw_canary_outside_detector'] += 1
            raise ValueError('unguarded_fixture_canary')
        if 'Interpret permitted conversation evidence silently.' in text:
            counts['learning'] += 1
            # Read the explicit fixture evidence from Honcho's actual reasoning
            # request, not from a pre-seeded learned projection.
            decoder = json.JSONDecoder()
            for index, char in enumerate(text):
                if char != '{':
                    continue
                try:
                    context, _ = decoder.raw_decode(text[index:])
                except ValueError:
                    continue
                if not isinstance(context, dict) or 'observations' not in context or 'space' not in context:
                    continue
                observation = context['observations'][0]
                if 'PERSONMARK' in (observation['value'].get('text') or ''):
                    # A real model may suggest the owner by name; Nocheh must drop
                    # that and keep one card per new name.
                    source = observation['source']['id']
                    return json.dumps({'interpretations': [], 'entity_claims': [], 'entity_suggestions': [
                        {'kind': 'person', 'name': 'Shirin', 'reason': 'A friend the owner talked with.', 'evidence_ids': [source]},
                        {'kind': 'person', 'name': 'Synthetic 123', 'reason': 'The person who wrote this.', 'evidence_ids': [source]}]})
                quote = 'In this chat, the telescope mark means reviewed.'
                if quote in (observation['value'].get('text') or ''):
                    source = observation['source']['id']
                    return json.dumps({'interpretations': [{'kind': 'convention', 'subject': 'telescope mark',
                        'text': 'The telescope mark means reviewed.', 'scope': {'kind': 'conversation', 'id': context['space']},
                        'uncertainty': 'explicit', 'evidence_ids': [source], 'quote': {'source_id': source, 'text': quote}, 'conflicts': []}]})
                reaction = observation['value'].get('payload', {}).get('message_reaction')
                rule = any(rule.get('text') == 'The telescope mark means reviewed.' and not rule.get('conflict') for rule in context.get('rules', []))
                if reaction and rule and reaction.get('new_reaction') == [{'type': 'emoji', 'emoji': '🔭'}] and len(context['observations']) > 1:
                    return json.dumps({'interpretations': [{'kind': 'state', 'subject': 'synthetic telescope observation',
                        'text': 'The telescope observation is reviewed.', 'scope': {'kind': 'conversation', 'id': context['space']},
                        'uncertainty': 'supported', 'evidence_ids': [item['source']['id'] for item in context['observations']], 'conflicts': []}]})
                return '{"interpretations":[]}'
            return '{"interpretations":[]}'
        counts['chat'] += 1
        return original(body)

    chat._response_content = answer
    app = FastAPI()
    brain = ScriptedBrain(counts, canary)
    upstream = os.environ.get('NOCHEH_FIXTURE_UPSTREAM')
    if upstream:
        relay(app, json.loads(open(upstream).read()), counts, canary)
    else:
        # Registered before Honcho's mock router so tool-bearing agent turns that
        # carry an explicit fixture directive reach the scripted brain first.
        @app.post('/v1/chat/completions')
        async def completions(body: chat.ChatCompletionRequest):
            scripted = brain.respond(body)
            if scripted is None:
                return await chat.chat_completions(body)
            return brain.render(body, scripted)

    if not upstream:
        @app.post('/v1/audio/transcriptions')
        async def transcriptions(request: Request):
            # The upload is multipart; only its bytes matter here.
            audio = await request.body()
            counts['transcriptions'] += 1
            if canary.encode() in audio:
                counts['raw_canary_outside_detector'] += 1
            return JSONResponse({'text': 'Synthetic voice VOICEMARK77: water the garden on Friday.'})

    @app.get('/fixture/brain')
    def brain_events():
        return {'events': brain.events}

    if os.environ.get('NOCHEH_TELEGRAM_FIXTURE_STATE'):
        from tools.acceptance.telegram_mock import TelegramMock
        TelegramMock(os.environ['NOCHEH_TELEGRAM_FIXTURE_STATE']).install(app)

    @app.middleware('http')
    async def audit(request: Request, call_next):
        if request.url.path.endswith('/embeddings'):
            counts['embeddings'] += 1
            if canary.encode() in await request.body():
                counts['raw_canary_outside_detector'] += 1
                return JSONResponse({'error': {'message': 'unguarded_fixture_canary'}}, status_code=400)
        return await call_next(request)

    @app.get('/healthz')
    def health():
        return {'ok': True, 'synthetic': True}

    @app.get('/fixture/stats')
    def stats():
        return counts

    if not upstream:
        @app.get('/v1/models')
        def models():
            return {'object': 'list', 'data': [{'id': os.environ.get('NOCHEH_MODEL', 'claude-sonnet-5-5'), 'object': 'model', 'owned_by': 'fixture'}]}
        app.include_router(chat.router, prefix='/v1')
    # Without an embedding upstream, embeddings stay deterministic.
    app.include_router(embeddings.router, prefix='/v1')
    uvicorn.run(app, host='0.0.0.0', port=8317, log_level='warning', access_log=False)


def relay(app, upstream, counts, canary, client=None):
    """Forward the OpenAI-compatible routes to the configured providers unchanged.

    Only the authorization changes. The canary check still proves that every
    request except the secret detector reaches the model already guarded.
    """
    import httpx
    from fastapi import Request
    from fastapi.responses import JSONResponse, StreamingResponse
    from starlette.background import BackgroundTask
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(300, connect=20))

    async def forward(request, kind, path):
        spec = upstream[kind]
        body = await request.body()
        if request.method == 'POST':
            try:
                parsed = json.loads(body)
            except ValueError:
                return JSONResponse({'error': {'message': 'invalid_fixture_json'}}, status_code=400)
            text = json.dumps(parsed, ensure_ascii=False)
            first = next((m.get('content') for m in parsed.get('messages', []) if isinstance(m, dict)), '') if kind == 'chat' else ''
            if isinstance(first, str) and first.startswith('Find secret values in the supplied data.'):
                counts['detector'] += 1
            elif canary in text:
                counts['raw_canary_outside_detector'] += 1
                return JSONResponse({'error': {'message': 'unguarded_fixture_canary'}}, status_code=400)
            elif 'Interpret permitted conversation evidence silently.' in text:
                counts['learning'] += 1
            elif kind == 'chat':
                counts['chat'] += 1
        sent = client.build_request(request.method, spec['url'].rstrip('/') + path, content=body or None,
            headers={'content-type': 'application/json', 'accept': request.headers.get('accept', 'application/json'),
                     'authorization': 'Bearer ' + spec['key']})
        try:
            response = await client.send(sent, stream=True)
        except httpx.HTTPError as error:
            counts['upstream_errors'] = counts.get('upstream_errors', 0) + 1
            return JSONResponse({'error': {'message': 'fixture_upstream_' + type(error).__name__}}, status_code=502)
        if response.status_code >= 400:
            counts['upstream_errors'] = counts.get('upstream_errors', 0) + 1
        return StreamingResponse(response.aiter_bytes(), status_code=response.status_code,
            media_type=response.headers.get('content-type'), background=BackgroundTask(response.aclose))

    @app.post('/v1/chat/completions')
    async def completions(request: Request):
        return await forward(request, 'chat', '/chat/completions')

    @app.get('/v1/models')
    async def models(request: Request):
        return await forward(request, 'chat', '/models')

    if 'embeddings' in upstream:
        @app.post('/v1/embeddings')
        async def embed(request: Request):
            return await forward(request, 'embeddings', '/embeddings')


def meter():
    # Exercise the production guard callback, ledger and payload validation.
    # Only the paid transport's destination changes inside this fixture process.
    from dataclasses import replace
    from pathlib import Path
    from http.server import ThreadingHTTPServer
    from services.honcho.meter import Egress, Ledger, ArchivePreparation, handler, embeddings
    token = Path('/state/internal_token').read_text().strip()
    service = Egress(Ledger('/ledger/budget.sqlite'), token, 'synthetic-no-provider',
        prepare=ArchivePreparation('http://nocheh-app:8780', token),
        # The memory search model follows the environment, as meter.env sets it in production.
        embedding=replace(embeddings({'NOCHEH_EMBEDDING_MODEL': os.environ.get('NOCHEH_EMBEDDING_MODEL') or 'text-embedding-3-small'}),
                          url=FIXTURE + '/embeddings'),
        reasoning_key='synthetic-fixture-model-key')
    # The meter admits only HTTPS reasoning addresses; this fixture process
    # alone points it at the local model fixture.
    service.reasoning_url = FIXTURE
    ThreadingHTTPServer(('0.0.0.0', 8790), handler(service)).serve_forever()


if __name__ == '__main__':
    {'provider': provider, 'meter': meter}[sys.argv[1]]()
