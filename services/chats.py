"""The chats Nocheh serves, as the app tells the Python services (ADR-0252).

GET {ARCHIVE_URL}/internal/chats, behind the service token, lists every served chat with its topics and the owner's
private chat, by their Nocheh chat ids, each with its ids in its app (the current one and older ones, such as a group's
id before Telegram upgraded it), and the owner's account in the app. A service asks this list what a chat is, whether it
is served and where it is in Telegram now; it never reads a chat's kind, parent or topic from the shape of an id, and it
never compares a Nocheh chat id with a Telegram id. A list that cannot be read serves nothing (ADR-0242, fail closed).
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.request

KINDS = ('private', 'group', 'topic')
# Every state the app may list (src/chat-wire.ts chatStates). Only 'active' is served, and a topic follows its chat's
# state, whatever its own row holds.
STATES = ('active', 'off', 'pending', 'left', 'removed', 'could_not_leave', 'archived')


def _text(value, limit=200):
    """An opaque id: printable, no whitespace, bounded. Never parsed."""
    if not isinstance(value, str) or not 0 < len(value) <= limit or any(ord(c) < 33 or ord(c) == 127 for c in value):
        raise ValueError('invalid_served_chats')
    return value


class Served:
    """One read of the served list. Unknown ids are not served, have no address and resolve to nothing."""

    def __init__(self, payload):
        if not isinstance(payload, dict) or set(payload) - {'epoch', 'owner_chat', 'owner_account', 'chats'}: raise ValueError('invalid_served_chats')
        epoch, owner, account, chats = payload.get('epoch', 0), payload.get('owner_chat'), payload.get('owner_account'), payload.get('chats', [])
        if type(epoch) is not int or epoch < 0 or not isinstance(chats, list) or len(chats) > 10000: raise ValueError('invalid_served_chats')
        # A list read from the app, or the empty one a failed read leaves (`empty(False)`): nothing is served either way,
        # but a caller that must not take a failed read for an answer can tell them apart.
        self.available = True
        self.epoch, self.owner_chat = epoch, None if owner is None else _text(owner)
        if account is not None and (not isinstance(account, dict) or set(account) != {'app', 'external'}): raise ValueError('invalid_served_chats')
        self.owner_account = None if account is None else {'app': _text(account['app'], 32), 'external': _text(account['external'])}
        self.chats, self._external, self._topics = {}, {}, {}
        for chat in chats:
            if not isinstance(chat, dict): raise ValueError('invalid_served_chats')
            row = {'id': _text(chat.get('id')), 'app': _text(chat.get('app'), 32), 'kind': chat.get('kind'),
                   'parent_id': None if chat.get('parent_id') is None else _text(chat.get('parent_id')),
                   'topic_key': None if chat.get('topic_key') is None else _text(chat.get('topic_key')), 'state': chat.get('state'),
                   'app_ids': []}
            if row['kind'] not in KINDS or row['state'] not in STATES or (row['kind'] == 'topic') != (row['parent_id'] is not None) or \
                    (row['kind'] == 'topic') != (row['topic_key'] is not None) or row['id'] in self.chats: raise ValueError('invalid_served_chats')
            ids = chat.get('app_ids', [])
            # A topic has no app ids of its own: it is its chat's, with its key.
            if not isinstance(ids, list) or row['kind'] == 'topic' and ids: raise ValueError('invalid_served_chats')
            for entry in ids:
                if not isinstance(entry, dict) or entry.get('state') not in ('current', 'old'): raise ValueError('invalid_served_chats')
                external = _text(entry.get('external'))
                if (row['app'], external) in self._external: raise ValueError('invalid_served_chats')
                self._external[(row['app'], external)] = row['id']
                row['app_ids'].append({'external': external, 'state': entry['state']})
            # The current id first, as the app lists it.
            row['app_ids'].sort(key=lambda entry: entry['state'] != 'current')
            if row['kind'] != 'topic' and sum(entry['state'] == 'current' for entry in row['app_ids']) > 1: raise ValueError('invalid_served_chats')
            self.chats[row['id']] = row
        for row in self.chats.values():
            if row['kind'] == 'topic':
                parent = self.chats.get(row['parent_id'])
                if parent is None or parent['kind'] == 'topic': raise ValueError('invalid_served_chats')
                self._topics[(row['parent_id'], row['topic_key'])] = row['id']

    @classmethod
    def empty(cls, available=True):
        """Nothing is served: what a service holds until its first successful read, or after a failed one (unavailable)."""
        served = cls({'epoch': 0, 'owner_chat': None, 'owner_account': None, 'chats': []})
        served.available = available
        return served

    @classmethod
    def of(cls, owner_chat=None, owner_account=None, groups=(), topics=(), old=None, epoch=0, app='telegram'):
        """A list for tests and policy files: `owner_chat` and each of `groups` is a chat whose Nocheh id is its own app id
        (as a chat stored before step 2b keeps); `topics` holds (topic id, parent id, key); `old` maps a chat to its older
        app ids; `groups` may also hold (chat id, current app id) pairs for a chat first seen after step 2b."""
        chats, old = [], old or {}
        if owner_chat is not None:
            chats.append({'id': owner_chat, 'app': app, 'kind': 'private', 'parent_id': None, 'topic_key': None, 'state': 'active',
                          'app_ids': [{'external': owner_chat, 'state': 'current'}]})
        for group in groups:
            chat, current = group if isinstance(group, tuple) else (group, group)
            chats.append({'id': chat, 'app': app, 'kind': 'group', 'parent_id': None, 'topic_key': None, 'state': 'active',
                          'app_ids': [{'external': current, 'state': 'current'}, *({'external': value, 'state': 'old'} for value in old.get(chat, ()))]})
        for topic, parent, key in topics:
            chats.append({'id': topic, 'app': app, 'kind': 'topic', 'parent_id': parent, 'topic_key': str(key), 'state': 'active', 'app_ids': []})
        account = owner_account if owner_account is not None else owner_chat
        return cls({'epoch': epoch, 'owner_chat': owner_chat, 'owner_account': None if account is None else {'app': app, 'external': account},
                    'chats': chats})

    # ── what a chat is ──────────────────────────────────────────────────────────────────────────

    def chat(self, chat_id):
        return self.chats.get(chat_id) if isinstance(chat_id, str) else None

    def kind(self, chat_id):
        row = self.chat(chat_id)
        return row['kind'] if row else None

    def parent(self, chat_id):
        """A topic's chat; None for a chat, or an id the list does not hold."""
        row = self.chat(chat_id)
        return row['parent_id'] if row else None

    def chat_of(self, chat_id):
        """The chat itself, or a topic's chat; None for an id the list does not hold."""
        row = self.chat(chat_id)
        return None if row is None else row['parent_id'] or row['id']

    def served(self, chat_id):
        """The chat, or a topic's chat, is active."""
        chat = self.chat(self.chat_of(chat_id))
        return bool(chat) and chat['state'] == 'active'

    def is_owner(self, chat_id):
        """The owner's private chat, or one of its topics."""
        return self.owner_chat is not None and self.chat_of(chat_id) == self.owner_chat

    def group(self, chat_id):
        """A served group, or a topic of one: its group's id, else None."""
        chat = self.chat_of(chat_id)
        return chat if self.kind(chat) == 'group' and self.served(chat) else None

    def groups(self):
        """Every served group, by its Nocheh id, sorted."""
        return sorted(row['id'] for row in self.chats.values() if row['kind'] == 'group' and row['state'] == 'active')

    def topics(self, chat_id):
        return sorted(row['id'] for row in self.chats.values() if row['parent_id'] == chat_id)

    # ── where it is in the app ──────────────────────────────────────────────────────────────────

    def address(self, chat_id):
        """(app id now, topic key or None) of a chat or topic; None for an id the list does not hold."""
        row, chat = self.chat(chat_id), self.chat(self.chat_of(chat_id))
        if not row or not chat: return None
        current = next((entry['external'] for entry in chat['app_ids'] if entry['state'] == 'current'), None)
        return None if current is None else (current, row['topic_key'])

    def binding(self, chat_id):
        """The app binding a turn pass carries for this chat or topic: {app, chat, topic}."""
        address, row = self.address(chat_id), self.chat(chat_id)
        return None if address is None else {'app': row['app'], 'chat': address[0], 'topic': address[1]}

    def app_ids(self, chat_id):
        """Every app id the chat (or a topic's chat) has had, current first."""
        chat = self.chat(self.chat_of(chat_id))
        return [entry['external'] for entry in chat['app_ids']] if chat else []

    def resolve(self, external, topic=None, app='telegram'):
        """The Nocheh chat an app id names (current or old), or that chat's topic with this key; None when the list holds
        none. A topic with no row reads nothing."""
        chat = self._external.get((app, str(external))) if isinstance(external, (str, int)) and not isinstance(external, bool) else None
        if chat is None or topic is None or topic == '': return chat
        return self._topics.get((chat, str(topic)))

    def owner_external(self):
        """The owner's private chat's app id now, or None."""
        address = self.address(self.owner_chat) if self.owner_chat else None
        return address[0] if address else None

    def owner_user(self):
        """The owner's account in the app (Telegram: the owner's user id), or None."""
        return self.owner_account['external'] if self.owner_account else None

    def served_externals(self):
        """Every app id, current and old, of every served group."""
        return sorted(external for group in self.groups() for external in self.app_ids(group))


