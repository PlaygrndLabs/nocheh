"""Explicitly authorized synthetic rehearsal through an existing model provider.

This relay has no OAuth state or refresh logic. Only a selected chat-completions
route is forwarded, using read-only scoped client keys. Telegram stays local.
The Honcho caller must retain its production preparation and shared budget meter.
Request bodies, responses and credentials never enter the request journal.
"""
import asyncio
import hmac
import json
import os
from pathlib import Path
import socket
import threading
import time
import urllib.error
import urllib.request
import math

DEFAULT_REQUEST_LIMIT = 300
MAX_REQUEST_LIMIT = 10_000


class ProviderCooldown(Exception):
    def __init__(self, seconds):
        self.seconds = seconds


def request_limit(environment):
    limit = int(environment.get('NOCHEH_FIXTURE_MODEL_REQUEST_LIMIT', str(DEFAULT_REQUEST_LIMIT)))
    if not 1 <= limit <= MAX_REQUEST_LIMIT:
        raise ValueError('invalid_rehearsal_limit')
    if limit > DEFAULT_REQUEST_LIMIT and environment.get('NOCHEH_ADDITIONAL_MODEL_REQUESTS_AUTHORIZED') != '1':
        raise ValueError('additional_request_authorization_required')
    return limit


def detector_interval_ms(environment):
    interval = int(environment.get('NOCHEH_FIXTURE_DETECTOR_INTERVAL_MS', '0'))
    if not 0 <= interval <= 10000:
        raise ValueError('invalid_rehearsal_detector_interval')
    return interval


def is_detector(payload):
    messages = payload.get('messages') if isinstance(payload, dict) else None
    first = messages[0].get('content') if isinstance(messages, list) and messages and isinstance(messages[0], dict) else None
    return isinstance(first, str) and first.startswith('Find secret values in the supplied data.')


