"""Text of a voice note or audio file for Nocheh's preparation step, by Hermes's own transcriber.

Nocheh keeps the original audio and checks this text for secrets; this only transcribes it.
Hermes's transcriber converts audio a provider rejects, trims silence and splits long
recordings. The provider and model are chosen in Settings › Models (Voice notes). Each
recording is transcribed in a child process that holds only that provider's key, bounded in
time and memory, with a Hermes home of its own, so the reply profile keeps transcription off.
"""
import base64
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

from . import usage

LIMIT = 50 * 1024 * 1024
TEXT_LIMIT = 1_000_000
SECONDS = 600
MEMORY = 2 * 1024 * 1024 * 1024
ROUTE = 'NOCHEH_TRANSCRIPTION_ROUTE_'
KEY = 'NOCHEH_TRANSCRIPTION_KEY'
# The formats Hermes's transcriber accepts; a name or MIME type outside them is guessed from the kind.
FORMATS = {'.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.oga', '.opus', '.aac', '.flac', '.caf'}
MIME = {'audio/ogg': '.ogg', 'audio/opus': '.opus', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a',
        'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
        'audio/wave': '.wav', 'audio/webm': '.webm', 'audio/flac': '.flac', 'audio/x-flac': '.flac', 'video/mp4': '.mp4'}
KINDS = {'voice': '.ogg', 'video_note': '.mp4'}
# Hermes reports a provider failure as text; its HTTP status says whether a retry can help.
STATUS = re.compile(r'\AAPI error: Error code: (\d{3})')


def route():
    """The Settings › Models choice for voice notes, or None while it has no key."""
    url, key, model = (os.environ.get(ROUTE + name, '').strip() for name in ('URL', 'KEY', 'MODEL'))
    return {'url': url.rstrip('/'), 'key': key, 'model': model,
            'provider': os.environ.get(ROUTE + 'PROVIDER', '').strip()} if url and key and model else None


def price_per_minute():
    try:
        value = float(os.environ.get(ROUTE + 'PRICE', ''))
    except ValueError:
        return None
    return value if 0 <= value < 10 else None


def transcribe(body):
    if body.get('check') is True:
        return {'configured': route() is not None}
    selected = route()
    if selected is None:
        return {'state': 'not_configured'}
    data = base64.b64decode(body['bytes_base64'], validate=True)
    if len(data) > LIMIT:
        return {'state': 'too_large'}
    hint = {name: body.get(name) if isinstance(body.get(name), str) else '' for name in ('name', 'mime_type', 'kind')}
    hint['duration'] = body.get('duration') if type(body.get('duration')) in (int, float) and 0 <= body['duration'] < 10**6 else None

    def bounded():
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY, MEMORY))
    with tempfile.TemporaryDirectory(prefix='nocheh-voice-') as home:
        Path(home, 'config.yaml').write_text(json.dumps({'stt': {'enabled': True, 'provider': 'openai', 'openai': {
            'model': selected['model'], 'base_url': selected['url'], 'api_key': '${env:' + KEY + '}'}}}))
        environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'PYTHONPATH': os.environ.get('PYTHONPATH', ''),
                       'HOME': home, 'TMPDIR': home, 'HERMES_HOME': home, KEY: selected['key'],
                       **{name: os.environ[name] for name in ('HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy',
                                                              'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE') if name in os.environ}}
        try:
            child = subprocess.run([sys.executable, '-m', 'services.hermes.voice_text', json.dumps(hint)], input=data,
                                   capture_output=True, timeout=SECONDS, env=environment, preexec_fn=bounded, check=False)
            result = json.loads((child.stdout.strip().splitlines() or [b''])[-1])
        except subprocess.TimeoutExpired:
            result = {'state': 'failed', 'reason': 'timed_out'}
        except ValueError:
            result = {'state': 'failed', 'reason': 'nocheh_error'}
    if not isinstance(result, dict) or result.get('state') not in ('done', 'silent', 'failed', 'unsupported', 'too_large'):
        result = {'state': 'failed', 'reason': 'nocheh_error'}
    seconds = result.get('seconds') if type(result.get('seconds')) in (int, float) else hint['duration']
    if result['state'] in ('done', 'silent', 'failed'):
        spent = {'calls': 1, 'audio_seconds': seconds or 0}
        price = price_per_minute()
        if price is not None and seconds is not None and result['state'] != 'failed':
            spent['cost_usd'] = math.ceil(seconds) / 60 * price
        usage.record('transcription', spent, selected['model'], failed=result['state'] == 'failed',
                     provider=selected['provider'], reason=result.get('reason'))
    return {key: value for key, value in result.items() if key in ('state', 'text', 'reason')}


def suffix(hint):
    """The recording's format from its name, its MIME type, or its kind."""
    for candidate in (PurePosixPath(hint.get('name', '').replace('\\', '/')).suffix.lower(),
                      MIME.get(hint.get('mime_type', '').split(';')[0].strip().lower(), ''), KINDS.get(hint.get('kind', ''), '')):
        if candidate in FORMATS:
            return candidate
    return ''


def duration(path):
    try:
        found = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                               capture_output=True, text=True, timeout=30, check=False).stdout.strip()
        value = float(found)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    return value if math.isfinite(value) and value >= 0 else None


def reason(error):
    """Why Hermes's transcriber failed, as one of the usage tracker's reasons."""
    if error.startswith(('Connection error', 'Request timeout')):
        return 'timed_out' if 'timed out' in error.lower() or error.startswith('Request timeout') else 'provider_error'
    status = STATUS.match(error)
    code = int(status.group(1)) if status else 0
    return {429: 'rate_limited', 401: 'key_rejected', 403: 'key_rejected', 404: 'model_not_found', 413: 'too_long'}.get(
        code, 'provider_error' if code >= 500 else 'bad_answer' if code else 'unknown')


def read(data, hint):
    from tools.transcription_tools import transcribe_audio
    kind = suffix(hint)
    if not kind:
        return {'state': 'unsupported'}
    with tempfile.TemporaryDirectory(prefix='voice-') as work:
        path = str(Path(work, 'voice' + kind))
        Path(path).write_bytes(data)
        seconds = duration(path)
        result = transcribe_audio(path)
    text = result.get('transcript') if isinstance(result, dict) else None
    if isinstance(result, dict) and result.get('success') and isinstance(text, str) and text.strip():
        if len(text) > TEXT_LIMIT:
            text = text[:TEXT_LIMIT] + '\n\n[The rest of this recording is not included.]'
        return {'state': 'done', 'text': text, 'seconds': seconds}
    error = str(result.get('error') or '') if isinstance(result, dict) else ''
    if error.startswith('Unsupported format'):
        return {'state': 'unsupported'}
    if isinstance(result, dict) and result.get('success'):
        return {'state': 'silent', 'seconds': seconds}
    return {'state': 'failed', 'reason': reason(error), 'seconds': seconds}


if __name__ == '__main__':
    import logging
    logging.disable(logging.CRITICAL)
    print(json.dumps(read(sys.stdin.buffer.read(LIMIT + 1), json.loads(sys.argv[1])), ensure_ascii=False))