class ServedList:
    """A process's served list: read on first use, again when it is older than the caller allows, and again (at most once
    a second) while a pass carries a newer guard epoch than the list was read at, since every served change moves the
    epoch. A chat or topic the app recorded after the list was read (a new forum topic, a group's new Telegram id) moves
    no epoch: a caller that needs one names it with `holds`, and a list that does not hold it is read again (at most once
    a second) before the caller decides. A read that fails holds nothing, so nothing is served until a read succeeds; it
    is tried again at most once a second."""

    def __init__(self, url=None, token=None, opener=None, clock=time.monotonic):
        self._url, self._token, self._open, self._clock = url, token, opener or urllib.request.urlopen, clock
        self._lock, self._value, self._read_at, self._failed_at = threading.Lock(), None, 0.0, None

    def _fetch(self):
        url = (self._url() if callable(self._url) else self._url) or os.environ.get('ARCHIVE_URL', 'http://nocheh-app:8780')
        token = self._token() if callable(self._token) else self._token
        request = urllib.request.Request(url.rstrip('/') + '/internal/chats', headers={'Authorization': 'Bearer ' + token})
        with self._open(request, timeout=10) as response:
            return Served(json.loads(response.read(8 * 1024 * 1024)))

    def get(self, epoch=None, max_age=5.0, holds=None):
        """The list, read again when it is too old, when `epoch` is newer than it was read at, or when `holds` (a test of
        the list: does it hold the chat this caller needs?) fails on it."""
        with self._lock:
            now = self._clock()
            newer = type(epoch) is int and self._value is not None and epoch > self._value.epoch and now - self._read_at >= 1.0
            missing = holds is not None and self._value is not None and now - self._read_at >= 1.0 and not holds(self._value)
            if self._value is not None and now - self._read_at <= max_age and not newer and not missing: return self._value
            if self._failed_at is not None and now - self._failed_at < 1.0: return Served.empty(False)
            try:
                self._value, self._read_at, self._failed_at = self._fetch(), now, None
            except Exception:
                self._value, self._failed_at = None, now
                return Served.empty(False)
            return self._value


class Fixed:
    """A served list that never changes, for tests and policy files."""

    def __init__(self, served):
        self.value = served

    def get(self, epoch=None, max_age=5.0, holds=None):
        return self.value
