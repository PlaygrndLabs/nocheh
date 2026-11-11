import unittest

from .assistant_gateway import continuation_id

LEADER='ab'*32


def attempt(n,leader=LEADER):return 'c'+str(n)+'-'+leader[:40]


class ContinuationAcceptanceTests(unittest.TestCase):
    def test_message_turn_needs_a_whole_attempt(self):
        self.assertIsNone(continuation_id({'attempt':1}))
        for value in (attempt(1),True,0,'1',None):
            with self.subTest(attempt=value),self.assertRaisesRegex(ValueError,'invalid_dispatch_attempt'):continuation_id({'attempt':value})

    def test_continuation_attempt_must_name_its_continuation(self):
        self.assertEqual(continuation_id({'attempt':attempt(1),'continuation':LEADER}),LEADER)
        self.assertEqual(continuation_id({'attempt':attempt(999),'continuation':LEADER}),LEADER)
        for body in ({'attempt':attempt(1,'f'*64),'continuation':LEADER},
                     {'attempt':'c0-'+LEADER[:40],'continuation':LEADER},
                     {'attempt':'c1000-'+LEADER[:40],'continuation':LEADER},
                     {'attempt':attempt(1,LEADER.upper()),'continuation':LEADER.upper()},
                     {'attempt':attempt(1),'continuation':LEADER[:63]},
                     {'attempt':1,'continuation':LEADER},
                     {'attempt':attempt(1),'continuation':LEADER,'control_reply':'Fixed reply'}):
            with self.subTest(body=body),self.assertRaisesRegex(ValueError,'invalid_continuation'):continuation_id(body)


if __name__=='__main__':unittest.main()
