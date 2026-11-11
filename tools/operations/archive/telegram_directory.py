"""Owner-only Telegram identity hints; numeric IDs remain the authority."""
import json
import re
import subprocess
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from tools.operations.installation.configuration import load, compose

GROUP = re.compile(r'-[1-9]\d{0,18}\Z')
USER = re.compile(r'[1-9]\d{0,18}\Z')


def _clean(value, limit=200):
    return ' '.join(value.split())[:limit] if isinstance(value, str) else ''


def _id(value, pattern):
    text = str(value) if isinstance(value, int) and not isinstance(value, bool) else value
    return text if isinstance(text, str) and pattern.fullmatch(text) else ''


def _person(value):
    if not isinstance(value, dict) or value.get('is_bot') is True:
        return None
    identifier = _id(value.get('id'), USER)
    if not identifier:
        return None
    name = ' '.join(part for part in (_clean(value.get('first_name')), _clean(value.get('last_name'))) if part)[:200] or _clean(value.get('name'))
    username = _clean(value.get('username'), 100).lstrip('@')
    return {'id': identifier, 'name': name or None, 'username': '@' + username if username else None}


def _bot_api(token, method, **params):
    request = Request('https://api.telegram.org/bot' + token + '/' + method,
                      data=urlencode(params).encode(), method='POST')
    with urlopen(request, timeout=4) as response:
        raw = response.read(256 * 1024 + 1)
    if len(raw) > 256 * 1024:
        return None
    result = json.loads(raw)
    return result.get('result') if isinstance(result, dict) and result.get('ok') is True else None


def directory(state, archive=None, bot_api=_bot_api):
    values = load(state)
    selected = [group.strip() for group in values['TELEGRAM_GROUP_IDS'].split(',') if GROUP.fullmatch(group.strip())]
    if archive is None:
        try:
            from tools.operations.archive.archive import API
            archive = API().call('/v1/telegram/identities')
        except Exception:
            archive = {'groups': [], 'truncated': False}
    if not isinstance(archive, dict):
        archive = {'groups': [], 'truncated': False}
    groups = {}
    for observed in archive.get('groups', []):
        if not isinstance(observed, dict):
            continue
        identifier = _id(observed.get('id'), GROUP)
        if not identifier:
            continue
        users = {}
        for user in observed.get('users', []):
            person = _person(user) if isinstance(user, dict) else None
            if person:
                users[person['id']] = person
        groups[identifier] = {'id': identifier, 'name': _clean(observed.get('name')) or None, 'users': users}
    token = values['TELEGRAM_BOT_TOKEN']
    for identifier in selected[:20]:
        group = groups.setdefault(identifier, {'id': identifier, 'name': None, 'users': {}})
        if not token:
            continue
        try:
            chat = bot_api(token, 'getChat', chat_id=identifier)
            if isinstance(chat, dict) and _id(chat.get('id'), GROUP) == identifier and chat.get('type') in ('group', 'supergroup'):
                group['name'] = _clean(chat.get('title')) or group['name']
            administrators = bot_api(token, 'getChatAdministrators', chat_id=identifier)
            for member in administrators[:200] if isinstance(administrators, list) else []:
                person = _person(member.get('user')) if isinstance(member, dict) else None
                if person:
                    group['users'][person['id']] = person
            candidates = {values['TELEGRAM_OWNER_ID']}
            try:
                access = json.loads(values['TELEGRAM_GROUP_ACCESS']).get(identifier, {})
                candidates.update(access.get('granted', []))
                candidates.update(access.get('denied', []))
            except (TypeError, ValueError, AttributeError):
                pass
            for user_id in sorted(value for value in candidates if isinstance(value, str))[:40]:
                if not USER.fullmatch(user_id) or user_id in group['users']:
                    continue
                member = bot_api(token, 'getChatMember', chat_id=identifier, user_id=user_id)
                person = _person(member.get('user')) if isinstance(member, dict) else None
                if person and person['id'] == user_id:
                    group['users'][user_id] = person
        except Exception:
            # The archive and saved IDs remain useful during Bot API outages.
            continue
    result = []
    for group in groups.values():
        group['users'] = sorted(group['users'].values(), key=lambda user: (user['name'] or user['username'] or user['id']).casefold())
        result.append(group)
    result.sort(key=lambda group: (group['name'] or group['id']).casefold())
    return {'groups': result[:100], 'truncated': archive.get('truncated') is True or len(result) > 100 or len(selected) > 20}


def _bot_discovery(state):
    """Runs `discover-telegram` inside nocheh-telegram: it saves every update it reads, confirms
    none of them and sends no message, so nothing is lost when Telegram is turned on."""
    command, env = compose(state)
    try:
        result = subprocess.run(command + ['exec', '-T', 'nocheh-telegram', 'python', '-m', 'services.telegram.discover'],
                                env=env, capture_output=True, text=True, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('telegram_discovery_failed') from None
    if result.returncode or len(result.stdout) > 256 * 1024:
        raise ValueError('telegram_discovery_failed')
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise ValueError('telegram_discovery_failed') from None


def discover(state, bot_api=_bot_api, run=_bot_discovery):
    """Who wrote to the bot privately, for "Find my Telegram ID". Works only while
    Telegram is off, so it never competes with Nocheh reading the bot's messages."""
    values = load(state)
    token = values['TELEGRAM_BOT_TOKEN']
    if not token:
        raise ValueError('telegram_token_missing')
    if values['TELEGRAM_ENABLED'] == 'true':
        raise ValueError('telegram_running')
    try:
        bot_api(token, 'getMe')
    except HTTPError as error:
        error.close()
        # Telegram answers 401 for a revoked token and 404 for one that isn't a token.
        raise ValueError('telegram_token_refused' if error.code in (401, 404) else 'telegram_unreachable') from None
    except Exception:
        raise ValueError('telegram_unreachable') from None
    found = run(state)
    if not isinstance(found, dict):
        raise ValueError('telegram_discovery_failed')
    people = {}
    for chat in found.get('chats') or []:
        if not isinstance(chat, dict) or chat.get('chat_type') != 'private':
            continue
        identifier = _id(chat.get('sender_id'), USER)
        if identifier and identifier == _id(chat.get('chat_id'), USER):
            username = _clean(chat.get('sender_username'), 100).lstrip('@')
            people[identifier] = {'id': identifier, 'name': _clean(chat.get('sender_name')) or None,
                                  'username': '@' + username if username else None}
    bot = _clean(found.get('bot_username'), 100).lstrip('@')
    # Telegram returns at most 100 waiting updates, oldest first, and reading further would confirm
    # them; a full batch may hide the owner's newer message, so the dashboard says so.
    read = found.get('updates_fsynced')
    more = isinstance(read, int) and not isinstance(read, bool) and read >= 100
    return {'bot': '@' + bot if bot else None, 'people': list(people.values())[:20], 'more': more}
