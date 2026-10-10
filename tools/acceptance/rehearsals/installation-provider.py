"""Deterministic transports for the isolated installation rehearsal, never production.

Honcho's pinned mock implements the OpenAI wire formats and embeddings. The
responses below exercise Nocheh's detector/interpretation contracts; they are
scripted fixture answers and do not measure model accuracy or semantic recall.
"""
import hashlib
import json
import os
import re
import sys

if os.environ.get('NOCHEH_INSTALLATION_FIXTURE') != '1':
    raise SystemExit('explicit_fixture_required')


class ScriptedBrain:
    """Explicit fixture directives drive real Nocheh tool calls through Hermes.

    A directive such as ``[[search:query]]`` in the current user turn makes the
    model request one tool; the tool result then becomes the scripted answer.
    This tests the tool, guard and audience pipeline, never model judgement.
    Requests without a directive keep the deterministic mock behaviour.
    """
    DIRECTIVE = re.compile(r'\[\[(search|recall|action|owner|long|silent|empty-once|context)(?::([^\]]*))?\]\]')
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
        if not match:
            return None
        if self.canary in '\n'.join(self.text(message.content) for message in body.messages):
            self.counts['raw_canary_outside_detector'] += 1
            return {'error': 'unguarded_fixture_canary'}
        kind, argument = match[1], (match[2] or '').strip()
        self.counts['chat'] += 1
        later = messages[users[-1] + 1:]
        if kind in self.TOOLS:
            results = [message for message in later if message.role == 'tool']
            if results:
                name = self.TOOLS[kind]
                result = self.text(results[-1].content)
                self.record(directive=kind, argument=argument, phase='final', tool=name, result=result[:20000])
                return {'content': '[brain] ' + name + ': ' + ' '.join(result.split())[:3000]}
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
    counts = {'detector': 0, 'learning': 0, 'chat': 0, 'embeddings': 0, 'raw_canary_outside_detector': 0}
    canary = 'fixture-secret-ORCHID-2718'

    def answer(body):
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

    # Registered before Honcho's mock router so tool-bearing agent turns that
    # carry an explicit fixture directive reach the scripted brain first.
    @app.post('/v1/chat/completions')
    async def completions(body: chat.ChatCompletionRequest):
        scripted = brain.respond(body)
        if scripted is None:
            return await chat.chat_completions(body)
        return brain.render(body, scripted)

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

    @app.get('/v1/models')
    def models():
        return {'object': 'list', 'data': [{'id': os.environ.get('NOCHEH_MODEL', 'claude-sonnet-5-5'), 'object': 'model', 'owned_by': 'fixture'}]}

    app.include_router(chat.router, prefix='/v1')
    app.include_router(embeddings.router, prefix='/v1')
    uvicorn.run(app, host='0.0.0.0', port=8317, log_level='warning', access_log=False)


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
        embedding=replace(embeddings({}), url='http://shared-provider:8317/v1/embeddings'),
        reasoning_key='synthetic-no-provider')
    ThreadingHTTPServer(('0.0.0.0', 8790), handler(service)).serve_forever()


def speech():
    # Same HTTP contract as services.hermes.speech_gateway; only the ASR call is
    # substituted. Synthetic audio names its transcript as ``SPEECH:<text>``;
    # ``BLANK`` models a recognizer returning no usable text.
    import hmac
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    token = os.environ['SERVICE_TOKEN']

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, data):
            raw = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path != '/health':
                return self.reply(404, {'error': 'not_found'})
            return self.reply(200, {'ok': True, 'service': 'speech', 'login_present': True, 'synthetic': True})

        def do_POST(self):
            if self.path != '/transcribe':
                return self.reply(404, {'error': 'not_found'})
            if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), ('Bearer ' + token).encode()):
                return self.reply(401, {'error': 'unauthorized'})
            raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            if b'BLANK' in raw:
                return self.reply(200, {'success': False, 'transcript': '', 'provider': 'nocheh-subscription',
                                        'error': 'invalid_transcription_response', 'retryable': False})
            marker = re.search(rb'SPEECH:([^\x00\n]{1,500})', raw)
            text = marker[1].decode('utf-8', errors='replace') if marker else 'پیام صوتی مصنوعی'
            return self.reply(200, {'success': True, 'transcript': text, 'provider': 'nocheh-subscription'})

    ThreadingHTTPServer(('0.0.0.0', 8783), Handler).serve_forever()


if __name__ == '__main__':
    {'provider': provider, 'meter': meter, 'speech': speech}[sys.argv[1]]()
