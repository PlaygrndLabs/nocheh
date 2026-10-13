"""Model providers and the provider and model each part of Nocheh uses.

Every provider speaks the OpenAI-compatible API (`/chat/completions`,
`/models`, `/embeddings`). OpenAI and Anthropic are presets with fixed
addresses; a custom provider is a name, an HTTPS address and an API key. One
default provider and model serves every reasoning part unless a part names its
own. A part with no provider is unconfigured: a fresh installation is valid and
starts, and that part's model calls fail with `provider_not_configured` until a
provider is chosen in Settings › Models. Embeddings always name their own
provider.
"""
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from urllib.parse import urlsplit

# Installation rehearsals serve models from this local fixture; nothing else may use http.
FIXTURE_URL = 'http://model-fixture:8317/v1'
PRESETS = {
    'openai': {'name': 'OpenAI', 'url': 'https://api.openai.com/v1', 'key': 'OPENAI_API_KEY'},
    'anthropic': {'name': 'Anthropic', 'url': 'https://api.anthropic.com/v1', 'key': 'ANTHROPIC_API_KEY'},
}
# Reasoning parts: (label, provider setting, model setting).
PARTS = {
    'reply': ('Replies (Hermes)', 'NOCHEH_REPLY_PROVIDER', 'NOCHEH_REPLY_MODEL'),
    'memory': ('Memory (Honcho)', 'NOCHEH_MEMORY_PROVIDER', 'NOCHEH_MEMORY_MODEL'),
    'guard': ('Secret check', 'NOCHEH_GUARD_PROVIDER', 'NOCHEH_GUARD_MODEL'),
}
DEFAULTS = {
    'NOCHEH_PROVIDER': '',
    'NOCHEH_REPLY_PROVIDER': '', 'NOCHEH_REPLY_MODEL': '',
    'NOCHEH_MEMORY_PROVIDER': '', 'NOCHEH_MEMORY_MODEL': '',
    'NOCHEH_GUARD_PROVIDER': '', 'NOCHEH_GUARD_MODEL': '',
    'NOCHEH_PROVIDERS': '[]', 'NOCHEH_PROVIDER_KEYS': '{}', 'ANTHROPIC_API_KEY': '',
}
KEY_SETTINGS = {'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NOCHEH_PROVIDER_KEYS'}
MAX_CUSTOM = 10
ID = re.compile(r'[a-z0-9][a-z0-9-]{0,31}')
MODEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}')


@dataclass(frozen=True)
class Route:
    part: str
    provider: str
    url: str
    model: str
    key: str = field(default='', repr=False)

    @property
    def configured(self):
        return bool(self.provider)


def _json(values, name, kind):
    try:
        parsed = json.loads(values.get(name) or DEFAULTS[name])
    except ValueError:
        raise ValueError(name + ' must be JSON') from None
    if not isinstance(parsed, kind):
        raise ValueError(name + ' has the wrong shape')
    return parsed


def fixture_url(url):
    """The rehearsal fixture's address, accepted only inside an installation fixture."""
    return os.environ.get('NOCHEH_INSTALLATION_FIXTURE') == '1' and isinstance(url, str) and url.rstrip('/') == FIXTURE_URL


def valid_url(url):
    if fixture_url(url):
        return True
    parts = urlsplit(url) if isinstance(url, str) else None
    return bool(parts and parts.scheme == 'https' and parts.hostname and not parts.username
                and not parts.password and not parts.query and not parts.fragment and len(url) <= 300)


def custom(values):
    rows = _json(values, 'NOCHEH_PROVIDERS', list)
    if len(rows) > MAX_CUSTOM:
        raise ValueError(f'At most {MAX_CUSTOM} custom providers')
    result, seen = [], set(PRESETS)
    for row in rows:
        if not isinstance(row, dict) or set(row) - {'id', 'name', 'url'}:
            raise ValueError('A custom provider has an id, a name and a URL')
        ident, name, url = row.get('id'), row.get('name'), row.get('url')
        if not isinstance(ident, str) or not ID.fullmatch(ident) or ident in seen:
            raise ValueError('Each custom provider needs its own short lowercase id')
        if not isinstance(name, str) or not name.strip() or len(name) > 40:
            raise ValueError('Each custom provider needs a name of up to 40 characters')
        if not valid_url(url):
            raise ValueError('A custom provider URL must be an https:// address without a password or query')
        seen.add(ident)
        result.append({'id': ident, 'name': name.strip(), 'url': url.rstrip('/')})
    return result


def providers(values):
    """Every provider by id, presets first."""
    result = {ident: {'id': ident, 'name': preset['name'], 'kind': ident, 'url': preset['url']}
              for ident, preset in PRESETS.items()}
    for row in custom(values):
        result[row['id']] = {**row, 'kind': 'custom'}
    return result


def keys(values):
    stored = _json(values, 'NOCHEH_PROVIDER_KEYS', dict)
    if any(not isinstance(k, str) or not isinstance(v, str) for k, v in stored.items()):
        raise ValueError('NOCHEH_PROVIDER_KEYS must map provider ids to keys')
    return stored


def key(values, provider):
    if not provider:
        return ''
    if provider in PRESETS:
        return (values.get(PRESETS[provider]['key']) or '').strip()
    return (keys(values).get(provider) or '').strip()


