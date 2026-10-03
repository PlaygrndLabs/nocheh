"""Causal reply matching for real-model observations with late deliveries."""
import unittest
from unittest.mock import patch
from tools.acceptance.model_rehearsal import main, replies_to


class ModelRehearsalReplyTests(unittest.TestCase):
    def test_late_and_unrelated_replies_do_not_become_the_current_answer(self):
        late = {'parameters': {'reply_parameters': '{"message_id":7}'}, 'message': {'text': 'earlier answer', 'chat': {'id': 123}}}
        current = {'parameters': {'reply_parameters': {'message_id': 8}}, 'message': {'text': 'current answer', 'chat': {'id': 123}}}
        unbound = {'parameters': {}, 'message': {'text': 'unrelated'}}
        self.assertEqual(replies_to({'sent': [late, current, unbound]}, 8, 123), [current])
        self.assertEqual(replies_to({'sent': [late, unbound]}, 8, 123), [])

    def test_same_message_number_in_another_chat_is_not_the_answer(self):
        other = {'parameters': {'reply_parameters': {'message_id': 8}}, 'message': {'chat': {'id': -10042}}}
        self.assertEqual(replies_to({'sent': [other]}, 8, 123), [])

    def test_duplicate_physical_replies_remain_visible(self):
        row = {'parameters': {'reply_parameters': '{"message_id":8}'}, 'message': {'text': 'answer', 'chat': {'id': 123}}}
        self.assertEqual(len(replies_to({'sent': [row, row]}, 8, 123)), 2)

    def test_invalid_continuation_stops_before_opening_a_fixture(self):
        for options in (['--start-at', 'retired_fact'], ['--isolation-topic', '0'], ['--isolation-topic', '7']):
            with self.subTest(options=options), patch('sys.argv', ['model-rehearsal', '--directory', '/unused', *options]), \
                    patch('sys.stderr'), patch('tools.acceptance.model_rehearsal.Fixture') as fixture:
                with self.assertRaises(SystemExit) as stopped:
                    main()
                self.assertEqual(stopped.exception.code, 2)
                fixture.assert_not_called()


if __name__ == '__main__':
    unittest.main()
