"""The Telegram mini app: its address, its tunnel and the menu buttons (the members' page for every private chat, the
owner's page for the owner's own)."""
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


def launch_check(values):
    """What the dashboard checks a phone's mini app sign-in with, read from .env each time (ADR-0251): the bot's
    public ID, the owner's Telegram ID and whether the bot is on Telegram's test servers. Never the bot token."""
    return {'bot_id': bot_id(values.get('TELEGRAM_BOT_TOKEN', '')), 'owner_id': values.get('TELEGRAM_OWNER_ID', ''),
            'test_environment': values.get('TELEGRAM_TEST_ENVIRONMENT') == 'true'}


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


def menu_button(values, bot_api, shown_before=True, former_owner=None):
    """Puts the mini app on the menu buttons, or takes it off (ADR-0265 D11). Every private chat with the bot gets the
    members' page (`/m/`) as its default button, and the owner's own private chat keeps the owner's page (`/`) as its
    own button. Only active members get anything in the members' page; anyone else sees it closed. Both addresses are
    made from NOCHEH_MINI_APP_URL alone. Turned off, both go back to Telegram's default button. A former owner's chat
    (`former_owner`, the owner before a change of TELEGRAM_OWNER_ID) loses its own button, so it falls back to the
    default: as a member they then reach the members' page."""
    token, owner = values.get('TELEGRAM_BOT_TOKEN', ''), values.get('TELEGRAM_OWNER_ID', '')
    if values.get('TELEGRAM_ENABLED') != 'true' or not token or not owner: return 'skipped'
    if not enabled(values) and not shown_before: return 'off'
    if enabled(values):
        names = [name.strip() for name in values.get('TELEGRAM_BOT_NAMES', '').split(',') if name.strip()]
        base, text = values['NOCHEH_MINI_APP_URL'].rstrip('/'), (names[0] if names else 'Nocheh')[:64]
        everyone = {'type': 'web_app', 'text': text, 'web_app': {'url': base + '/m/'}}
        own = {'type': 'web_app', 'text': text, 'web_app': {'url': base + '/'}}
    else:
        everyone = own = {'type': 'default'}
    done = True
    former = str(former_owner or '')
    # The default for every private chat first, then the owner's own chat over it, then a former owner's chat back to
    # the default.
    calls = [({}, everyone), ({'chat_id': owner}, own)]
    if former and former != owner: calls.append(({'chat_id': former}, {'type': 'default'}))
    for params, button in calls:
        try:
            answer = bot_api(token, 'setChatMenuButton', **params, menu_button=json.dumps(button, ensure_ascii=False))
        except Exception:
            answer = None
        done = done and answer is True
    return ('shown' if enabled(values) else 'removed') if done else 'failed'