def merge_keys(current, changes):
    """Keys the owner typed are added or replaced; keys of removed providers are dropped.
    The browser never receives stored keys, so it sends only new ones."""
    stored = keys(current)
    if 'NOCHEH_PROVIDER_KEYS' in changes:
        added = _json(changes, 'NOCHEH_PROVIDER_KEYS', dict)
        if any(not isinstance(k, str) or not isinstance(v, str) for k, v in added.items()):
            raise ValueError('Provider keys must be text')
        stored.update({k: v.strip() for k, v in added.items() if v.strip()})
    present = {row['id'] for row in custom({**current, **changes})}
    return json.dumps({k: v for k, v in sorted(stored.items()) if k in present}, separators=(',', ':'))


def route(values, part):
    if part not in PARTS:
        raise ValueError('unknown_model_part')
    _, provider_setting, model_setting = PARTS[part]
    provider = (values.get(provider_setting) or '').strip() or (values.get('NOCHEH_PROVIDER') or '').strip()
    model = (values.get(model_setting) or '').strip() or (values.get('NOCHEH_MODEL') or '').strip()
    if not provider:
        return Route(part, '', '', model)
    known = providers(values)
    if provider not in known:
        raise ValueError(PARTS[part][0] + ' uses a provider that is not configured')
    return Route(part, provider, known[provider]['url'], model, key(values, provider))


def embedding_route(values):
    """Where memory embeddings are sent."""
    provider = (values.get('NOCHEH_EMBEDDING_PROVIDER') or 'openai').strip()
    known = providers(values)
    if provider == 'anthropic' or provider not in known:
        raise ValueError('Memory search needs an OpenAI-compatible provider with embeddings, such as OpenAI')
    return Route('embedding', provider, known[provider]['url'], (values.get('NOCHEH_EMBEDDING_MODEL') or '').strip(),
                 key(values, provider))


def routes(values):
    return {part: route(values, part) for part in PARTS}


def validate(values):
    known = providers(values)
    keys(values)
    default = (values.get('NOCHEH_PROVIDER') or '').strip()
    if default and default not in known:
        raise ValueError('The default provider is not configured')
    for part, (label, provider_setting, model_setting) in PARTS.items():
        chosen = (values.get(provider_setting) or '').strip()
        if chosen and chosen not in known:
            raise ValueError(label + ' uses a provider that is not configured')
        selected = route(values, part)
        if not selected.configured:
            continue
        if not MODEL.fullmatch(selected.model):
            raise ValueError(label + ' needs a model name')
        if not selected.key:
            raise ValueError(label + ' uses ' + known[selected.provider]['name'] + ', which has no API key')
    embedding_route(values)


def environment(values):
    """Resolved routes for Compose; keys go only to the services that call providers.
    An unconfigured part gets empty values."""
    selected = routes(values)
    result = {}
    for part, name in (('reply', 'REPLY'), ('guard', 'GUARD')):
        current = selected[part]
        configured = current.configured
        result.update({f'NOCHEH_{name}_ROUTE_URL': current.url, f'NOCHEH_{name}_ROUTE_MODEL': current.model if configured else '',
                       f'NOCHEH_{name}_ROUTE_KEY': current.key, f'NOCHEH_{name}_ROUTE_PROVIDER': current.provider})
    result['NOCHEH_MEMORY_ROUTE_MODEL'] = selected['memory'].model if selected['memory'].configured else ''
    return result


def list_models(values, provider, opener=None, url=None, secret=None):
    """Model IDs an external provider lists; the key never leaves this process.
    An unsaved custom provider is listed from the address and key being typed. A saved
    key is only sent to the saved address, so a typed address needs its own key."""
    known = providers(values)
    if not isinstance(provider, str) or not ID.fullmatch(provider):
        raise ValueError('unknown_provider')
    saved = known.get(provider)
    if provider in PRESETS or url is None:
        if not saved:
            raise ValueError('unknown_provider')
        url = saved['url']
    elif not valid_url(url):
        return {'provider': provider, 'models': [], 'error': 'invalid_url'}
    url = url.rstrip('/')
    if secret is not None and (not isinstance(secret, str) or len(secret) > 4096
                               or not secret.strip().isprintable()):
        return {'provider': provider, 'models': [], 'error': 'invalid_key'}
    secret = (secret or '').strip()
    if not secret:
        same = saved and saved['url'].rstrip('/') == url
        secret = key(values, provider) if same else ''
    if not secret:
        return {'provider': provider, 'models': [], 'error': 'missing_key'}
    kind = saved['kind'] if saved else 'custom'
    # Anthropic lists models with its own key header; the others use a bearer key.
    headers = ({'x-api-key': secret, 'anthropic-version': '2023-06-01'} if kind == 'anthropic'
               else {'Authorization': 'Bearer ' + secret})
    headers['Accept'] = 'application/json'
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler(urllib.request.getproxies()))
    try:
        request = urllib.request.Request(url + '/models', headers=headers)
        with opener.open(request, timeout=15) as response:
            body = json.loads(response.read(2 * 1024 * 1024 + 1))
    except urllib.error.HTTPError as error:
        error.close()
        return {'provider': provider, 'models': [], 'error': 'http_' + str(error.code)}
    except (OSError, ValueError):
        return {'provider': provider, 'models': [], 'error': 'unreachable'}
    rows = body.get('data') if isinstance(body, dict) else None
    models = sorted({row['id'] for row in rows or [] if isinstance(row, dict) and isinstance(row.get('id'), str)
                     and MODEL.fullmatch(row['id'])})
    return {'provider': provider, 'models': models[:500]}
