"""The tester finds a chat's Nocheh id by its Telegram id labels in the owner's chat list (ADR-0250), never by building
one from a Telegram id: chats Nocheh first sees after step 2b, and their topics, have digest ids."""
import unittest
from unittest.mock import patch

from tools.acceptance.telegram_scenarios import Failed, Fixture

GROUP, NEW, NEW_TOPIC, UPGRADED = '-10042', 'a1'*32, 'b2'*32, 'c3'*32


def label(external, state='current'):
    return {'app': 'telegram', 'external': external, 'state': state}


ITEMS = [
    {'space_id': '123', 'kind': 'private', 'app_ids': [label('123')]},
    {'space_id': GROUP, 'kind': 'group', 'app_ids': [label(GROUP)]},
    # A topic carries its group's labels; it is found under its group by its key, never by the labels alone.
    {'space_id': '-10042/topic/7', 'kind': 'topic', 'parent_space': GROUP, 'topic_key': '7', 'app_ids': [label(GROUP)]},
    {'space_id': NEW, 'kind': 'group', 'app_ids': [label('-10045')]},
    {'space_id': NEW_TOPIC, 'kind': 'topic', 'parent_space': NEW, 'topic_key': '5', 'app_ids': [label('-10045')]},
    {'space_id': UPGRADED, 'kind': 'group', 'app_ids': [label('-10047'), label('-4046', 'old')]},
]


def fixture(pages):
    """A Fixture whose owner API answers from `pages` (one list of items per page)."""
    found = object.__new__(Fixture)
    calls = []

    def app(path, body=None, allow_error=False):
        calls.append(path)
        index = len([call for call in calls if call.startswith('/v1/conversations')])-1
        page = pages[min(index % len(pages), len(pages)-1)]
        last = index % len(pages) == len(pages)-1
        return {'items': page, 'next_cursor': None if last else page[-1]['space_id']}
    found.app = app
    return found, calls


class FixtureChatTest(unittest.TestCase):
    def test_a_chat_is_found_by_any_telegram_id_it_has_had(self):
        chats, _ = fixture([ITEMS])
        self.assertEqual(chats.chat(-10042), GROUP)
        self.assertEqual(chats.chat(123), '123')
        self.assertEqual(chats.chat(-10045), NEW)
        self.assertEqual(chats.chat(-10047), UPGRADED)
        self.assertEqual(chats.chat(-4046), UPGRADED, 'the old id names the same chat')

    def test_a_topic_is_found_under_its_group_by_its_key(self):
        chats, _ = fixture([ITEMS])
        self.assertEqual(chats.chat(-10042, 7), '-10042/topic/7')
        self.assertEqual(chats.chat(-10045, 5), NEW_TOPIC)
        with self.assertRaises(Failed):
            chats.chat(-10045, 7, seconds=0)

    def test_every_page_of_the_chat_list_is_read(self):
        chats, calls = fixture([ITEMS[:3], ITEMS[3:]])
        self.assertEqual(chats.chat(-4046), UPGRADED)
        self.assertEqual(calls, ['/v1/conversations?limit=100', '/v1/conversations?limit=100&after=-10042%2Ftopic%2F7'])

    def test_a_chat_not_yet_listed_is_waited_for_then_refused(self):
        chats, _ = fixture([ITEMS])
        with patch('tools.acceptance.telegram_scenarios.time.sleep'), \
             patch('tools.acceptance.telegram_scenarios.time.monotonic', side_effect=[0, 0, 61]):
            with self.assertRaisesRegex(Failed, 'chat_not_in_directory:-10099'):
                chats.chat(-10099)


if __name__ == '__main__':
    unittest.main()
