import unittest
from services.hermes.assistant_turn import conversation_result


class AssistantResultTests(unittest.TestCase):
    def test_empty_or_malformed_completion_is_failure_even_with_limited_memory(self):
        replies=[{}, {'final_response':None}, {'final_response':''}, {'final_response':' \n\t'},
                 {'final_response':[]}, {'final_response':{'text':'synthetic'}}, {'final_response':123}]
        for fields in replies:
            for limited in (False,True):
                with self.subTest(fields=fields,limited=limited):
                    self.assertEqual(conversation_result({'completed':True,**fields},'session',limited),
                                     {'state':'failed','error_code':'model_unavailable'})

    def test_partial_or_invalid_completion_never_becomes_a_successful_answer(self):
        results=[None,[],True,{'completed':'true'}, {'completed':1}, {'completed':False},
                 {'completed':True,'failed':True}, {'completed':True,'interrupted':True}]
        for result in results:
            if isinstance(result,dict):result={**result,'final_response':'Partial synthetic answer'}
            with self.subTest(result=result):
                self.assertEqual(conversation_result(result,'session',True),
                                 {'state':'failed','error_code':'model_unavailable'})

    def test_explicit_silence_stays_silent_when_memory_is_limited(self):
        for limited in (False,True):
            self.assertEqual(conversation_result({'completed':True,'final_response':' \n[NO_REPLY]\t'},'session',limited),
                             {'state':'done','text':'','session_id':'session'})

    def test_answer_is_preserved_and_notice_requires_a_real_answer(self):
        answer='A synthetic answer mentions [NO_REPLY] as text.'
        result=conversation_result({'completed':True,'final_response':answer},'session')
        self.assertEqual(result,{'state':'done','text':answer,'session_id':'session'})
        limited=conversation_result({'completed':True,'final_response':answer},'session',True)
        self.assertEqual(limited['state'],'done')
        self.assertTrue(limited['text'].startswith(answer+'\n\nMemory is limited;'))
