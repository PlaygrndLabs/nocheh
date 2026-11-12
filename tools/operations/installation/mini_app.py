"""The Telegram mini app: its address, its tunnel and the owner's menu button."""
import base64
import binascii
import hashlib
import json
import re
from urllib.parse import urlsplit

SERVICES = ('nocheh-miniapp', 'nocheh-tunnel')
HOST = re.compile(r'(?=.{4,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z')
TUNNEL_TOKEN = re.compile(r'[A-Za-z0-9+/=_-]{32,4096}\Z')


def validate(values):
    address, token = values.get('NOCHEH_MINI_APP_URL', ''), values.get('CLOUDFLARE_TUNNEL_TOKEN', '')
    if address:
        url = urlsplit(address)
        if (url.scheme != 'https' or not HOST.fullmatch(url.hostname or '') or url.port or url.username
                or url.password or url.query or url.fragment or url.path not in ('', '/')):
            raise ValueError('NOCHEH_MINI_APP_URL must be an https address such as https://nocheh.example.com')
    if token and not TUNNEL_TOKEN.fullmatch(token):
        raise ValueError('CLOUDFLARE_TUNNEL_TOKEN must be the token Cloudflare shows for the tunnel')
    if bool(address) != bool(token):
        raise ValueError('The mini app needs both its address and the tunnel token')


def enabled(values):
    return (values.get('TELEGRAM_ENABLED') == 'true' and bool(values.get('NOCHEH_MINI_APP_URL'))
            and bool(values.get('CLOUDFLARE_TUNNEL_TOKEN')))


def bot_id(token):
    """The bot's public numeric ID is the part of its token before the colon."""
    match = re.match(r'([1-9]\d{0,18}):', token or '')
    return match.group(1) if match else ''


def tunnel_id(token):
    """The tunnel a Cloudflare tunnel token runs: its "t" field. Another token shape compares by a digest of itself."""
    if not token: return ''
    try:
        found = json.loads(base64.b64decode(token + '=' * (-len(token) % 4), altchars=b'-_' if '-' in token or '_' in token else None)).get('t')
        if isinstance(found, str) and re.fullmatch(r'[A-Za-z0-9-]{8,64}', found): return found.lower()
    except (ValueError, AttributeError, binascii.Error): pass
    return 'token-' + hashlib.sha256(token.encode()).hexdigest()[:24]


def host(values):
    try: return (urlsplit(values.get('NOCHEH_MINI_APP_URL') or '').hostname or '').lower()
    except ValueError: return ''


def environment(values):
    """The bot, mini app address and tunnel, also as labels, so another workspace can see what this one holds (ADR-0245)."""
    bot = bot_id(values.get('TELEGRAM_BOT_TOKEN', ''))
    return {'TELEGRAM_BOT_ID': bot, 'NOCHEH_POLLED_BOT_ID': bot if values.get('TELEGRAM_ENABLED') == 'true' else '',
            'NOCHEH_MINI_APP_HOST': host(values),
            'NOCHEH_TUNNEL_ID': tunnel_id(values.get('CLOUDFLARE_TUNNEL_TOKEN', ''))}


def menu_button(values, bot_api, shown_before=True):
    """Puts the mini app on the menu button of the owner's private chat, or takes it off."""
    token, owner = values.get('TELEGRAM_BOT_TOKEN', ''), values.get('TELEGRAM_OWNER_ID', '')
    if values.get('TELEGRAM_ENABLED') != 'true' or not token or not owner: return 'skipped'
    if not enabled(values) and not shown_before: return 'off'
    if enabled(values):
        names = [name.strip() for name in values.get('TELEGRAM_BOT_NAMES', '').split(',') if name.strip()]
        button = {'type': 'web_app', 'text': (names[0] if names else 'Nocheh')[:64],
                  'web_app': {'url': values['NOCHEH_MINI_APP_URL'].rstrip('/') + '/'}}
    else:
        button = {'type': 'default'}
    try:
        done = bot_api(token, 'setChatMenuButton', chat_id=owner, menu_button=json.dumps(button, ensure_ascii=False))
    except Exception:
        done = None
    return ('shown' if enabled(values) else 'removed') if done is True else 'failed'
