"""Private marks the full tester plants in the owner's private chat, and the sweep that looks for them everywhere else.

`private_chat_stays_out_of_groups` plants each PRIVATEMARK<n> in the owner's private chat (a plain message, a native
note, a personal task, a private job and the owner's default role) and saves it in the fixture's canaries.json.
`project_groups_stay_apart` adds one more, a private message next to the search word its groups share, so the
private answer it opens in that chat (ADR-0248) is swept too. `private_canaries_never_left_the_owner` then reads
everything the fake Telegram (tools/acceptance/telegram_mock.py) holds and looks for any of them outside that chat.
Nothing on the owner's private side reaches a group or a member without a card in the private chat that names who
will see it, and no planted mark ever gets such a card, so a mark anywhere else is a leak.
"""
import json
import re
from pathlib import Path

FILE = 'canaries.json'


def save(directory, marks, owner):
    """Add marks ({mark: what holds it}) to the fixture's list. Marks of earlier runs on a kept fixture stay listed."""
    path = Path(directory)/FILE
    known = load(directory) if path.exists() else {'owner': int(owner), 'marks': {}}
    if known['owner'] != int(owner):
        raise ValueError('canaries_owner_changed')
    value = {'owner': int(owner), 'marks': {**known['marks'], **marks}}
    path.write_text(json.dumps(value, indent=2, sort_keys=True)+'\n')
    path.chmod(0o600)
    return value


def load(directory):
    """The saved marks. A missing or empty list fails: the sweep never passes on nothing."""
    path = Path(directory)/FILE
    if not path.exists():
        raise FileNotFoundError('canaries_missing: private_chat_stays_out_of_groups and project_groups_stay_apart plant them earlier in the same run')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or type(value.get('owner')) is not int or not isinstance(value.get('marks'), dict) or not value['marks']:
        raise ValueError('canaries_invalid')
    return value


def found(text, marks):
    """The marks in a text. PRIVATEMARK12 is not found in PRIVATEMARK123."""
    if not marks:
        raise ValueError('canaries_empty')
    pattern = re.compile('(?:'+'|'.join(re.escape(mark) for mark in sorted(marks, key=len, reverse=True))+')(?![0-9])')
    return sorted(set(pattern.findall(text)))


def chat_of(parameters):
    """The chat a Bot API call reaches: its chat_id, or the chat of a command menu's scope; None when everyone sees it."""
    chat = parameters.get('chat_id')
    scope = parameters.get('scope')
    if chat is None and isinstance(scope, str):
        try:
            scope = json.loads(scope)
        except ValueError:
            scope = None
    if chat is None and isinstance(scope, dict):
        chat = scope.get('chat_id')
    try:
        return int(chat)
    except (TypeError, ValueError):
        return None


def leaks(state, marks, owner):
    """Each place a mark reached outside the owner's private chat, from the fake Telegram's saved state.

    It reads every message sent to another chat (text, entities, buttons and reply parameters, as sent and as each edit
    set them), every answer to a press by someone other than the owner (its popup text and any link it opens), and the
    call log, which also holds sends and edits Telegram refused (only its latest 2000 calls are kept). With owner None,
    every chat counts. Pure: it reads only its arguments; an empty list is a clean sweep.
    """
    owner = None if owner is None else int(owner)
    hits = []

    def scan(where, chat, value, **extra):
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
        hits.extend({'where': where, 'chat': chat, 'mark': mark, **extra} for mark in found(text, marks))

    for row in state.get('sent', []):
        message = row['message']
        chat = message['chat']['id']
        if chat == owner:
            continue
        scan('message', chat, {'parameters': row.get('parameters'), 'message': message}, message_id=message.get('message_id'))
        for edit in row.get('edits', []):
            scan('edit', chat, edit.get('parameters'), message_id=message.get('message_id'))
    # Telegram shows a press's answer only to the person who pressed.
    pressers = {str(item['callback_query']['id']): item['callback_query'].get('from', {}).get('id')
                for item in state.get('presses', []) if isinstance(item.get('callback_query'), dict)}
    for answer in state.get('answers', []):
        presser = pressers.get(str(answer.get('callback_query_id')))
        if presser != owner:
            scan('answer', presser, (answer.get('text') or '')+('\n'+answer['url'] if isinstance(answer.get('url'), str) else ''))
    for call in state.get('calls', []):
        parameters = call.get('parameters') or {}
        reached = pressers.get(str(parameters.get('callback_query_id'))) if call.get('method') == 'answerCallbackQuery' else chat_of(parameters)
        if reached != owner:
            scan('call', reached, parameters, method=call.get('method'))
    return hits
