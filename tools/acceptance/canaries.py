"""Private marks the full tester plants in the owner's private chat, and the sweep that looks for them everywhere else.

`private_chat_stays_out_of_groups` plants each PRIVATEMARK<n> in the owner's private chat (a plain message, a native
note, a personal task, a private job and the owner's default role) and saves it in the fixture's canaries.json.
`project_groups_stay_apart` adds one more, a private message next to the search word its groups share, so the
private answer it opens in that chat (ADR-0249) is swept too. `forward_kept_apart_and_labelled` and
`own_file_stays_recallable` add a forward and a file's text, which long-term memory keeps with the owner's forwards and
files (ADR-0257). A member's private chat with Nocheh (step 4) is a home of its own: `member_private_chat_stays_with_the_member`
plants MEMBERMARKs there, in the member's message and in Nocheh's reply, and those may show only in that chat, and
in the owner's chat only in the separate message that answers the owner's ask about that member (step 4b).
`private_canaries_never_left_the_owner` then reads everything the fake Telegram (tools/acceptance/telegram_mock.py)
holds and looks for each mark outside where it may show. Nothing on the owner's private side reaches a group or a
member without a card in the private chat that names who will see it, and no planted mark ever gets such a card, so
a mark anywhere else is a leak.
"""
import json
import re
from pathlib import Path

FILE = 'canaries.json'


def save(directory, marks, owner, home=None, allowed=()):
    """Add marks ({mark: what holds it}) to the fixture's list. Marks of earlier runs on a kept fixture stay listed.

    A mark's home is the chat it was planted in, the owner's private chat unless `home` names another, such as a
    member's own private chat (step 4); `allowed` adds chats where it may also show. A mark is swept everywhere else."""
    path = Path(directory)/FILE
    known = load(directory) if path.exists() else {'owner': int(owner), 'marks': {}}
    if known['owner'] != int(owner):
        raise ValueError('canaries_owner_changed')
    value = {**known, 'owner': int(owner), 'marks': {**known['marks'], **marks}}
    home = int(owner) if home is None else int(home)
    if home != int(owner) or allowed:
        place = {'home': home, 'allowed': sorted({int(chat) for chat in allowed} - {home})}
        value['homes'] = {**known.get('homes', {}), **{mark: place for mark in marks}}
    write(path, value)
    return value


def shown(directory, marks, chat, message_ids):
    """Let saved marks show in these sent messages of one chat as well, and nowhere else there: the separate message
    that answers the owner's ask about a member (step 4b) may quote that member's chat in the owner's chat. Its
    later edits count as the same message."""
    path = Path(directory)/FILE
    value = load(directory)
    unknown = sorted(set(marks) - set(value['marks']))
    if unknown:
        raise ValueError('canaries_unknown_mark')
    messages = dict(value.get('messages', {}))
    for mark in marks:
        messages[mark] = sorted({tuple(item) for item in messages.get(mark, [])} | {(int(chat), int(number)) for number in message_ids})
    write(path, {**value, 'messages': {mark: [list(item) for item in items] for mark, items in messages.items()}})


def write(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True)+'\n')
    path.chmod(0o600)


def load(directory):
    """The saved marks. A missing or empty list fails: the sweep never passes on nothing."""
    path = Path(directory)/FILE
    if not path.exists():
        raise FileNotFoundError('canaries_missing: private_chat_stays_out_of_groups and project_groups_stay_apart plant them earlier in the same run')
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or type(value.get('owner')) is not int or not isinstance(value.get('marks'), dict) or not value['marks']:
        raise ValueError('canaries_invalid')
    homes, messages = value.get('homes', {}), value.get('messages', {})
    if (not isinstance(homes, dict) or not isinstance(messages, dict) or set(homes) - set(value['marks']) or set(messages) - set(value['marks'])
            or any(not isinstance(place, dict) or type(place.get('home')) is not int or not isinstance(place.get('allowed'), list)
                   or any(type(chat) is not int for chat in place['allowed']) for place in homes.values())
            or any(not isinstance(items, list) or any(not isinstance(item, list) or len(item) != 2 or any(type(part) is not int for part in item)
                                                       for item in items) for items in messages.values())):
        raise ValueError('canaries_invalid')
    return value


def places(planted):
    """Where each saved mark may show: {mark: {'home': chat, 'chats': {chats}, 'messages': {(chat, message id)}}}. A mark
    with no home of its own lives in the owner's private chat."""
    owner, homes, messages = planted['owner'], planted.get('homes', {}), planted.get('messages', {})
    found = {}
    for mark in planted['marks']:
        place = homes.get(mark) or {'home': owner, 'allowed': []}
        found[mark] = {'home': place['home'], 'chats': {place['home'], *place['allowed']},
                       'messages': {tuple(item) for item in messages.get(mark, [])}}
    return found


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


def leaks(state, marks, owner, where=None):
    """Each place a mark reached outside where it may show, from the fake Telegram's saved state.

    It reads every message sent (text, entities, buttons and reply parameters, as sent and as each edit set them), every
    answer to a press, shown only to the person who pressed, and the call log, which also holds sends and edits Telegram
    refused (only its latest 2000 calls are kept). A mark may show in the owner's private chat, or, given `where`
    (places()), in its own chats and its allowed messages. With owner None, every chat counts. Pure: it reads only its
    arguments; an empty list is a clean sweep.
    """
    owner = None if owner is None else int(owner)
    where = where or {}
    hits = []
    # A send in the call log is the same send as an allowed message when its parameters are the same.
    allowed_calls = {}
    for row in state.get('sent', []):
        message = row['message']
        key = (message['chat']['id'], message.get('message_id'))
        for mark, place in where.items():
            if key in place['messages']:
                for parameters in [row.get('parameters')]+[edit.get('parameters') for edit in row.get('edits', [])]:
                    allowed_calls.setdefault(mark, set()).add(json.dumps(parameters, sort_keys=True, ensure_ascii=False))

    def allowed(mark, chat, message=None, parameters=None):
        if owner is None:
            return False
        place = where.get(mark)
        if place is None:
            return chat == owner
        return (chat in place['chats'] or (message is not None and (chat, message) in place['messages'])
                or (parameters is not None and json.dumps(parameters, sort_keys=True, ensure_ascii=False) in allowed_calls.get(mark, ())))

    def scan(kind, chat, value, message=None, parameters=None, **extra):
        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
        hits.extend({'where': kind, 'chat': chat, 'mark': mark, **extra} for mark in found(text, marks)
                    if not allowed(mark, chat, message, parameters))

    for row in state.get('sent', []):
        message = row['message']
        chat, number = message['chat']['id'], message.get('message_id')
        scan('message', chat, {'parameters': row.get('parameters'), 'message': message}, number, message_id=number)
        for edit in row.get('edits', []):
            scan('edit', chat, edit.get('parameters'), number, message_id=number)
    # Telegram shows a press's answer only to the person who pressed.
    pressers = {str(item['callback_query']['id']): item['callback_query'].get('from', {}).get('id')
                for item in state.get('presses', []) if isinstance(item.get('callback_query'), dict)}
    for answer in state.get('answers', []):
        presser = pressers.get(str(answer.get('callback_query_id')))
        scan('answer', presser, (answer.get('text') or '')+('\n'+answer['url'] if isinstance(answer.get('url'), str) else ''))
    for call in state.get('calls', []):
        parameters = call.get('parameters') or {}
        reached = pressers.get(str(parameters.get('callback_query_id'))) if call.get('method') == 'answerCallbackQuery' else chat_of(parameters)
        scan('call', reached, parameters, parameters=parameters, method=call.get('method'))
    return hits
