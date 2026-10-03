"""Causal reply matching for real-model observations with late deliveries."""
import unittest
from tools.acceptance.model_rehearsal import replies_to


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


if __name__ == '__main__':
    unittest.main()
