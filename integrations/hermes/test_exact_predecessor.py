"""Exact-order questions must not turn partial history into a false claim."""
import unittest
from unittest.mock import patch

from .assistant_turn import PREDECESSOR_UNVERIFIED, exact_predecessor_question, run


class ExactPredecessorTests(unittest.TestCase):
    def test_immediate_predecessor_is_not_inferred_from_current_question(self):
        body={'source_text':'Can you tell me what I asked immediately before this message?',
              'text':'Can you tell me what I asked immediately before this message?\n\n[Archive source: nocheh:event:synthetic]',
              'session_id':'synthetic-session'}
        with patch('integrations.hermes.assistant_turn.sealed_dependencies',side_effect=AssertionError('no model turn')):
            result=run(body)
        self.assertEqual(result,{'state':'done','text':PREDECESSOR_UNVERIFIED,'session_id':'synthetic-session'})
        self.assertNotIn('Can you tell me',result['text'])

    def test_only_exact_order_questions_take_conservative_path(self):
        for wording in ('What did I say right before this message?',
                        'Which message did I send directly before my question?'):
            self.assertTrue(exact_predecessor_question(wording))
        for wording in ('What did I ask yesterday?',
                        'What was the last message you can access?',
                        'Please send a message immediately before lunch.'):
            self.assertFalse(exact_predecessor_question(wording))


if __name__=='__main__':unittest.main()