class Admission:
    def __init__(self, journal, credentials, limit=DEFAULT_REQUEST_LIMIT):
        if type(limit) is not int or not 1 <= limit <= MAX_REQUEST_LIMIT:
            raise ValueError('invalid_rehearsal_limit')
        self.path = Path(journal)
        self.outcomes = self.path.with_name(self.path.stem + '-outcomes.jsonl')
        self.credentials = credentials
        self.limit = limit
        self.lock = threading.Lock()
        self.rows = [json.loads(line) for line in self.path.read_text().splitlines()] if self.path.exists() else []
        self.cooldown_until = 0.0
        self.rate_limit_streak = 0
        self.last_rate_limit_at = 0.0
        if self.outcomes.exists():
            outcomes = [json.loads(line) for line in self.outcomes.read_text().splitlines() if line.strip()]
            for outcome in sorted(outcomes, key=lambda row: row.get('at', self.rows[row['number'] - 1]['at']
                                                        + row['elapsed_ms'] / 1000)):
                at = outcome.get('at', self.rows[outcome['number'] - 1]['at'] + outcome['elapsed_ms'] / 1000)
                if outcome['status'] == 429:
                    self.rate_limit_streak += 1
                    self.last_rate_limit_at = at
                    self.cooldown_until = max(self.cooldown_until, at + min(3600, 60 * 2 ** min(self.rate_limit_streak - 1, 6)))
                elif 200 <= outcome['status'] < 300 and self.rows[outcome['number'] - 1]['at'] > self.last_rate_limit_at:
                    self.rate_limit_streak = 0
                    self.cooldown_until = 0.0

    def reserve(self, authorization, payload, route_available=lambda: True):
        client = next((name for name, (local, _) in self.credentials.items()
                       if hmac.compare_digest(authorization, 'Bearer ' + local)), None)
        if client is None:
            raise PermissionError('fixture_client_denied')
        if not isinstance(payload, dict) or payload.get('model') != 'gpt-5.6-sol' or not isinstance(payload.get('messages'), list):
            raise ValueError('fixture_model_contract_denied')
        category = 'detector' if is_detector(payload) else 'chat'
        with self.lock:
            if len(self.rows) >= self.limit:
                raise PermissionError('fixture_request_limit_exhausted')
            remaining = self.cooldown_until - time.time()
            if remaining > 0:
                raise ProviderCooldown(math.ceil(remaining))
            if not route_available():
                raise ConnectionError('existing_provider_unavailable')
            row = {'number': len(self.rows) + 1, 'at': time.time(), 'client': client, 'category': category}
            # Persist admission before forwarding; restarting cannot reset it.
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with self.path.open('a') as file:
                self.path.chmod(0o600)
                file.write(json.dumps(row) + '\n')
                file.flush()
                os.fsync(file.fileno())
            self.rows.append(row)
        return self.credentials[client][1], row['number']

    def record_outcome(self, number, result, status, elapsed_ms, retry_after=None):
        if (type(number) is not int or number < 1 or number > len(self.rows)
                or result not in ('upstream_headers', 'upstream_http', 'transport_error')
                or type(status) is not int or not 100 <= status <= 599
                or type(elapsed_ms) is not int or elapsed_ms < 0):
            raise ValueError('invalid_fixture_outcome')
        row = {'number': number, 'result': result, 'status': status, 'elapsed_ms': elapsed_ms, 'at': time.time()}
        with self.lock:
            if status == 429:
                self.rate_limit_streak += 1
                self.last_rate_limit_at = row['at']
                delay = min(3600, 60 * 2 ** min(self.rate_limit_streak - 1, 6))
                if type(retry_after) is int and 0 < retry_after <= 3600:
                    delay = max(delay, retry_after)
                self.cooldown_until = max(self.cooldown_until, row['at'] + delay)
            elif 200 <= status < 300 and self.rows[number - 1]['at'] > self.last_rate_limit_at:
                self.rate_limit_streak = 0
                self.cooldown_until = 0.0
            self.outcomes.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with self.outcomes.open('a') as file:
                self.outcomes.chmod(0o600)
                file.write(json.dumps(row) + '\n')
                file.flush()
                os.fsync(file.fileno())

    def summary(self):
        with self.lock:
            return {'real_model': True, 'requests': len(self.rows), 'limit': self.limit,
                    'by_client': {client: sum(row['client'] == client for row in self.rows) for client in self.credentials},
                    'detector_requests': sum(row['category'] == 'detector' for row in self.rows)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def existing_route_available():
    """Check only the pinned local provider socket; never refresh its login."""
    try:
        with socket.create_connection(('nocheh-cliproxy-api-1', 8317), timeout=1):
            return True
    except OSError:
        return False


def create_app(admission, upstream, telegram_state, opener=None, route_probe=None, detector_interval=0):
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
    route_available = route_probe or existing_route_available
    if type(detector_interval) is not int or not 0 <= detector_interval <= 10000:
        raise ValueError('invalid_rehearsal_detector_interval')
    detector_lock = asyncio.Lock()
    next_detector_at = 0.0

    @app.get('/healthz')
    def health():
        if not route_available():
            return JSONResponse({'ok': False, 'error': 'existing_provider_unavailable'}, status_code=503)
        return {'ok': True, 'synthetic_telegram': True, 'real_model': True}

    @app.get('/fixture/stats')
    def stats():
        return admission.summary()

    @app.get('/v1/models')
    def models():
        return {'object': 'list', 'data': [{'id': 'gpt-5.6-sol', 'object': 'model', 'owned_by': 'existing-provider'}]}

    @app.post('/v1/chat/completions')
    async def chat(request: Request):
        nonlocal next_detector_at
        raw = await request.body()
        if len(raw) > 2 * 1024 * 1024:
            return JSONResponse({'error': {'message': 'fixture_request_bound'}}, status_code=413)
        try:
            payload = json.loads(raw)
        except ValueError:
            return JSONResponse({'error': {'message': 'fixture_model_contract_denied'}}, status_code=400)
        if is_detector(payload) and detector_interval:
            # Delay before reservation so queued detector work does not spend a
            # journal admission or touch the provider while another call runs.
            async with detector_lock:
                delay = next_detector_at - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                next_detector_at = time.monotonic() + detector_interval / 1000
                return await forward(request, raw, payload)
        return await forward(request, raw, payload)

    async def forward(request, raw, payload):
        try:
            key, number = admission.reserve(request.headers.get('authorization', ''), payload, route_available)
        except PermissionError as error:
            return JSONResponse({'error': {'message': str(error)}}, status_code=403)
        except ConnectionError:
            return JSONResponse({'error': {'message': 'existing_provider_unavailable'}}, status_code=503)
        except ProviderCooldown as error:
            return JSONResponse({'error': {'message': 'existing_provider_rate_limited'}}, status_code=429,
                                headers={'Retry-After': str(error.seconds)})
        except ValueError:
            return JSONResponse({'error': {'message': 'fixture_model_contract_denied'}}, status_code=400)
        # Opening the blocking transport in a worker keeps Telegram long polling
        # responsive while the real model is generating response headers.
        started = time.monotonic()
        try:
            response = await asyncio.to_thread(transport.open, urllib.request.Request(upstream, data=raw,
                headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}), timeout=180)
        except urllib.error.HTTPError as error:
            header = error.headers.get('Retry-After', '') if error.headers else ''
            retry_after = int(header) if header.isdecimal() and len(header) <= 4 else None
            admission.record_outcome(number, 'upstream_http', error.code, round((time.monotonic() - started) * 1000), retry_after)
            return JSONResponse({'error': {'message': 'existing_provider_rejected', 'status': error.code}}, status_code=error.code)
        except Exception:
            admission.record_outcome(number, 'transport_error', 502, round((time.monotonic() - started) * 1000))
            return JSONResponse({'error': {'message': 'existing_provider_unavailable'}}, status_code=502)

        admission.record_outcome(number, 'upstream_headers', response.status, round((time.monotonic() - started) * 1000))

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
                     'http://nocheh-cliproxy-api-1:8317/v1/chat/completions', '/fixture-state/telegram.json',
                     detector_interval=detector_interval_ms(os.environ))
    uvicorn.run(app, host='0.0.0.0', port=8317, log_level='warning', access_log=False)


if __name__ == '__main__':
    main()
