"""Native storage and supervised scheduling acceptance without external traffic."""
import asyncio,base64,hashlib,hmac,json,os,tempfile,threading,time,unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from .native_admin import Administration
from .native_cron import manage,inspect,store
from .scheduler import Scheduler,now
from .scopes import Scopes


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.env=patch.dict(os.environ,{'NOCHEH_RUNTIME_HOME':str(self.root)});self.env.start()
        self.admin=Administration(None,self.root,'gpt-5.6-sol',Scopes({'enabled':False,'owner_id':'42','group_ids':[]}), 'fixture-token-long-enough')
        self.calls=[];self.inputs={};self.finished={};self.failed=None;self.executions=0;self.hold=False
        self.scheduler=Scheduler(self.admin,lambda:SimpleNamespace(access_token='ephemeral'),self.call,self.runner)

    def tearDown(self):
        self.scheduler.stop()
        self.env.stop();self.temp.cleanup()

    def call(self,route,body):
        self.calls.append((route,body))
        if route==self.failed:raise OSError('synthetic archive outage')
        if route=='input':self.inputs[body['id']]=body;return {'event_id':body['id']}
        if route=='claim':
            if body['event_id'] in self.finished:return {'claimed':False,'state':self.finished[body['event_id']]['state']}
            claims={'scope':None,'event_id':body['event_id'],'audience':'nocheh-assistant','space':'42','revision':1,'expires':(time.time()+600)*1000}
            encoded=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
            signature=base64.urlsafe_b64encode(hmac.new(self.admin.token.encode(),encoded.encode(),hashlib.sha256).digest()).decode().rstrip('=')
            return {**body,'claimed':True,'archive_credential':'turn.'+encoded+'.'+signature,'text':self.inputs[body['event_id']]['text']}
        if route=='finish':self.finished[body['event_id']]=body;return {'state':body['state']}
        return {'state':'local'}

    async def runner(self,root,bound,body,model,credentials,session,cancelled=None):
        self.executions+=1
        while self.hold and not cancelled.is_set():await asyncio.sleep(.01)
        return {'state':'cancelled' if cancelled.is_set() else 'done','text':'Synthetic result','session_id':session}

    def request(self,path='/api/cron/jobs',method='GET',body=None,headers=None):
        return manage(self.admin,path,method,{},body or {},headers or {},self.call)

    def create(self,**extra):
        return self.request(method='POST',body={'name':'Fixture','prompt':'  Original\r\n\0 text  ','schedule':'every 1h',**extra})

    def due(self,job,seconds=0):
        from cron import jobs as native
        home=Path(job['hermes_home'])
        with store(home):native.update_job(job['id'],{'next_run_at':(now()-timedelta(seconds=seconds)).isoformat()})
        return home

    def test_native_form_roundtrip_conflict_and_inert_capture_failure(self):
        self.assertEqual(self.request(),[]);self.assertFalse(list(self.root.rglob('jobs.json')))
        job=self.create();self.assertEqual(job['prompt'],'  Original\r\n\0 text  ')
        home=Path(job['hermes_home']);original=(home/'cron/jobs.json').read_bytes();self.request();self.assertEqual((home/'cron/jobs.json').read_bytes(),original)
        saved=self.request('/api/cron/jobs/'+job['id'],'PUT',{'updates':{'prompt':'Exact revised text','_nocheh_revision':job['_nocheh_revision']}})
        with self.assertRaisesRegex(ValueError,'configuration_conflict'):
            self.request('/api/cron/jobs/'+job['id'],'PUT',{'updates':{'prompt':'stale','_nocheh_revision':job['_nocheh_revision']}})
        for extra in ({'script':'escape.py'},{'deliver':'telegram:other'},{'base_url':'https://paid.example'},{'context_from':['private']},{'no_agent':True}):
            with self.assertRaises(ValueError):self.create(**extra)
        self.failed='definition'
        with self.assertRaises(OSError):self.create(name='Pending capture')
        self.assertFalse(inspect(home)[-1]['nocheh_registered'])

    def test_one_fire_original_provenance_schedule_advance_and_no_repeat(self):
        job=self.create();managed=self.migrate();home=self.due(job);request=self.workflow(job);before=inspect(home)[0]['next_run_at'];self.failed='input'
        with self.assertRaises(OSError):self.scheduler.advance(request)
        self.assertEqual(inspect(home)[0]['next_run_at'],before);self.assertEqual(self.executions,0)
        self.failed=None;self.assertEqual(self.scheduler.advance(request)['state'],'completed')
        event=inspect(home)[0]['nocheh_running'];body={'channel':'scheduler','event_id':event,'attempt':1,'owner_epoch':2}
        self.assertEqual(next(iter(self.inputs.values()))['text'],job['prompt'])
        managed.start(body);self.assertEqual(self.finish_managed(managed,body)['state'],'done')
        self.assertEqual(self.scheduler.advance(request)['state'],'skipped');managed.start(body);self.assertEqual(self.executions,1)
        self.assertEqual(self.request('/api/cron/jobs/'+job['id'])['last_status'],'success')

    def test_unconfirmed_claim_never_launches_a_replacement_effect(self):
        job=self.create();managed=self.migrate();home=self.due(job);self.scheduler.advance(self.workflow(job));self.failed='claim'
        body={'channel':'scheduler','event_id':inspect(home)[0]['nocheh_running'],'attempt':1,'owner_epoch':2}
        managed.start(body);self.assertIn(self.finish_managed(managed,body)['state'],('failed','ambiguous'))
        self.assertEqual(self.executions,0)
        self.failed=None;managed.start(body);self.assertEqual(self.executions,0)
        self.assertTrue(managed.path(body,'.request').exists())

    def test_missed_runs_require_explicit_one_catch_up_and_manual_identity(self):
        job=self.create();managed=self.migrate();home=self.due(job,120);before=inspect(home)[0]['next_run_at']
        self.scheduler.advance(self.workflow(job));self.assertEqual(self.executions,0)
        from .scheduler import date
        self.assertEqual((date(inspect(home)[0]['next_run_at'])-date(before)).total_seconds(),3600)
        self.assertEqual(next(iter(self.inputs.values()))['fire_reason'],'missed')
        path='/api/cron/jobs/'+job['id']+'/catch-up'
        self.request(path,'POST',{'request_id':'one-catch-up'});request=self.workflow(job);self.scheduler.advance(request)
        body={'channel':'scheduler','event_id':inspect(home)[0]['nocheh_running'],'attempt':1,'owner_epoch':2}
        managed.start(body);self.assertEqual(self.finish_managed(managed,body)['state'],'done')
        self.assertEqual(self.executions,1);self.assertIsNone(self.request('/api/cron/jobs/'+job['id'])['nocheh_missed'])
        self.request(path,'POST',{'request_id':'one-catch-up'});self.assertEqual(self.scheduler.advance(request)['state'],'skipped')
        managed.start(body);self.assertEqual(self.executions,1)

    def test_receipt_outage_restart_and_overlap_do_not_repeat_execution(self):
        job=self.create();managed=self.migrate();home=self.due(job);self.scheduler.advance(self.workflow(job));self.failed='finish'
        body={'channel':'scheduler','event_id':inspect(home)[0]['nocheh_running'],'attempt':1,'owner_epoch':2}
        managed.start(body)
        for _ in range(200):
            if managed.path(body,'.receipt').exists():break
            time.sleep(.01)
        self.assertEqual(self.executions,1);self.assertTrue(managed.path(body,'.receipt').exists())
        self.failed=None;managed.flush();self.scheduler.recover();managed.runs.resume(body);self.assertEqual(self.executions,1)
        # A concurrent occurrence of this same job is captured as overlap.
        from cron import jobs as native
        with store(home):native.update_job(job['id'],{'nocheh_running':'existing-effect','next_run_at':now().isoformat()})
        self.scheduler.advance(self.workflow(job))
        self.assertIn('overlap',[value['fire_reason'] for value in self.inputs.values()]);self.assertEqual(self.executions,1)

    def test_one_supervisor_and_inactive_restore(self):
        (self.root/'scheduler-inactive').touch();self.scheduler.start()
        for _ in range(100):
            if self.scheduler.status=='inactive_restore':break
            time.sleep(.01)
        self.assertEqual(self.scheduler.status,'inactive_restore')
        second=Scheduler(self.admin,lambda:None,self.call,self.runner);second.start();second.thread.join(timeout=2)
        self.assertEqual(second.status,'already_supervised');self.assertEqual(self.executions,0)

    def test_job_preferences_are_ephemeral_and_disable_proposals(self):
        from .profile_config import configure_profile
        from .policy_config import save,view
        from .turn_process import scheduled_preferences
        from . import archive_tools
        home=self.root/'profiles'/Scopes.profile('42');configure_profile(home,'gpt-5.6-sol')
        before=(home/'config.yaml').read_bytes()
        save(self.root,{'agent.max_iterations':3},view(self.root)['revision'],'job-one')
        values=scheduled_preferences(home,{'job_id':'job-one','job_preferences':{'memory.memory_char_limit':500,'nocheh_tools.shell':'off'}})
        self.assertEqual(values['agent.max_iterations'],3);self.assertEqual(values['memory.memory_char_limit'],500)
        self.assertEqual((home/'config.yaml').read_bytes(),before)
        with patch.dict(os.environ,{'HERMES_HOME':str(home)}),patch.object(archive_tools,'_PROCESS_PREFERENCES',values),patch.object(archive_tools,'request') as request:
            self.assertEqual(json.loads(archive_tools.controlled_tool('shell',{'command':'pwd'}))['error'],'tool_disabled_by_owner')
            request.assert_not_called()

    def migrate(self):
        from .managed_async import ManagedAsync
        original=self.call
        def call(route,body):
            if route=='ownership':return {'owner':'inngest','epoch':2,'admission':True}
            if route=='workflow-context':
                source=self.inputs[body['event_id']]
                return {'event_id':body['event_id'],'actor':'run_'+body['event_id'],'scope':source['scope'],'profile':source['profile'],
                    'logical_profile':source['definition']['profile'],'job_id':source['job_id'],'job_revision':source['job_revision'],
                    'definition':source['definition'],'conversation':'cron_'+source['job_id']+'_'+body['event_id'][:24],'owner_epoch':2}
            if route=='prepare':return {'files':[],'transcripts':[]}
            if route=='observe':return {'state':self.finished.get(body['event_id'],{}).get('state','running')}
            return original(route,body)
        async def runner(*args,emit=None,cancelled=None):return await self.runner(*args,cancelled=cancelled)
        self.scheduler.call=call
        managed=ManagedAsync(self.admin,lambda:SimpleNamespace(access_token='ephemeral'),runner=runner,scheduler=self.scheduler)
        self.addCleanup(managed.stop);self.scheduler.managed_flush=managed.flush
        return managed

    def workflow(self,job):
        from .native_cron import workflow_cursor
        home=Path(job['hermes_home']);stored=next(row for row in inspect(home) if row['id']==job['id'])
        return {'logical_profile':home.name,'job_id':job['id'],'cursor':workflow_cursor(stored,home.name),'owner_epoch':2}

    def finish_managed(self,managed,body):
        for _ in range(200):
            state=managed.runs.resume(body)
            if state['state'] in ('done','cancelled','failed','ambiguous'):return state
            time.sleep(.01)
        self.fail('scheduled async run did not settle')

    def test_inngest_waits_keep_native_cadence_and_final_repeat_runs_once(self):
        job=self.create(repeat=1);managed=self.migrate()
        future=self.workflow(job);self.assertEqual(self.scheduler.advance(future)['state'],'waiting')
        home=self.due(job);request=self.workflow(job)
        self.assertFalse(hasattr(self.scheduler,'tick'),'the standalone execution scanner is removed')
        self.assertEqual(self.inputs,{})
        self.assertEqual(self.scheduler.advance(request)['state'],'completed');self.assertEqual(self.executions,0)
        stored=inspect(home)[0];self.assertFalse(stored['enabled']);self.assertEqual(stored['repeat']['completed'],1)
        event=stored['nocheh_running'];body={'channel':'scheduler','event_id':event,'attempt':1,'owner_epoch':2}
        self.assertEqual(self.scheduler.advance(request)['state'],'skipped')
        managed.start(body);self.assertEqual(self.finish_managed(managed,body)['state'],'done')
        managed.start(body);self.assertEqual(self.executions,1);self.assertIsNone(inspect(home)[0]['nocheh_running'])
        self.assertTrue(managed.path(body,'.receipt').exists());self.assertTrue(managed.path(body,'.published').exists())
        self.assertNotIn('Synthetic result',json.dumps(managed.runs.events(body)))

    def test_inngest_missed_slot_explicit_catchup_and_edit_before_execution(self):
        job=self.create();managed=self.migrate();home=self.due(job,120)
        self.assertEqual(self.scheduler.advance(self.workflow(job))['state'],'completed');self.assertEqual(self.executions,0)
        self.assertEqual(next(iter(self.inputs.values()))['fire_reason'],'missed')
        self.request('/api/cron/jobs/'+job['id']+'/catch-up','POST',{'request_id':'one-catchup'})
        request=self.workflow(job);self.assertEqual(self.scheduler.advance(request)['state'],'completed')
        event=inspect(home)[0]['nocheh_running'];body={'channel':'scheduler','event_id':event,'attempt':1,'owner_epoch':2}
        self.scheduler.recover();self.assertEqual(inspect(home)[0]['nocheh_running'],event,'restart retains workflow occurrence')
        current=self.request('/api/cron/jobs/'+job['id'])
        self.request('/api/cron/jobs/'+job['id'],'PUT',{'updates':{'prompt':'Owner edited during wait','_nocheh_revision':current['_nocheh_revision']}})
        self.assertEqual(managed.start(body)['state'],'cancelled');self.assertEqual(self.executions,0)
        self.assertFalse(managed.path(body,'.started').exists())
        self.assertEqual(self.scheduler.advance(request)['state'],'skipped')


