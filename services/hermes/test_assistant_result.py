import time
import unittest
from unittest.mock import patch
from services.hermes.assistant_turn import background_limits,conversation_result,job_result,run_budget


class AssistantResultTests(unittest.TestCase):
    def test_empty_or_malformed_completion_is_failure(self):
        replies=[{}, {'final_response':None}, {'final_response':''}, {'final_response':' \n\t'},
                 {'final_response':[]}, {'final_response':{'text':'synthetic'}}, {'final_response':123}]
        for fields in replies:
            with self.subTest(fields=fields):
                self.assertEqual(conversation_result({'completed':True,**fields},'session'),
                                 {'state':'failed','error_code':'model_unavailable'})

    def test_partial_or_invalid_completion_never_becomes_a_successful_answer(self):
        results=[None,[],True,{'completed':'true'}, {'completed':1}, {'completed':False},
                 {'completed':True,'failed':True}, {'completed':True,'interrupted':True}]
        for result in results:
            if isinstance(result,dict):result={**result,'final_response':'Partial synthetic answer'}
            with self.subTest(result=result):
                self.assertEqual(conversation_result(result,'session'),
                                 {'state':'failed','error_code':'model_unavailable'})

    def test_explicit_silence_stays_silent(self):
        self.assertEqual(conversation_result({'completed':True,'final_response':' \n[NO_REPLY]\t'},'session'),
                         {'state':'done','text':'','session_id':'session'})

    def test_the_reply_is_the_agents_own_text(self):
        # Memory status reaches the agent as context; nothing is added to what it wrote (ADR-0221).
        answer='A synthetic answer mentions [NO_REPLY] as text.'
        self.assertEqual(conversation_result({'completed':True,'final_response':answer},'session'),
                         {'state':'done','text':answer,'session_id':'session'})


class JobResultTests(unittest.TestCase):
    def test_the_final_answer_is_the_report_and_so_is_hermess_summary_at_a_limit(self):
        done=job_result({'completed':True,'final_response':'The report.','turn_exit_reason':'text_response(stop)'},'job_s')
        self.assertEqual(done,{'state':'done','text':'The report.','session_id':'job_s'})
        for reason in ('max_iterations_reached(300/300)','budget_exhausted'):
            with self.subTest(reason=reason):
                self.assertEqual(job_result({'completed':False,'final_response':'Read January to March.','turn_exit_reason':reason},'job_s'),
                                 {'state':'done','text':'Read January to March.','session_id':'job_s'})

    def test_a_failed_interrupted_or_empty_run_wrote_no_report(self):
        for result in [None,[],{'completed':True,'final_response':''},{'completed':True,'final_response':' [NO_REPLY] '},{'completed':True,'final_response':None},
                       {'completed':False,'final_response':'partial'},{'completed':False,'final_response':'partial','turn_exit_reason':'interrupted'},
                       {'completed':False,'final_response':'','turn_exit_reason':'max_iterations_reached(300/300)'},
                       {'completed':True,'final_response':'x','failed':True},{'completed':True,'final_response':'x','interrupted':True}]:
            with self.subTest(result=result):
                self.assertEqual(job_result(result,'job_s'),{'state':'failed','error_code':'model_unavailable'})

    def test_the_cap_summary_is_built_like_the_turns_other_calls_on_anthropic(self):
        from agent import chat_completion_helpers as calls
        from services.hermes.compatibility_patch import install
        restore=install()
        try:self.assertEqual(calls._SUMMARY_ATTEMPT_BUILDERS['anthropic_messages'].__name__,'anthropic_summary')
        finally:restore()

    def test_a_run_takes_a_bounded_number_of_iterations_and_its_budget_runs_to_the_soft_deadline(self):
        soft=1793796300
        self.assertEqual(background_limits({'background':{'max_iterations':300,'soft_deadline':soft}}),300)
        for body in [{},{'background':None},{'background':{'max_iterations':0,'soft_deadline':soft}},{'background':{'max_iterations':1001,'soft_deadline':soft}},
                     {'background':{'max_iterations':'20','soft_deadline':soft}},{'background':{'max_iterations':300}},
                     {'background':{'max_iterations':300,'soft_deadline':float('nan')}},{'background':{'max_iterations':300,'soft_deadline':True}}]:
            with self.subTest(body=body),self.assertRaisesRegex(ValueError,'invalid_background_run'):background_limits(body)
        # Launched at 12:00:05 for a soft deadline at 12:45:00; Hermes's own notice then comes at 80% of it.
        with patch('services.hermes.assistant_turn.time.time',return_value=soft-2695):self.assertEqual(run_budget({'background':{'soft_deadline':soft}}),2695)
        with patch('services.hermes.assistant_turn.time.time',return_value=soft+5):self.assertEqual(run_budget({'background':{'soft_deadline':soft}}),30)

    def test_only_a_background_run_may_bind_a_deadline_past_ten_minutes(self):
        from services.hermes import archive_tools
        self.addCleanup(setattr,archive_tools,'_PROCESS_DEADLINE',None)
        for deadline,background,accepted in ((time.time()+3000,False,False),(time.time()+3000,True,True),(time.time()+3700,False,False),
                                             (time.time()+3700,True,False),(time.time()+500,False,True)):
            with self.subTest(deadline=deadline,background=background):
                archive_tools._PROCESS_DEADLINE=None
                if accepted:archive_tools.bind_process_deadline(deadline,background=background);self.assertEqual(archive_tools._PROCESS_DEADLINE,deadline)
                else:
                    with self.assertRaisesRegex(RuntimeError,'invalid_process_deadline'):archive_tools.bind_process_deadline(deadline,background=background)
