"""Explicitly authorized synthetic rehearsal through an existing model provider.

This relay has no OAuth state or refresh logic. Only a selected chat-completions
route is forwarded, using read-only scoped client keys. Telegram stays local.
The Honcho caller must retain its production preparation and shared budget meter.
Request bodies, responses and credentials never enter the request journal.
"""
import hmac
import json
import os
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request

DEFAULT_REQUEST_LIMIT = 300
MAX_REQUEST_LIMIT = 10_000


def request_limit(environment):
    limit = int(environment.get('NOCHEH_FIXTURE_MODEL_REQUEST_LIMIT', str(DEFAULT_REQUEST_LIMIT)))
    if not 1 <= limit <= MAX_REQUEST_LIMIT:
        raise ValueError('invalid_rehearsal_limit')
    if limit > DEFAULT_REQUEST_LIMIT and environment.get('NOCHEH_ADDITIONAL_MODEL_REQUESTS_AUTHORIZED') != '1':
        raise ValueError('additional_request_authorization_required')
    return limit


class Admission:
    def __init__(self, journal, credentials, limit=DEFAULT_REQUEST_LIMIT):
        if type(limit) is not int or not 1 <= limit <= MAX_REQUEST_LIMIT:
            raise ValueError('invalid_rehearsal_limit')
        self.path = Path(journal)
        self.credentials = credentials
        self.limit = limit
        self.lock = threading.Lock()
        self.rows = [json.loads(line) for line in self.path.read_text().splitlines()] if self.path.exists() else []

    def reserve(self, authorization, payload):
        client = next((name for name, (local, _) in self.credentials.items()
                       if hmac.compare_digest(authorization, 'Bearer ' + local)), None)
        if client is None:
            raise PermissionError('fixture_client_denied')
        if not isinstance(payload, dict) or payload.get('model') != 'gpt-5.6-sol' or not isinstance(payload.get('messages'), list):
            raise ValueError('fixture_model_contract_denied')
        messages = payload['messages']
        first = messages[0].get('content') if messages and isinstance(messages[0], dict) else None
        category = 'detector' if isinstance(first, str) and first.startswith('Find secret values in the supplied data.') else 'chat'
        with self.lock:
            if len(self.rows) >= self.limit:
                raise PermissionError('fixture_request_limit_exhausted')
            row = {'number': len(self.rows) + 1, 'at': time.time(), 'client': client, 'category': category}
            # Persist admission before forwarding; restarting cannot reset it.
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with self.path.open('a') as file:
                self.path.chmod(0o600)
                file.write(json.dumps(row) + '\n')
                file.flush()
                os.fsync(file.fileno())
            self.rows.append(row)
        return self.credentials[client][1]

    def summary(self):
        with self.lock:
            return {'real_model': True, 'requests': len(self.rows), 'limit': self.limit,
                    'by_client': {client: sum(row['client'] == client for row in self.rows) for client in self.credentials},
                    'detector_requests': sum(row['category'] == 'detector' for row in self.rows)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def create_app(admission, upstream, telegram_state, opener=None):
    # A pinned container-name destination prevents a duplicate Compose service
    # alias from redirecting the operating provider back into this fixture.
    if upstream != 'http://nocheh-cliproxy-api-1:8317/v1/chat/completions':
        raise ValueError('existing_provider_destination_required')
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, StreamingResponse
    from tools.acceptance.telegram_mock import TelegramMock
    app = FastAPI()
    TelegramMock(telegram_state).install(app)
    transport = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    @app.get('/healthz')
    def health():
        return {'ok': True, 'synthetic_telegram': True, 'real_model': True}

    @app.get('/fixture/stats')
    def stats():
        return admission.summary()

    @app.get('/v1/models')
    def models():
        return {'object': 'list', 'data': [{'id': 'gpt-5.6-sol', 'object': 'model', 'owned_by': 'existing-provider'}]}

    @app.post('/v1/chat/completions')
    async def chat(request: Request):
        raw = await request.body()
        if len(raw) > 2 * 1024 * 1024:
            return JSONResponse({'error': {'message': 'fixture_request_bound'}}, status_code=413)
        try:
            key = admission.reserve(request.headers.get('authorization', ''), json.loads(raw))
        except PermissionError as error:
            return JSONResponse({'error': {'message': str(error)}}, status_code=403)
        except ValueError:
            return JSONResponse({'error': {'message': 'fixture_model_contract_denied'}}, status_code=400)
        # Opening the blocking transport in a worker keeps Telegram long polling
        # responsive while the real model is generating response headers.
        import asyncio
        try:
            response = await asyncio.to_thread(transport.open, urllib.request.Request(upstream, data=raw,
                headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}), timeout=180)
        except urllib.error.HTTPError as error:
            return JSONResponse({'error': {'message': 'existing_provider_rejected', 'status': error.code}}, status_code=error.code)
        except Exception:
            return JSONResponse({'error': {'message': 'existing_provider_unavailable'}}, status_code=502)

        def chunks():
            total = 0
            try:
                while True:
                    part = response.read1(65536)
                    if not part:
                        return
                    total += len(part)
                    if total > 16 * 1024 * 1024:
                        raise ValueError('fixture_response_bound')
                    yield part
            finally:
                response.close()
        return StreamingResponse(chunks(), status_code=response.status,
                                 media_type=response.headers.get('Content-Type', 'application/json'))

    return app


def main():
    if os.environ.get('NOCHEH_INSTALLATION_FIXTURE') != '1' or os.environ.get('NOCHEH_REAL_MODEL_AUTHORIZED') != '1':
        raise SystemExit('explicit_real_model_fixture_authorization_required')
    credentials = {}
    for name in ('hermes', 'honcho'):
        local = Path('/fixture-keys/' + name + '.key').read_text().strip()
        existing = Path('/existing-provider/' + name + '.key').read_text().strip()
        if min(len(local), len(existing)) < 32 or hmac.compare_digest(local, existing):
            raise ValueError('distinct_scoped_credentials_required')
        credentials[name] = (local, existing)
    import uvicorn
    app = create_app(Admission('/fixture-state/model-requests.jsonl', credentials, request_limit(os.environ)),
                     'http://nocheh-cliproxy-api-1:8317/v1/chat/completions', '/fixture-state/telegram.json')
    uvicorn.run(app, host='0.0.0.0', port=8317, log_level='warning', access_log=False)


if __name__ == '__main__':
    main()
