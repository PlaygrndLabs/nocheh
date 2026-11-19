"""The owner's ask about a member (step 4b, ADR-0262) in the brain: its attempt, its ask and its read-only tools."""
import unittest

from .assistant_gateway import continuation_id, session_title
from .assistant_turn import ALLOWED_TOOLS, DATA_TOOLS, MEMBER_READ_DATA_TOOLS, MEMBER_READ_TOOLS, MEMBER_READ_TOOLSETS, turn_tools
from .turn_process import member_read

ASK = 'd' * 32


class MemberReadTests(unittest.TestCase):
    def test_its_attempt_names_its_ask_and_is_never_a_message_turns_or_a_continuations(self):
        asked = {'ask': ASK, 'member': '"Synthetic Member"'}
        self.assertIsNone(continuation_id({'attempt': 'm1-' + ASK, 'member_read': asked}))
        self.assertIsNone(continuation_id({'attempt': 'm2-' + ASK, 'member_read': asked}))
        for body in ({'attempt': 1, 'member_read': asked}, {'attempt': 'm1-' + 'e' * 32, 'member_read': asked},
                     {'attempt': 'm0-' + ASK, 'member_read': asked}, {'attempt': 'm1-' + ASK, 'member_read': 'yes'},
                     {'attempt': 'm1-' + ASK, 'member_read': asked, 'continuation': 'ab' * 32},
                     {'attempt': 'm1-' + ASK, 'member_read': asked, 'control_reply': {'text': 'x'}}):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, 'invalid_member_read'): continuation_id(body)
        # Without an ask, its attempt is no message turn's.
        with self.assertRaisesRegex(ValueError, 'invalid_dispatch_attempt'): continuation_id({'attempt': 'm1-' + ASK})

    def test_its_ask_is_checked(self):
        self.assertEqual(member_read({'ask': ASK, 'member': 'Sam'}), {'ask': ASK, 'member': 'Sam'})
        for value in (None, {'ask': ASK}, {'ask': 'D' * 32, 'member': 'Sam'}, {'ask': ASK, 'member': ''}, {'ask': ASK, 'member': 'Sam\nOwner'},
                      {'ask': ASK, 'member': 'x' * 301}, {'ask': ASK, 'member': 'Sam', 'reads': ['-20']}):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'invalid_member_read'): member_read(value)

    def test_it_only_reads_that_chat(self):
        removed, allowed = turn_tools(False, False, member_read=True)
        self.assertEqual(allowed, {'mcp__nocheh__archive_search', 'mcp__nocheh__archive_read', 'mcp__nocheh__archive_page'})
        self.assertEqual(allowed, MEMBER_READ_TOOLS)
        self.assertEqual(MEMBER_READ_DATA_TOOLS, MEMBER_READ_TOOLS)
        self.assertEqual(MEMBER_READ_TOOLSETS, ['mcp-nocheh'])
        for name in ('memory', 'session_search', 'skills_list', 'skill_view', 'skill_manage', 'mcp__nocheh__memory_search',
                     'mcp__nocheh__memory_recall', 'mcp__nocheh__tasks', 'mcp__nocheh__ask_member_chat', 'mcp__nocheh__action_request'):
            self.assertIn(name, removed)
            self.assertNotIn(name, allowed)
        # The owner's own turn may ask about a member; the tool is one of Nocheh's data tools.
        self.assertIn('mcp__nocheh__ask_member_chat', DATA_TOOLS)
        self.assertIn('mcp__nocheh__ask_member_chat', ALLOWED_TOOLS)

    def test_its_session_is_named_as_an_ask_never_as_the_owners_private_chat(self):
        private = {'chat': {'id': 42, 'type': 'private', 'first_name': 'Sam'}}
        self.assertEqual(session_title(private, False, member_read=True), 'Ask about a member')
        self.assertEqual(session_title(private, True), 'Private chat')


if __name__ == '__main__':
    unittest.main()
