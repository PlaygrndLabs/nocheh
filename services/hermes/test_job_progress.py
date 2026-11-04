"""A background job run's progress from Hermes's hooks: counts, the to-do list, the cost notice and Nocheh's pricing twin."""
import json
import unittest
from pathlib import Path
from services.hermes import job_progress as progress

FIXTURE={'input':50,'output':50,'cache_read':0.5,'cache_write':50,'request':None}
ANSWER={'input_tokens':30000,'output_tokens':1,'cache_read_tokens':0,'cache_write_tokens':0,'reasoning_tokens':0,'request_count':1,
        'prompt_tokens':30000,'total_tokens':30001}
ZERO={'input_tokens':0,'output_tokens':0,'cache_read_tokens':0,'cache_write_tokens':0,'calls':0}


def todos(*items):return json.dumps({'todos':[{'id':str(n),'content':content,'status':status} for n,(content,status) in enumerate(items,1)],
                                     'revision':1,'summary':{'total':len(items)}},ensure_ascii=False)


class JobProgressTests(unittest.TestCase):
    def setUp(self):
        progress._RUN=None;self.addCleanup(setattr,progress,'_RUN',None)
        self.lines=[];self.now=[0.0]

    def bind(self,rates=FIXTURE,cap=5,prior=0):
        progress.bind(self.lines.append,{'max_iterations':300,'box':False,'soft_deadline':1793796300,'rates':rates,'cost_limit_usd':cap,'prior_cost_usd':prior},
                      clock=lambda:self.now[0])

    def test_nothing_happens_until_a_background_turn_binds_it_and_it_binds_once(self):
        for hook in (progress.api_request,progress.auxiliary_call):self.assertIsNone(hook(usage=ANSWER))
        self.assertIsNone(progress.tool_call(tool_name='todo_list',result=todos(('Read','pending'))))
        self.assertIsNone(progress.tool_result(tool_name='nocheh_archive_search',result='{}'))
        progress.finish({'turn_exit_reason':'max_iterations_reached(300/300)'})
        self.assertEqual(self.lines,[])
        for emit,limits in ((None,{'prior_cost_usd':0}),(self.lines.append,None),(self.lines.append,{'cost_limit_usd':'5','prior_cost_usd':0}),
                            (self.lines.append,{'cost_limit_usd':5}),(self.lines.append,{'cost_limit_usd':5,'prior_cost_usd':True}),
                            (self.lines.append,{'cost_limit_usd':float('inf'),'prior_cost_usd':0})):
            with self.subTest(limits=limits),self.assertRaisesRegex(ValueError,'invalid_background_run'):progress.bind(emit,limits)
        self.bind()
        with self.assertRaisesRegex(ValueError,'invalid_background_run'):self.bind()

    def test_calls_add_up_and_a_call_without_usage_counts_as_one_unknown_call(self):
        self.bind(rates={'input':2,'output':10,'cache_read':0.2,'cache_write':2.5,'request':None},cap=5)
        progress.api_request(usage={**ANSWER,'input_tokens':1000,'output_tokens':50,'cache_read_tokens':200,'reasoning_tokens':40},api_call_count=1)
        progress.auxiliary_call(usage={**ANSWER,'input_tokens':300,'output_tokens':20,'cache_write_tokens':7},aux_task='compression',error=None)
        self.assertEqual(self.lines[-1],{'event':'progress','tokens':{'input_tokens':1300,'output_tokens':70,'cache_read_tokens':200,'cache_write_tokens':7,'calls':2},
                                         'unknown_calls':0})
        # A streamed helper call, a main call without usage and one whose usage read no prompt: each one unknown call.
        progress.auxiliary_call(usage=None,streaming=True,error=None)
        progress.api_request(usage=None)
        progress.api_request(usage={**ANSWER,'input_tokens':0,'prompt_tokens':0,'output_tokens':9})
        progress.api_request(usage='not usage')
        # A failed helper attempt is not counted: it makes no line either.
        progress.auxiliary_call(usage=None,error=RuntimeError('provider outage'))
        self.assertEqual(len(self.lines),6)
        self.assertEqual((self.lines[-1]['tokens']['calls'],self.lines[-1]['unknown_calls']),(2,4))
        # Hermes's summary at its iteration cap fires no hook: it is one more unknown call, on the last line.
        progress.finish({'completed':False,'turn_exit_reason':'max_iterations_reached(300/300)','final_response':'The report.'})
        self.assertEqual((len(self.lines),self.lines[-1]['unknown_calls']),(7,5))
        for line in self.lines:self.assertEqual(progress.progress_line(line,len(json.dumps(line,ensure_ascii=False).encode())+1),
                                                {key:line[key] for key in ('tokens','unknown_calls','todo') if key in line})

    def test_a_run_that_ends_by_itself_adds_no_unknown_call(self):
        self.bind();progress.api_request(usage=ANSWER)
        progress.finish({'completed':True,'turn_exit_reason':'text_response(stop)','final_response':'The report.'})
        self.assertEqual([line['unknown_calls'] for line in self.lines],[0,0])

    def test_the_cost_notice_comes_once_on_the_newest_tool_result_at_80_percent(self):
        self.bind()
        progress.api_request(usage=ANSWER);progress.api_request(usage=ANSWER)
        self.assertIsNone(progress.tool_result(tool_name='nocheh_archive_search',result='{"sources":[]}'),'3.0001 is under 4.0')
        progress.api_request(usage=ANSWER)
        self.assertIsNone(progress.tool_result(tool_name='nocheh_archive_search',result={'not':'a string'}),'only a text result carries it')
        self.assertEqual(progress.tool_result(tool_name='nocheh_archive_search',result='{"sources":[]}'),'{"sources":[]}\n\n'+progress.COST_NOTICE)
        progress.api_request(usage=ANSWER)
        self.assertIsNone(progress.tool_result(tool_name='nocheh_archive_search',result='{}'),'once per run')
        self.assertEqual(progress.COST_NOTICE,'[SYSTEM NOTICE — cost budget nearly used] This job has used about 80% of its cost limit. '
                                              'Stop new discovery now and write the final report from what you have.')

    def test_a_relaunched_run_counts_the_cost_of_the_runs_before_it(self):
        self.bind(prior=3.0);progress.api_request(usage=ANSWER)
        self.assertTrue(progress.tool_result(tool_name='terminal',result='ok').endswith(progress.COST_NOTICE),'3.0 + 1.50005 passes 4.0')

    def test_an_unpriced_job_or_one_without_a_cap_gets_no_cost_notice(self):
        for rates,cap in (({**FIXTURE,'output':None},5),(FIXTURE,None)):
            with self.subTest(rates=rates,cap=cap):
                progress._RUN=None;self.bind(rates=rates,cap=cap)
                for _ in range(10):progress.api_request(usage=ANSWER);progress.api_request(usage=None)
                self.assertIsNone(progress.tool_result(tool_name='terminal',result='ok'))

    def test_the_todo_list_goes_out_only_when_it_changed_and_at_most_once_a_minute(self):
        self.bind()
        progress.tool_call(tool_name='todo_list',result=todos(('Read the chat','in_progress'),('Write the report','pending')))
        self.assertEqual(self.lines,[{'event':'progress','tokens':ZERO,'unknown_calls':0,
                                      'todo':[{'content':'Read the chat','status':'in_progress'},{'content':'Write the report','status':'pending'}]}])
        progress.tool_call(tool_name='todo_list',result=todos(('Read the chat','in_progress'),('Write the report','pending')))
        progress.api_request(usage=ANSWER)
        self.assertEqual(len(self.lines),2);self.assertNotIn('todo',self.lines[-1],'an unchanged list is not sent again')
        self.now[0]=10;progress.tool_call(tool_name='todo_list',result=todos(('Read the chat','completed'),('Write the report','pending')))
        self.now[0]=30;progress.api_request(usage=ANSWER)
        self.assertEqual(len(self.lines),3);self.assertNotIn('todo',self.lines[-1],'a second change within a minute waits')
        self.now[0]=61;progress.api_request(usage=ANSWER)
        self.assertEqual(self.lines[-1]['todo'][0],{'content':'Read the chat','status':'completed'})
        self.now[0]=70;progress.tool_call(tool_name='todo_list',result=todos(('Read the chat','completed'),('Write the report','completed')))
        self.assertEqual(len(self.lines),4)
        # Other tools and results that are not a list change nothing.
        progress.tool_call(tool_name='memory',result=todos(('Forged','pending')));progress.tool_call(tool_name='todo_list',result='{"error":"bad"}')
        progress.tool_call(tool_name='todo_list',result='not json');progress.tool_call(tool_name='todo_list',result=None)
        progress.finish({'completed':True,'final_response':'The report.'})
        self.assertEqual(self.lines[-1]['todo'],[{'content':'Read the chat','status':'completed'},{'content':'Write the report','status':'completed'}],
                         'the last line carries the newest list')

    def test_a_todo_list_is_bounded_and_every_line_fits(self):
        self.assertEqual(progress.todo_list([{'content':'x'*300,'status':'y'*30,'id':'1'},'not an item',{'content':5}]),
                         [{'content':'x'*200,'status':'y'*20},{'content':'5','status':''}])
        self.assertEqual(len(progress.todo_list([{'content':'a','status':'pending'}]*60)),50)
        self.assertIsNone(progress.todo_list({'todos':[]}))
        self.bind()
        # Each control character takes six bytes in JSON: the list's last items are left out of the line, not the line itself.
        progress.tool_call(tool_name='todo_list',result=json.dumps({'todos':[{'content':'\x01'*200,'status':'\x02'*20}]*50}))
        line=self.lines[-1];size=len(json.dumps(line,ensure_ascii=False).encode())+1
        self.assertLessEqual(size,progress.LINE_BYTES);self.assertTrue(0<len(line['todo'])<50)
        self.assertEqual(progress.progress_line(line,size)['todo'],line['todo'])

    def test_a_55_minute_run_stays_far_under_the_output_cap(self):
        self.bind(rates=None,cap=None)
        for minute in range(55):
            self.now[0]=minute*61
            progress.tool_call(tool_name='todo_list',result=todos(*[('ب'*199+str(minute%10),'in_progress' if n else 'completed') for n in range(50)]))
            for _ in range(8):progress.api_request(usage=ANSWER)
        progress.finish({'completed':True,'final_response':'r'*1000000})
        lines=[(json.dumps(line,ensure_ascii=False)+'\n').encode() for line in self.lines]
        self.assertEqual((sum('todo' in line for line in self.lines),sum(1 for line in self.lines if 'todo' not in line)),(55,441))
        self.assertTrue(all(len(line)<=progress.LINE_BYTES for line in lines))
        report=(json.dumps({'state':'done','text':'r'*1000000,'session_id':'job_s'})+'\n').encode()
        self.assertLess(sum(map(len,lines))+len(report),4*1024*1024)

    def test_progress_lines_are_checked_strictly_before_they_are_relayed(self):
        tokens={'input_tokens':30000,'output_tokens':1,'cache_read_tokens':0,'cache_write_tokens':0,'calls':1}
        good={'event':'progress','tokens':tokens,'unknown_calls':0,'todo':[{'content':'Search the marks','status':'in_progress'}]}
        self.assertEqual(progress.progress_line(good,200),{'tokens':tokens,'unknown_calls':0,'todo':good['todo']})
        self.assertEqual(progress.progress_line({**good,'unknown_calls':10**6,'todo':[]},200)['unknown_calls'],10**6)
        for bad in ({**good,'extra':1},{key:value for key,value in good.items() if key!='unknown_calls'},{**good,'event':'heartbeat'},
                    {**good,'tokens':{**tokens,'reasoning_tokens':0}},{**good,'tokens':{**tokens,'calls':-1}},{**good,'tokens':{**tokens,'calls':True}},
                    {**good,'tokens':{**tokens,'input_tokens':1.0}},{**good,'tokens':{**tokens,'input_tokens':10**12}},{**good,'unknown_calls':10**6+1},
                    {**good,'todo':[{'content':'x','status':'pending'}]*51},{**good,'todo':[{'content':'x'*201,'status':'pending'}]},
                    {**good,'todo':[{'content':'x','status':'pending','id':'1'}]},{**good,'todo':'list'},[good]):
            with self.subTest(bad=bad),self.assertRaisesRegex(RuntimeError,'assistant_output_invalid'):progress.progress_line(bad,200)
        with self.assertRaisesRegex(RuntimeError,'assistant_output_invalid'):progress.progress_line(good,progress.LINE_BYTES+1)

    def test_counts_merge_bucketwise_and_come_from_hermes_usage(self):
        usage={'input_tokens':1200,'output_tokens':300,'cache_read_tokens':5000,'cache_write_tokens':40,'reasoning_tokens':7,'calls':3,'cost_usd':0.25,'model':'m'}
        self.assertEqual(progress.run_tokens(usage),{'input_tokens':1200,'output_tokens':300,'cache_read_tokens':5000,'cache_write_tokens':40,'calls':3})
        self.assertEqual(progress.run_tokens({'calls':2,'input_tokens':-1}),{**ZERO,'calls':2})
        self.assertIsNone(progress.run_tokens(None))
        a={**ZERO,'input_tokens':10,'calls':3};b={**ZERO,'input_tokens':4,'output_tokens':9,'calls':1}
        self.assertEqual(progress.merge(a,b),{**ZERO,'input_tokens':10,'output_tokens':9,'calls':3})
        self.assertEqual((progress.merge(None,b),progress.merge(a,None),progress.merge(None,None)),(b,a,None))

    def test_pricing_matches_nochehs_examples_exactly(self):
        examples=json.loads((Path(__file__).resolve().parents[2]/'test'/'run-cost-examples.json').read_text())
        self.assertEqual(len(examples),9)
        for example in examples:
            with self.subTest(example['name']):
                self.assertEqual(progress.run_cost(example['rates'],example['tokens'],example['unknown_calls']),example['cost'])
        self.assertFalse(progress.priced({'input':2,'output':True}));self.assertFalse(progress.priced(None))

    def test_the_nocheh_plugin_registers_the_four_hooks(self):
        from services import hermes
        hooks=[]
        class Context:
            def register_hook(self,name,callback):hooks.append((name,callback))
            def __getattr__(self,name):return lambda *args,**kwargs:None
        hermes.register(Context())
        self.assertLessEqual({('post_api_request',progress.api_request),('post_auxiliary_call',progress.auxiliary_call),
                              ('post_tool_call',progress.tool_call),('transform_tool_result',progress.tool_result)},set(hooks))


if __name__=='__main__':unittest.main()
