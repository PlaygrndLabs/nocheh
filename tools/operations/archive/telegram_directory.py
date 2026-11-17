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


def _chat(value):
    """A Nocheh chat id, as storage names a chat: opaque, printable, no whitespace, bounded. Never parsed (ADR-0252)."""
    return value if isinstance(value, str) and 0 < len(value) <= 200 and all(32 < ord(c) != 127 for c in value) else ''


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


def directory(state, archive=None, bot_api=_bot_api, served=None):
    """Each group storage knows, with who is in it. Telegram is asked about each group Nocheh serves now (`served`, the
    app's served list: services/chats.py) by its Telegram id now, and about the people saved for it under any Telegram id
    it has had."""
    values = load(state)
    if archive is None:
        try:
            from tools.operations.archive.archive import API
            archive = API().call('/v1/telegram/identities')
        except Exception:
            archive = {'groups': [], 'truncated': False}
    if not isinstance(archive, dict):
        archive = {'groups': [], 'truncated': False}
    if served is None:
        from services.chats import Served
        try:
            from tools.operations.archive.archive import served_chats
            served = served_chats()
        except Exception:
            served = Served.empty(False)
    # A group keeps its Nocheh chat id, which is how the dashboard opens it and how the served list names it; its
    # Telegram ids only name it to Telegram (ADR-0252). Nocheh ids and Telegram ids are kept apart and never compared.
    groups = {}
    for observed in archive.get('groups', []):
        if not isinstance(observed, dict):
            continue
        identifier = _chat(observed.get('id'))
        if not identifier or ('chat', identifier) in groups:
            continue
        external = _id(observed.get('external'), GROUP)
        users = {}
        for user in observed.get('users', []):
            person = _person(user) if isinstance(user, dict) else None
            if person:
                # Whether they are in the group, and whether its own messages show them: the People list shows only those.
                if user.get('state') in ('in', 'left'):
                    person['state'] = user['state']
                if isinstance(user.get('seen'), bool):
                    person['seen'] = user['seen']
                # A member with a switch for this group, whether Nocheh ever saw them there or not (step 3).
                if user.get('member') is True:
                    person['member'] = True
                users[person['id']] = person
        groups[('chat', identifier)] = {'id': identifier, 'external': external or None, 'name': _clean(observed.get('name')) or None, 'users': users}
    token = values['TELEGRAM_BOT_TOKEN']
    selected = served.groups()
    # A name is the person's, not the group's: one Telegram gave in any group serves every other group in this request,
    # and someone Telegram refused (a 4xx, such as for a person who was never in that group) is not asked about again.
    names, refused = {}, set()
    for served_group in selected[:20]:
        identifier = _id((served.address(served_group) or ('',))[0], GROUP)
        if not identifier:
            continue
        group = groups.setdefault(('chat', served_group), {'id': served_group, 'external': identifier, 'name': None, 'users': {}})
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
                    if person['name'] or person['username']:
                        names.setdefault(person['id'], {'name': person['name'], 'username': person['username']})
            # Telegram is asked for the names of the owner and of the members storage lists for this group that no update
            # named yet, such as a member added by Telegram user ID who never wrote there (step 3). Only the name is used:
            # whether they are in the group stays what storage knows. Only the unnamed count toward the 40 asked.
            candidates = {values['TELEGRAM_OWNER_ID']} | {user_id for user_id, person in group['users'].items() if person.get('member')}
            wanted = []
            for user_id in sorted(value for value in candidates if isinstance(value, str) and USER.fullmatch(value)):
                known = group['users'].get(user_id)
                if known and (known['name'] or known['username']):
                    continue
                if user_id in names:
                    if known:
                        group['users'][user_id] = {**known, **names[user_id]}
                elif user_id not in refused:
                    wanted.append(user_id)
            for user_id in wanted[:40]:
                try:
                    member = bot_api(token, 'getChatMember', chat_id=identifier, user_id=user_id)
                except HTTPError as error:
                    error.close()
                    if not 400 <= error.code < 500:
                        raise
                    # Telegram refused this one person; the others in the group are still asked.
                    refused.add(user_id)
                    continue
                person = _person(member.get('user')) if isinstance(member, dict) else None
                if person and person['id'] == user_id:
                    names[user_id] = {'name': person['name'], 'username': person['username']}
                    group['users'][user_id] = {'id': user_id, **(group['users'].get(user_id) or {}), **names[user_id]}
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
