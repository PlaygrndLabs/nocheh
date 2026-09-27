"""Deterministic transports for the isolated installation rehearsal, never production.

Honcho's pinned mock implements the OpenAI wire formats and embeddings. The
responses below exercise Nocheh's detector/interpretation contracts; they are
scripted fixture answers and do not measure model accuracy or semantic recall.
"""
import json
import os
import sys

if os.environ.get('NOCHEH_INSTALLATION_FIXTURE') != '1':
    raise SystemExit('explicit_fixture_required')


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
        return {'object': 'list', 'data': [{'id': 'gpt-5.6-sol', 'object': 'model', 'owned_by': 'fixture'}]}

    app.include_router(chat.router, prefix='/v1')
    app.include_router(embeddings.router, prefix='/v1')
    uvicorn.run(app, host='0.0.0.0', port=8317, log_level='warning', access_log=False)


def meter():
    # Exercise the production guard callback, ledger and payload validation.
    # Only the paid transport's destination changes inside this fixture process.
    sys.path.insert(0, '/experiment')
    from dataclasses import replace
    from pathlib import Path
    from http.server import ThreadingHTTPServer
    from meter import Egress, Ledger, ArchivePreparation, handler, embeddings
    token = Path('/state/internal_token').read_text().strip()
    service = Egress(Ledger('/ledger/budget.sqlite'), token, 'synthetic-no-provider',
        prepare=ArchivePreparation('http://nocheh-app:8780', token),
        embedding=replace(embeddings({}), url='http://shared-provider:8317/v1/embeddings'),
        reasoning_key='synthetic-no-provider')
    ThreadingHTTPServer(('0.0.0.0', 8790), handler(service)).serve_forever()


if __name__ == '__main__':
    {'provider': provider, 'meter': meter}[sys.argv[1]]()
