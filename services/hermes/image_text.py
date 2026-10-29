"""Text and a short description of an image for Nocheh's preparation step, by Hermes's own vision tool.

Nocheh keeps the original image and checks this text for secrets; this only reads it.
Hermes's vision tool detects the format, converts formats a model rejects and shrinks
oversized images. The provider and model are the Images part of Settings › Models. Each
image is read in a child process that holds only that provider's key, bounded in time and
memory, with a Hermes home of its own; Hermes's own usage accounting reports its tokens.
"""
import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from . import usage
from .prompts import text as prompt_text

LIMIT = 50 * 1024 * 1024
TEXT_LIMIT = 100_000
SECONDS = 240
MEMORY = 2 * 1024 * 1024 * 1024
ROUTE = 'NOCHEH_IMAGE_ROUTE_'
KEY = 'NOCHEH_IMAGE_KEY'
# A provider that is busy or unreachable may answer a moment later.
TRANSIENT = ('429', 'rate limit', 'overloaded', '500', '502', '503', '504', 'timed out', 'timeout', 'connection')


def route():
    """The Settings › Models choice for images, or None while it has none."""
    url, key, model = (os.environ.get(ROUTE + name, '').strip() for name in ('URL', 'KEY', 'MODEL'))
    return {'url': url.rstrip('/'), 'key': key, 'model': model,
            'provider': os.environ.get(ROUTE + 'PROVIDER', '').strip()} if url and key and model else None


def read_image(body):
    selected = route()
    if selected is None:
        return {'state': 'not_configured'}
    data = base64.b64decode(body['bytes_base64'], validate=True)
    if len(data) > LIMIT:
        return {'state': 'too_large'}
    instruction = prompt_text(body.get('prompts'), 'images.read')

    def bounded():
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY, MEMORY))
    with tempfile.TemporaryDirectory(prefix='nocheh-image-') as home:
        Path(home, 'config.yaml').write_text(json.dumps({'auxiliary': {'vision': {
            'provider': 'custom', 'model': selected['model'], 'base_url': selected['url'], 'api_key': '${env:' + KEY + '}'}}}))
        environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'PYTHONPATH': os.environ.get('PYTHONPATH', ''),
                       'HOME': home, 'TMPDIR': home, 'HERMES_HOME': home, KEY: selected['key'],
                       **{name: os.environ[name] for name in ('HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy',
                                                              'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE') if name in os.environ}}
        try:
            child = subprocess.run([sys.executable, '-m', 'services.hermes.image_text', json.dumps({'prompt': instruction})], input=data,
                                   capture_output=True, timeout=SECONDS, env=environment, preexec_fn=bounded, check=False)
            result = json.loads((child.stdout.strip().splitlines() or [b''])[-1])
        except subprocess.TimeoutExpired:
            result = {'state': 'failed', 'reason': 'timed_out'}
        except ValueError:
            result = {'state': 'failed', 'reason': 'nocheh_error'}
    if not isinstance(result, dict) or result.get('state') not in ('done', 'failed', 'unreadable'):
        result = {'state': 'failed', 'reason': 'nocheh_error'}
    if result['state'] in ('done', 'failed'):
        spent = {name: value for name, value in (result.get('usage') or {}).items() if name in (*usage.TOKENS, 'cost_usd')} \
            if isinstance(result.get('usage'), dict) else {}
        if 'cost_usd' not in spent and (spent.get('input_tokens') or spent.get('output_tokens')):
            try:
                cost = usage.price([{'model': selected['model'], 'base_url': selected['url'], 'calls': 1, **spent}])[0]
            except Exception:
                cost = None
            if cost is not None:
                spent['cost_usd'] = cost
        usage.record('image', {'calls': 1, **spent}, selected['model'], failed=result['state'] == 'failed',
                     provider=selected['provider'], reason=result.get('reason'))
    return {key: value for key, value in result.items() if key in ('state', 'text', 'reason')}


class Accounting:
    """Collects what Hermes's auxiliary client reports for the one vision call."""
    def __init__(self):
        self.usage = {}

    def record_auxiliary_usage(self, session_id, task, *, estimated_cost_usd=None, **amounts):
        for name in usage.TOKENS:
            self.usage[name] = self.usage.get(name, 0) + (amounts.get(name) or 0)
        if isinstance(amounts.get('model'), str):
            self.usage['model'] = amounts['model']
        if estimated_cost_usd is not None:
            self.usage['cost_usd'] = self.usage.get('cost_usd', 0.0) + float(estimated_cost_usd)


def reason(error):
    lowered = error.lower()
    if any(hint in lowered for hint in ('content_policy', 'refus', 'safety')):
        return 'refused'
    return 'provider_error' if any(hint in lowered for hint in TRANSIENT) else 'bad_answer'


def read(data, hint):
    from agent.aux_accounting import set_accounting_context
    from tools.vision_tools import vision_analyze_tool
    accounting = Accounting()
    set_accounting_context(accounting, 'nocheh-image')
    with tempfile.TemporaryDirectory(prefix='image-') as work:
        path = Path(work, 'image')
        path.write_bytes(data)
        result = json.loads(asyncio.run(vision_analyze_tool(str(path), hint['prompt'])))
    spent = accounting.usage
    analysis = result.get('analysis') if isinstance(result, dict) else None
    if isinstance(result, dict) and result.get('success') and isinstance(analysis, str) and analysis.strip():
        return {'state': 'done', 'text': analysis[:TEXT_LIMIT], 'usage': spent}
    error = str(result.get('error') or '') if isinstance(result, dict) else ''
    if not spent and 'analyzing image' in error.lower() and not any(hint in error.lower() for hint in TRANSIENT):
        return {'state': 'unreadable'}
    return {'state': 'failed', 'reason': reason(error), 'usage': spent}


if __name__ == '__main__':
    import logging
    logging.disable(logging.CRITICAL)
    print(json.dumps(read(sys.stdin.buffer.read(LIMIT + 1), json.loads(sys.argv[1])), ensure_ascii=False))
