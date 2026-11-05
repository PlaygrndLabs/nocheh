import asyncio,base64,hashlib,hmac,json,tempfile,threading,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from . import managed_async
from .managed_async import ManagedAsync,ServiceError
from .async_runs import identity
from .job_progress import run_cost
from .scopes import Scope


class ManagedAsyncTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.scope=Scope('42','42',True,'owner','42',1)
        self.admin=SimpleNamespace(root=self.root,model='model',token='fixture-service-token',
            profile=lambda name:(name,self.root),binding=lambda name:self.scope,policy=SimpleNamespace(owner='42',groups=['-123']))
        self.body={'channel':'browser','event_id':'a'*64,'attempt':1,'owner_epoch':2}
        self.context={'event_id':'a'*64,'actor':'run_'+'a'*64,'scope':'42','profile':'owner','conversation':'native-session','owner_epoch':2}
        self.state='captured';self.finished=None;self.count=0;self.failed=None;self.visible=True;self.release=threading.Event();self.release.set()
        self.runtime=ManagedAsync(self.admin,lambda:object(),self.call,self.runner)
    def tearDown(self):self.release.set();self.runtime.stop();self.temp.cleanup()
    def call(self,route,body):
        if route==self.failed:raise RuntimeError('private provider outage canary')
        if route=='workflow-context':return self.context
        if route=='claim':
            self.state='running'
            claims={'scope':None,'event_id':body['event_id'],'audience':'nocheh-assistant','space':'42','revision':1,'expires':(time.time()+600)*1000}
            if self.context.get('storage_layout')=='original-only-v1':
                claims.update(generation='12345678-1234-1234-1234-123456789abc',guard_epoch=self.context['revision'],revision=self.context['revision'],
                    logical_profile=self.context['profile'],space=self.context['space'],scope=None if self.context['scope']=='42' else self.context['scope'])
            encoded=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
            signature=base64.urlsafe_b64encode(hmac.new(self.admin.token.encode(),encoded.encode(),hashlib.sha256).digest()).decode().rstrip('=')
            return {**body,'claimed':True,'archive_credential':'turn.'+encoded+'.'+signature,'text':'private prompt canary'}
        if route=='prepare':return {'files':[],'transcripts':[]}
        if route=='finish':self.finished=body;self.state=body['state'];return {'state':self.state}
        if route=='observe':return {'state':self.state,'visible':self.visible,'text':self.finished['text'] if self.finished and self.visible else ''}
        return {}
    async def runner(self,root,scope,body,model,credentials,session,emit,cancelled):
        self.count+=1;self.assertEqual(session,'native-session');emit('private stream canary')
        while not self.release.is_set() and not cancelled.is_set():await asyncio.sleep(.01)
        return {'state':'cancelled' if cancelled.is_set() else 'done','text':'private result canary','session_id':session}
    def settle(self):
        for _ in range(200):
            result=self.runtime.runs.resume(self.body)
            if result['state'] in ('done','failed','ambiguous','cancelled'):return result
            time.sleep(.01)
        self.fail('native async run did not finish')
    def test_stream_and_receipt_stay_private_and_resume_never_reexecutes(self):
        self.runtime.runs.start(self.body);self.assertEqual(self.settle()['state'],'done')
        self.assertEqual(self.runtime.events({**self.context,'after':0})['events'][0]['text'],'private stream canary')
        self.assertEqual(self.runtime.events({**self.context,'after':1})['events'],[])
        self.assertNotIn('private',json.dumps(self.runtime.runs.events(self.body)))
        self.assertNotIn('private',self.runtime.path(self.body,'.result').read_text())
        self.runtime=ManagedAsync(self.admin,lambda:object(),self.call,self.runner)
        self.assertEqual(self.runtime.runs.resume(self.body)['state'],'done');self.assertEqual(self.count,1)
        self.visible=False;self.assertEqual(self.runtime.events(self.context)['events'],[])
    def test_lost_receipt_ack_reconciles_without_replacement_effect(self):
        original=self.call;failed=[False]
        def call(route,body):
            result=original(route,body)
            if route=='finish' and not failed[0]:failed[0]=True;raise OSError('ack lost')
            return result
        self.runtime.call=call;self.runtime.runs.start(self.body)
        self.assertEqual(self.settle()['state'],'done');self.assertEqual(self.count,1)
        self.assertTrue(self.runtime.path(self.body,'.receipt').is_file())
    def test_restart_after_claim_closes_uncertainty_and_cancellation_stops_same_run(self):
        self.release.clear();self.runtime.runs.start(self.body)
        for _ in range(100):
            if self.count:break
            time.sleep(.01)
        self.runtime.runs.cancel(self.body);self.assertEqual(self.settle()['state'],'cancelled')
        self.runtime.runs.start(self.body);self.assertEqual(self.count,1)
        other={**self.body,'event_id':'b'*64};directory=self.runtime.directory
        (directory/(identity(other)+'.request')).write_text(json.dumps(other))
        (directory/(identity(other)+'.started')).write_text('{}')
        self.assertEqual(self.runtime.runs.resume(other)['state'],'ambiguous');self.assertEqual(self.count,1)
    def test_original_only_managed_scope_uses_admitted_logical_profile_and_signed_generation(self):
        self.context.update(storage_layout='original-only-v1',space='-123/topic/7',scope='-123',profile='research',revision=8)
        self.admin.profile=lambda name:(_ for _ in ()).throw(AssertionError('legacy path lookup must not route a generation'))
        original=self.runner
        async def runner(root,scope,*args,**kwargs):
            self.assertEqual(scope.space,'-123/topic/7');self.assertEqual(scope.logical_profile,'research');self.assertFalse(scope.owner)
            return await original(root,scope,*args,**kwargs)
        self.runtime.runner=runner;self.runtime.runs.start(self.body);self.assertEqual(self.settle()['state'],'done');self.assertEqual(self.count,1)
    def test_original_only_context_cannot_route_an_unselected_conversation(self):
        self.context.update(storage_layout='original-only-v1',space='-999',scope='-999',profile='research',revision=8)
        self.runtime.runs.start(self.body);self.assertEqual(self.settle()['state'],'ambiguous');self.assertEqual(self.count,0)
    def background(self,runner,heartbeat=None):
        """A background job run against storage routes that answer heartbeats with `heartbeat` (a function of the body) when given."""
        self.routes=[];self.beats=[]
        def background(route,body):
            self.routes.append(route)
            if route=='heartbeat':
                self.beats.append(body)
                if heartbeat:return heartbeat(body)
                return {'event_id':body['event_id'],'state':'running','cancel_requested':False}
            return self.call(route,body)
        self.runtime=ManagedAsync(self.admin,lambda:object(),lambda route,body:self.fail('a job run must not use browser routes'),runner,background_call=background)
        self.context.update(storage_layout='original-only-v1',space='-123',scope='-123',profile='job-'+'c'*24,revision=8,
            background={'job_id':'c'*64,'attempt':1,'max_iterations':300,'box':False,'soft_deadline':1793796300,'hard_deadline':1793796480,
                        'rates':{'input':2,'output':10,'cache_read':0.2,'cache_write':2.5,'request':None},'cost_limit_usd':5,'prior_cost_usd':0})
        run={**self.body,'channel':'background'}
        self.runtime.runs.start(run)
        for _ in range(1000):
            if self.runtime.runs.resume(run)['state'] in ('done','failed','ambiguous','cancelled'):return self.finished
            time.sleep(.01)
        self.fail('the job run did not finish')
    def test_background_job_run_uses_its_own_routes_and_its_receipt_keeps_the_larger_counts(self):
        seen={}
        tokens=lambda calls,read:{'input_tokens':900*calls,'output_tokens':80,'cache_read_tokens':read,'cache_write_tokens':0,'calls':calls}
        async def runner(root,scope,body,model,credentials,session,emit,cancelled,progress):
            seen.update(body=body,emit=emit);self.count+=1
            progress({'tokens':tokens(1,0),'unknown_calls':0,'todo':[{'content':'read March','status':'in_progress'}]})
            progress({'tokens':tokens(2,0),'unknown_calls':1})
            return {'state':'done','text':'The report.','session_id':session,'tokens':tokens(1,500)}
        finished=self.background(runner)
        self.assertEqual(seen['body']['background']['max_iterations'],300);self.assertEqual(seen['body']['background']['soft_deadline'],1793796300)
        self.assertIsNone(seen['emit'],'a job run streams nothing to a browser')
        self.assertNotIn('continue',finished);self.assertNotIn('cost_usd',finished)
        self.assertEqual(finished['tokens'],tokens(2,500),'bucketwise the larger of its progress and Hermes\'s own counts')
        self.assertEqual((finished['unknown_calls'],finished['todo']),(1,[{'content':'read March','status':'in_progress'}]))
        self.assertEqual(self.routes[:3],['workflow-context','claim','prepare']);self.assertIn('finish',self.routes)
        async def quiet(root,scope,body,model,credentials,session,emit,cancelled,progress):
            return {'state':'done','text':'The report.','session_id':session,'tokens':None}
        self.body['event_id']='d'*64;self.context['event_id']='d'*64
        finished=self.background(quiet)
        self.assertEqual((finished['tokens'],finished['unknown_calls']),(None,0));self.assertNotIn('todo',finished,'no list was seen')
        # Hermes counts its calls without usage as calls too; the relay prices them once, as unknown calls.
        zero={'input_tokens':0,'output_tokens':0,'cache_read_tokens':0,'cache_write_tokens':0,'calls':0}
        async def blind(root,scope,body,model,credentials,session,emit,cancelled,progress):
            for unknown in (1,2,3):progress({'tokens':zero,'unknown_calls':unknown})
            return {'state':'done','text':'The report.','session_id':session,'tokens':{**zero,'calls':3}}
        self.body['event_id']='e'*64;self.context['event_id']='e'*64
        finished=self.background(blind)
        self.assertEqual((finished['tokens'],finished['unknown_calls']),(zero,3))
        rates=self.context['background']['rates']
        self.assertEqual(run_cost(rates,finished['tokens'],finished['unknown_calls']),run_cost(rates,None,3),'each call priced once')
    def test_a_heartbeat_carries_progress_once_per_change_and_the_todo_list_only_when_it_changed(self):
        step=threading.Event();sent=[]
        def heartbeat(body):
            sent.append(body.get('progress'));step.set()
            return {'event_id':body['event_id'],'state':'running','cancel_requested':False}
        tokens={'input_tokens':10,'output_tokens':1,'cache_read_tokens':0,'cache_write_tokens':0,'calls':1}
        async def runner(root,scope,body,model,credentials,session,emit,cancelled,progress):
            async def beat():
                # Two heartbeats: the second one surely read the progress given before it.
                for _ in range(2):
                    step.clear()
                    while not step.is_set():await asyncio.sleep(.005)
            todo=[{'content':'read March','status':'in_progress'}]
            progress({'tokens':tokens,'unknown_calls':0,'todo':todo});await beat();await beat()
            progress({'tokens':{**tokens,'calls':2},'unknown_calls':0,'todo':todo});await beat()
            progress({'tokens':{**tokens,'calls':2},'unknown_calls':0,'todo':[]});await beat()
            return {'state':'done','text':'The report.','session_id':session}
        with patch.object(managed_async,'HEARTBEAT_SECONDS',.02):self.background(runner,heartbeat)
        changes=[value for value in sent if value is not None]
        self.assertEqual(changes,[{'tokens':tokens,'unknown_calls':0,'todo':[{'content':'read March','status':'in_progress'}]},
                                  {'tokens':{**tokens,'calls':2},'unknown_calls':0},{'tokens':{**tokens,'calls':2},'unknown_calls':0,'todo':[]}])
        self.assertTrue(all(beat['background']==self.context['background'] and beat['actor']==self.context['actor'] for beat in self.beats))
    def test_a_background_run_outlasts_a_short_storage_outage_only(self):
        async def runner(root,scope,body,model,credentials,session,emit,cancelled,progress):
            for _ in range(80):
                if cancelled.is_set():break
                await asyncio.sleep(.01)
            return {'state':'cancelled' if cancelled.is_set() else 'done','text':'The report.','session_id':session}
        def outage(seconds,error):
            began=[]
            def heartbeat(body):
                began.append(time.monotonic())
                if time.monotonic()-began[0]<seconds:raise error
                return {'event_id':body['event_id'],'state':'running','cancel_requested':False}
            return heartbeat
        cases=[(.30,ServiceError(),'done'),(.30,ServiceError(503,'guard_configuration_pending'),'done'),(.30,ServiceError(409,'guard_transition_pending'),'done'),
               (.50,ServiceError(),'interrupted'),(.50,ServiceError(502),'interrupted')]
        cases+=[(9,ServiceError(status,code),'interrupted') for status,code in ((409,'run_lease_lost'),(409,'guard_context_changed'),(409,'job_not_running'),
                                                                                (403,'job_not_permitted'),(404,'captured_run_not_found'),(400,'invalid_run_progress'))]
        cases+=[(9,RuntimeError('not a storage answer'),'interrupted')]
        for number,(seconds,error,state) in enumerate(cases):
            with self.subTest(error=(error.status,error.code) if isinstance(error,ServiceError) else error,seconds=seconds):
                self.body['event_id']=self.context['event_id']=format(number,'x')*64
                self.finished=None;began=time.monotonic()
                with patch.object(managed_async,'HEARTBEAT_SECONDS',.01),patch.object(managed_async,'TOLERANCE_SECONDS',.45):
                    finished=self.background(runner,outage(seconds,error))
                self.assertEqual(finished['state'],state)
                # A refusal from storage stops the run at its first heartbeat, not after the tolerance.
                if seconds==9:self.assertLess(time.monotonic()-began,.45)
    def test_a_cancel_from_storage_stops_the_run(self):
        async def runner(root,scope,body,model,credentials,session,emit,cancelled,progress):
            while not cancelled.is_set():await asyncio.sleep(.01)
            return {'state':'cancelled','text':'','session_id':session}
        with patch.object(managed_async,'HEARTBEAT_SECONDS',.01):
            finished=self.background(runner,lambda body:{'event_id':body['event_id'],'state':'running','cancel_requested':True})
        self.assertEqual(finished['state'],'cancelled')
    def test_a_browser_run_is_lost_at_its_first_failed_heartbeat(self):
        self.release.clear();original=self.call
        def call(route,body):
            if route=='heartbeat':raise ServiceError(503)
            return original(route,body)
        self.runtime.call=call
        with patch.object(managed_async,'HEARTBEAT_SECONDS',.01):
            self.runtime.runs.start(self.body);self.assertEqual(self.settle()['state'],'ambiguous')
        self.assertEqual(self.finished['state'],'interrupted')
    def test_storage_answers_keep_their_status_and_code(self):
        from io import BytesIO
        from urllib.error import HTTPError
        def refused(request,timeout):
            self.assertEqual(timeout,managed_async.HEARTBEAT_TIMEOUT)
            raise HTTPError(request.full_url,409,'Conflict',{},BytesIO(b'{"error":"guard_transition_pending"}'))
        with patch.object(managed_async,'urlopen',refused),self.assertRaises(ServiceError) as caught:self.runtime.http('heartbeat',{},'background')
        self.assertEqual((caught.exception.status,caught.exception.code,str(caught.exception)),(409,'guard_transition_pending','managed_service_unavailable'))
        self.assertTrue(managed_async.tolerated(caught.exception))
        def down(request,timeout):self.assertEqual(timeout,15);raise OSError('connection refused')
        with patch.object(managed_async,'urlopen',down),self.assertRaises(ServiceError) as caught:self.runtime.http('heartbeat',{})
        self.assertEqual((caught.exception.status,caught.exception.code),(None,None))
        self.assertFalse(managed_async.tolerated(RuntimeError('x')));self.assertFalse(managed_async.tolerated(ServiceError(409,'run_lease_lost')))