class StoreSchedulerTests(SchedulerTests):
    """Repeat native cadence/receipt checks with generation-bound control profiles."""
    def setUp(self):
        super().setUp()
        from .test_runtime_profiles import ControlFixture
        from .runtime_profiles import ProfileCatalog
        self.store_env=patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'});self.store_env.start()
        self.control=ControlFixture()
        self.admin.policy=Scopes({'enabled':False,'owner_id':'42','group_ids':['-10']})
        self.admin.profile_catalog=ProfileCatalog(self.root,self.admin.policy,self.admin.token,self.control.request)

    def tearDown(self):
        self.store_env.stop();super().tearDown()

    def call(self,route,body):
        result=super().call(route,body)
        if route=='claim' and result.get('claimed'):
            claims={'scope':None,'event_id':body['event_id'],'audience':'nocheh-assistant','space':'42',
                'revision':self.control.epoch,'guard_epoch':self.control.epoch,'generation':self.control.generation,
                'logical_profile':body['profile'],'expires':(time.time()+600)*1000}
            encoded=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
            signature=base64.urlsafe_b64encode(hmac.new(self.admin.token.encode(),encoded.encode(),hashlib.sha256).digest()).decode().rstrip('=')
            result['archive_credential']='turn.'+encoded+'.'+signature
        return result

    def migrate(self):
        managed=super().migrate();original=self.scheduler.call
        def call(route,body):
            result=original(route,body)
            if route=='workflow-context':
                result={**result,'storage_layout':'original-only-v1',
                    'definition':{k:v for k,v in result['definition'].items() if k not in ('prompt','name')}}
            return result
        self.scheduler.call=call
        return managed


if __name__=='__main__':unittest.main()
