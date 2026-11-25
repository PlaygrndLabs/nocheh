"""Native storage and supervised scheduling acceptance without external traffic."""
import asyncio,base64,hashlib,hmac,io,json,os,tempfile,threading,time,unittest
from datetime import timedelta
from urllib.error import HTTPError
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from .native_admin import Administration
from .native_cron import manage,inspect,store,turn_capture
from .scheduler import Scheduler,now
from .scopes import Scopes
from .key_fixture import keyed
from services.chats import Served


def refused(code,status=403):
    """Nocheh's refusal as urllib raises it: the status and an {"error":code} body."""
    return HTTPError('http://nocheh-app:8780/v1/scheduler/x',status,'refused',{},io.BytesIO(json.dumps({'error':code}).encode()))


class DeliveryPolicyTests(unittest.TestCase):
    def test_delivery_policy_says_how_results_go_out(self):
        # ADR-0266: the owner's private chat gets each result with no card; a group's result waits for the owner's card.
        from .native_cron import delivery_policy
        with tempfile.TemporaryDirectory() as temp,patch.dict(os.environ,{'NOCHEH_RUNTIME_HOME':temp}):
            admin=Administration(None,Path(temp),'gpt-5.6-sol',Scopes({'enabled':False},Served.of('42',groups=['-10'])),'fixture-agent-key-not-a-real-credential')
            bound=lambda profile:admin.binding(admin.profile(profile)[0])
            self.assertEqual(delivery_policy({'deliver':'telegram'},bound('default')),'send_each_result')
            self.assertEqual(delivery_policy({},bound('default')),'local')
            self.assertEqual(delivery_policy({'deliver':'telegram'},bound(Scopes.profile('-10'))),'review_each_result')

    def test_a_members_own_chat_sends_each_result_only_with_personal_assistant_on(self):
        # Members' schedules: a member's own private chat with Personal assistant on gets each result with no card, as the
        # owner's does; a member's chat without it never runs as a member, and never sends without a card.
        from .native_cron import delivery_policy
        from .scheduler import scheduled_member
        from .scopes import Scope
        member,other='a'*64,'b'*64
        served=Served.of('42',groups=['-10'],members=['701','702'],assistants=['701'])
        bound=lambda chat:Scope(chat_id=chat,user_id='',owner=False,profile=Scopes.profile(chat),space=chat)
        self.assertTrue(served.member_assistant('701'))
        self.assertFalse(served.member_assistant('702'))
        self.assertFalse(served.member_assistant('-10'))
        self.assertEqual(delivery_policy({'deliver':'telegram'},bound('701'),served),'send_each_result')
        self.assertEqual(delivery_policy({'deliver':'telegram'},bound('702'),served),'review_each_result')
        self.assertEqual(delivery_policy({'deliver':'telegram'},bound('701')),'review_each_result','no served list: fail closed')
        self.assertEqual(delivery_policy({'deliver':'local'},bound('701'),served),'local')
        # The run's scope: that member, as storage names them; a mismatch, a missing member or a member named for any
        # other chat refuses it.
        self.assertEqual(scheduled_member(bound('701'),{'member':member},served).member,member)
        for context in ({},{'member':'x'},{'member':None}):
            self.assertIsNone(scheduled_member(bound('701'),context,served),context)
        self.assertIsNone(scheduled_member(bound('702'),{'member':other},served))
        self.assertEqual(scheduled_member(bound('702'),{},served),bound('702'))
        self.assertIsNone(scheduled_member(bound('-10'),{'member':member},served))
        self.assertFalse(Served.of('42',assistants=['701']).member_assistant('701'),'only a member\'s own open chat')


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.env=patch.dict(os.environ,{'NOCHEH_RUNTIME_HOME':str(self.root)});self.env.start()
        self.admin=Administration(None,self.root,'gpt-5.6-sol',Scopes({'enabled':False},Served.of('42')), 'fixture-agent-key-not-a-real-credential')
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
            # The run's one-time key names the profile it runs in (ADR-0305).
            claims={'scope':None,'event_id':body['event_id'],'audience':'nocheh-assistant','space':'42','revision':1,'expires':(time.time()+600)*1000,
                    'generation':'12345678-1234-1234-1234-123456789abc','guard_epoch':1,'logical_profile':body['profile']}
            encoded=base64.urlsafe_b64encode(json.dumps(keyed(claims,'scheduled')).encode()).decode().rstrip('=')
            signature=base64.urlsafe_b64encode(hmac.new(b'fixture-pass-signer',encoded.encode(),hashlib.sha256).digest()).decode().rstrip('=')
            return {**body,'claimed':True,'archive_credential':'turn.'+encoded+'.'+signature,'text':self.inputs[body['event_id']]['text']}
        if route=='finish':self.finished[body['event_id']]=body;return {'state':body['state']}
        if route in ('ownership','announce','delivery'):raise AssertionError('Nocheh no longer offers '+route)
        return {'state':'local'}

    def turn(self,path,body,timeout=None):
        """The sealed turn's relay to Nocheh (archive_tools.request), as schedule_gate uses it."""
        self.calls.append((path,body))
        if self.failed=='turn':raise refused('schedule_turn_not_allowed')
        return {'id':'s'*64,'event_id':'v'*64,'duplicate':False,'created':True,'notice':'sent'}

    async def runner(self,root,bound,body,model,credentials,session,cancelled=None):
        self.executions+=1
        while self.hold and not cancelled.is_set():await asyncio.sleep(.01)
        return {'state':'cancelled' if cancelled.is_set() else 'done','text':'Synthetic result','session_id':session}

    def request(self,path='/api/cron/jobs',method='GET',body=None,headers=None):
        return manage(self.admin,path,method,{},body or {},headers or {},self.call)

    def create(self,prompt='  Original\r\n\0 text  ',name='Fixture',**extra):
        """A schedule the owner set by asking (ADR-0290): Hermes's tool writes the chat's store, and the turn has Nocheh
        record it."""
        from cron import jobs as native
        name,physical=self.admin.profile('default');home=self.admin.preference_home(name,physical);bound=self.admin.binding(name)
        with store(home):
            job=native.create_job(prompt=prompt,schedule='every 1h',name=name,deliver='telegram',**extra)
            native.update_job(job['id'],{'prompt':prompt})
        turn_capture(job['id'],home,home.name,bound.chat_id,self.turn)
        return self.request('/api/cron/jobs/'+job['id'])

    def due(self,job,seconds=0):
        from cron import jobs as native
        home=Path(job['hermes_home'])
        with store(home):native.update_job(job['id'],{'next_run_at':(now()-timedelta(seconds=seconds)).isoformat()})
        return home

    def test_finished_schedule_can_be_removed(self):
        from cron import jobs as native
        job=self.create(repeat=1);home=Path(job['hermes_home'])
        with store(home):native.update_job(job['id'],{'state':'completed','enabled':False,'next_run_at':None})
        self.assertEqual(self.request('/api/cron/jobs/'+job['id'],'DELETE',{'request_id':'delete-one'}),{'ok':True})
        self.assertEqual(self.calls[-1][1]['grant'],'delete-one','the removal carries the request id of Nocheh\'s grant')
        self.assertEqual(self.request(),[])
        self.assertEqual(inspect(home)[0]['state'],'completed')

    def test_native_cron_only_reads_and_a_refused_capture_stays_inert(self):
        self.assertEqual(self.request(),[]);self.assertFalse(list(self.root.rglob('jobs.json')))
        job=self.create();self.assertEqual(job['prompt'],'  Original\r\n\0 text  ')
        home=Path(job['hermes_home']);original=(home/'cron/jobs.json').read_bytes();self.request();self.assertEqual((home/'cron/jobs.json').read_bytes(),original)
        # Creating, editing, catching up and cancelling are gone (ADR-0290); nothing reaches the store or Nocheh.
        self.calls.clear()
        for path,method,body in (('/api/cron/jobs','POST',{'name':'x','prompt':'p','schedule':'every 1h'}),
                                 ('/api/cron/jobs/'+job['id'],'PUT',{'updates':{'prompt':'p','_nocheh_revision':job['_nocheh_revision']}}),
                                 ('/api/cron/jobs/'+job['id']+'/catch-up','POST',{'request_id':'one'}),
                                 ('/api/cron/jobs/'+job['id']+'/cancel','POST',{'request_id':'one'})):
            with self.assertRaisesRegex(ValueError,'cron_operation_unavailable'):self.request(path,method,body)
        with self.assertRaisesRegex(ValueError,'cron_request_identity_required'):self.request('/api/cron/jobs/'+job['id']+'/pause','POST')
        self.assertEqual((self.calls,(home/'cron/jobs.json').read_bytes()),([],original))
        self.failed='turn'
        with self.assertRaises(HTTPError):self.create(name='Pending capture')
        # A new schedule Nocheh refused is removed again: the turn said it was not saved, so nothing is left to list.
        self.assertEqual([row['id'] for row in inspect(home)],[job['id']])
        # One Nocheh never recorded (here, changed by hand) has nothing there to delete; it is gone here all the same.
        _,inert=self.asked();inert=inert['id'];self.failed=None;self.calls.clear()
        self.assertEqual(self.request('/api/cron/jobs/'+inert,'DELETE',{'request_id':'delete-inert'}),{'ok':True})
        self.assertEqual(self.calls,[]);self.assertNotIn(inert,[row['id'] for row in self.request()])

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

    def test_missed_runs_are_not_replayed_and_run_now_carries_its_request(self):
        from .native_cron import owner_schedules
        job=self.create();managed=self.migrate();home=self.due(job,120);before=inspect(home)[0]['next_run_at']
        self.scheduler.advance(self.workflow(job));self.assertEqual(self.executions,0)
        from .scheduler import date
        self.assertEqual((date(inspect(home)[0]['next_run_at'])-date(before)).total_seconds(),3600)
        self.assertEqual(next(iter(self.inputs.values()))['fire_reason'],'missed')
        self.assertNotIn('request_id',next(iter(self.inputs.values())),'a clock fire names no press')
        with self.assertRaisesRegex(ValueError,'cron_operation_unavailable'):
            self.request('/api/cron/jobs/'+job['id']+'/catch-up','POST',{'request_id':'one-catch-up'})
        press={'operation':'run','profile':home.name,'job_id':job['id'],'request_id':'press-one'}
        owner_schedules(self.admin,press,self.call);request=self.workflow(job);self.scheduler.advance(request)
        fired=list(self.inputs.values())[-1]
        self.assertEqual((fired['fire_reason'],fired['request_id']),('manual','press-one'),'a press names its run-now grant')
        body={'channel':'scheduler','event_id':inspect(home)[0]['nocheh_running'],'attempt':1,'owner_epoch':2}
        managed.start(body);self.assertEqual(self.finish_managed(managed,body)['state'],'done')
        self.assertEqual(self.executions,1)
        owner_schedules(self.admin,press,self.call);self.assertEqual(self.scheduler.advance(request)['state'],'skipped')
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

    def test_job_preferences_are_ephemeral(self):
        from .profile_config import configure_profile
        from .policy_config import save,view
        from .turn_process import scheduled_preferences
        home=self.root/'profiles'/Scopes.profile('42');configure_profile(home,'gpt-5.6-sol')
        before=(home/'config.yaml').read_bytes()
        save(self.root,{'agent.max_iterations':3},view(self.root)['revision'],'job-one')
        values=scheduled_preferences(home,{'job_id':'job-one','job_preferences':{'memory.memory_char_limit':500,'agent.reasoning_effort':'high'}})
        self.assertEqual(values['agent.max_iterations'],3);self.assertEqual(values['memory.memory_char_limit'],500)
        self.assertEqual(values['agent.reasoning_effort'],'high')
        self.assertEqual((home/'config.yaml').read_bytes(),before)

    def asked(self,**fields):
        """A schedule Hermes's own tool made in a reply (ADR-0266), straight in the chat's store."""
        from cron import jobs as native
        from .native_cron import profiles
        _,home,_=next(profiles(self.admin))
        with store(home):
            job=native.create_job(prompt='Brief me',schedule='0 8 * * *',name='Morning brief',deliver='telegram',timezone='Asia/Tokyo',**fields)
        return home,job

    def test_a_schedule_set_by_asking_is_recorded_by_its_turn_and_the_loop_posts_only_checkpoints(self):
        from cron import jobs as native
        home,job=self.asked()
        self.scheduler.sync()
        self.assertEqual(self.calls,[],'a job Nocheh never recorded is inert: the loop does not post it')
        # The turn that set it posts it with its pass, and Nocheh's message about it, to the turn route.
        with store(home):native.update_job(job['id'],{'deliver':'origin'})
        self.assertEqual(turn_capture(job['id'],home,home.name,'42',self.turn)['notice'],'sent')
        (path,body),=self.calls
        self.assertEqual((path,body['scope'],body['profile'],body['job_id']),('/v1/schedules/turn/definition','42',home.name,job['id']))
        self.assertEqual((body['definition']['timezone'],body['definition']['deliver']),('Asia/Tokyo','telegram'))
        self.assertEqual(body['notice'],{'name':'Morning brief','schedule':job['schedule_display'],'timezone':'Asia/Tokyo','next_run_at':job['next_run_at']})
        stored=inspect(home)[0];version=stored['nocheh_definition_version']
        self.assertTrue(stored['nocheh_registered'] and stored['nocheh_announced'] and stored['deliver']=='telegram')
        self.calls.clear();self.scheduler.sync();self.assertEqual(self.calls,[],'nothing changed: nothing posted again')
        # A run ends: the loop posts a checkpoint of the same version, with no grant.
        with store(home):native.update_job(job['id'],{'nocheh_workflow_synced':False,'last_status':'success'})
        self.scheduler.sync()
        (route,body),=self.calls
        self.assertEqual((route,body['definition']['execution_version']),('definition',version));self.assertNotIn('grant',body)
        # Hermes's tool changes the prompt outside a turn that reports it: inert until set again, never posted.
        self.calls.clear()
        with store(home):native.update_job(job['id'],{'prompt':'Brief me with the weather'})
        self.scheduler.sync()
        self.assertEqual(self.calls,[]);self.assertFalse(inspect(home)[0]['nocheh_registered'])
        # Its workflow ends rather than waking every 30 s; the post that sets it again opens a new one.
        self.assertEqual(self.scheduler.advance(self.workflow({'hermes_home':str(home),'id':job['id']}))['state'],'completed')
        # Set again by asking: a new version, recorded by that turn.
        turn_capture(job['id'],home,home.name,'42',self.turn)
        self.assertNotEqual(self.calls[-1][1]['definition']['execution_version'],version)
        self.assertEqual(self.calls[-1][1]['definition']['prompt'],'Brief me with the weather')

    def test_a_turn_that_read_outside_content_saves_its_schedule_paused_and_posts_it_again(self):
        home,job=self.asked();posted=[]
        def steered(path,body,timeout=None):
            # Nocheh refuses one left running (ADR-0294) and records it paused, saying held.
            posted.append(body)
            if body['definition']['enabled']:raise refused('schedule_start_needed',409)
            return {'id':'s'*64,'event_id':'v'*64,'duplicate':False,'created':True,'notice':'sent','held':True}
        answer=turn_capture(job['id'],home,home.name,'42',steered)
        self.assertEqual((answer['held'],[body['definition']['enabled'] for body in posted]),(True,[True,False]))
        self.assertNotEqual(posted[0]['definition']['execution_version'],posted[1]['definition']['execution_version'])
        self.assertGreater(posted[1]['workflow_sequence'],posted[0]['workflow_sequence'])
        stored=inspect(home)[0]
        self.assertEqual((stored['enabled'],stored['state'],stored['nocheh_registered'],stored['prompt']),(False,'paused',True,job['prompt']))
        # Any other refusal of the paused one still removes it, as for any new schedule Nocheh refused.
        home,other=self.asked()
        def refusing(path,body,timeout=None):
            if body['definition']['enabled']:raise refused('schedule_start_needed',409)
            raise refused('schedule_turn_not_allowed')
        with self.assertRaises(HTTPError):turn_capture(other['id'],home,home.name,'42',refusing)
        self.assertNotIn(other['id'],[row['id'] for row in inspect(home)])

    def test_a_refused_checkpoint_leaves_its_job_inert_and_holds_back_no_other(self):
        from cron import jobs as native
        home,first=self.asked();_,second=self.asked()
        for job in (first,second):turn_capture(job['id'],home,home.name,'42',self.turn)
        with store(home):
            for job in (first,second):native.update_job(job['id'],{'nocheh_workflow_synced':False})
        original=self.call
        def call(route,body):
            if route=='definition' and body['job_id']==first['id']:raise refused('schedule_definition_not_allowed')
            return original(route,body)
        self.scheduler.call=call;self.calls.clear()
        self.scheduler.sync()
        stored={job['id']:job for job in inspect(home)}
        self.assertFalse(stored[first['id']]['nocheh_registered'])
        self.assertTrue(stored[second['id']]['nocheh_registered'] and stored[second['id']]['nocheh_workflow_synced'])
        self.calls.clear();self.scheduler.sync();self.assertEqual(self.calls,[],'the refused job is not posted again')
        # Any other failure is still reported by the loop.
        with store(home):native.update_job(second['id'],{'nocheh_workflow_synced':False})
        self.scheduler.call=lambda route,body:(_ for _ in ()).throw(OSError('outage'))
        with self.assertRaises(OSError):self.scheduler.sync()

    def test_the_schedules_pages_list_pause_run_and_delete_with_nochehs_grant(self):
        from .native_cron import owner_schedules
        home,job=self.asked();turn_capture(job['id'],home,home.name,'42',self.turn)
        listed=owner_schedules(self.admin,{'operation':'list'},self.call)['schedules']
        self.assertEqual([(row['id'],row['profile'],row['scope'],row['name'],row['timezone'],row['set_in_chat'],row['enabled']) for row in listed],
                         [(job['id'],home.name,'42','Morning brief','Asia/Tokyo',True,True)])
        self.assertNotIn('prompt',listed[0],'the list never carries the prompt text')
        version=inspect(home)[0]['nocheh_definition_version'];self.calls.clear()
        with self.assertRaisesRegex(ValueError,'cron_request_identity_required'):
            owner_schedules(self.admin,{'operation':'pause','profile':home.name,'job_id':job['id']},self.call)
        self.assertEqual(self.calls,[])
        paused=owner_schedules(self.admin,{'operation':'pause','profile':home.name,'job_id':job['id'],'request_id':'press-pause'},self.call)['schedule']
        self.assertFalse(paused['enabled'])
        (route,body),=self.calls
        self.assertEqual((route,body['grant'],body['definition']['enabled']),('definition','press-pause',False))
        self.assertNotEqual(body['definition']['execution_version'],version)
        owner_schedules(self.admin,{'operation':'resume','profile':home.name,'job_id':job['id'],'request_id':'press-resume'},self.call)
        self.assertEqual(self.calls[-1][1]['grant'],'press-resume')
        owner_schedules(self.admin,{'operation':'run','profile':home.name,'job_id':job['id'],'request_id':'press-one'},self.call)
        self.assertEqual(inspect(home)[0]['nocheh_pending']['reason'],'manual')
        self.assertNotIn('grant',self.calls[-1][1],'Run now posts a checkpoint; the fire itself carries the request id')
        with self.assertRaises(ValueError):owner_schedules(self.admin,{'operation':'pause','profile':home.name,'job_id':'../x','request_id':'r'},self.call)
        with self.assertRaises(ValueError):owner_schedules(self.admin,{'operation':'edit','profile':home.name,'job_id':job['id'],'request_id':'r'},self.call)
        # Nocheh refuses a change it did not grant: the job stays as changed, but inert.
        def call(route,body):
            if route=='definition':raise refused('schedule_definition_not_allowed')
            return self.call(route,body)
        with self.assertRaisesRegex(ValueError,'cron_change_refused'):
            owner_schedules(self.admin,{'operation':'pause','profile':home.name,'job_id':job['id'],'request_id':'press-stale'},call)
        self.assertFalse(inspect(home)[0]['nocheh_registered'])
        self.assertEqual(owner_schedules(self.admin,{'operation':'delete','profile':home.name,'job_id':job['id'],'request_id':'press-delete'},self.call),{'ok':True})
        self.assertEqual(self.calls[-1][1]['grant'],'press-delete')
        self.assertEqual(owner_schedules(self.admin,{'operation':'list'},self.call)['schedules'],[])

    def test_a_press_whose_answer_is_lost_is_posted_again_until_nocheh_answers(self):
        from .native_cron import owner_schedules
        home,job=self.asked();turn_capture(job['id'],home,home.name,'42',self.turn)
        # Nocheh records the pause, but its answer is lost: the press fails, the job is not running for now.
        posted=[]
        def lost(route,body):
            if route=='definition':posted.append(body);raise TimeoutError('timed out')
            return self.call(route,body)
        press={'operation':'pause','profile':home.name,'job_id':job['id'],'request_id':'press-pause'}
        with self.assertRaises(TimeoutError):owner_schedules(self.admin,press,lost)
        row,=owner_schedules(self.admin,{'operation':'list'},self.call)['schedules']
        self.assertEqual((row['saved'],row['state'],row['next_run_at']),(False,'not_saved',None))
        self.assertEqual(self.scheduler.advance(self.workflow({'hermes_home':str(home),'id':job['id']}))['state'],'waiting','its workflow waits while it is posted again')
        # The loop posts the very same body with the same grant; Nocheh answers it (here, as the duplicate it is).
        self.calls.clear();self.scheduler.sync()
        (route,body),=self.calls
        self.assertEqual((route,body),('definition',posted[0]));self.assertEqual(body['grant'],'press-pause')
        stored=inspect(home)[0]
        self.assertTrue(stored['nocheh_registered'] and stored['nocheh_workflow_synced']);self.assertFalse(stored['enabled'])
        self.assertIsNone(stored['nocheh_posting'])
        self.calls.clear();self.scheduler.sync();self.assertEqual(self.calls,[],'answered: not posted again')

    def test_a_lost_removal_nocheh_refuses_for_good_shows_again_so_it_can_be_deleted(self):
        from .native_cron import owner_schedules
        home,job=self.asked();turn_capture(job['id'],home,home.name,'42',self.turn)
        def outage(route,body):
            if route=='definition':raise OSError('synthetic archive outage')
            return self.call(route,body)
        with self.assertRaises(OSError):
            owner_schedules(self.admin,{'operation':'delete','profile':home.name,'job_id':job['id'],'request_id':'press-delete'},outage)
        self.assertEqual(owner_schedules(self.admin,{'operation':'list'},self.call)['schedules'],[])
        self.assertEqual(self.scheduler.advance(self.workflow({'hermes_home':str(home),'id':job['id']}))['state'],'completed','a removed job ends its workflow')
        # Refused while the first post may still be committing: posted again on a later pass.
        self.scheduler.call=lambda route,body:(_ for _ in ()).throw(refused('schedule_definition_not_allowed'))
        self.scheduler.sync();self.assertTrue(inspect(home)[0]['nocheh_posting'])
        # Once that window has passed, the refusal is final: the job shows again, not running, and says why.
        from cron import jobs as native
        with store(home):
            stored=inspect(home)[0];native.update_job(job['id'],{'nocheh_posting':{**stored['nocheh_posting'],'until':now().isoformat()}})
        self.scheduler.sync()
        stored=inspect(home)[0]
        self.assertEqual((stored['nocheh_posting'],stored['nocheh_removed'],stored['nocheh_registered'],stored['last_error']),(None,False,False,'not_saved'))
        row,=owner_schedules(self.admin,{'operation':'list'},self.call)['schedules']
        self.assertEqual((row['id'],row['saved'],row['state']),(job['id'],False,'not_saved'))
        # Deleted again with a new press, and Nocheh records it.
        self.scheduler.call=self.call;self.calls.clear()
        self.assertEqual(owner_schedules(self.admin,{'operation':'delete','profile':home.name,'job_id':job['id'],'request_id':'press-again'},self.call),{'ok':True})
        self.assertEqual((self.calls[-1][1]['grant'],self.calls[-1][1]['definition']['removed']),('press-again',True))
        self.assertEqual(owner_schedules(self.admin,{'operation':'list'},self.call)['schedules'],[])

    def test_a_turn_whose_answer_is_lost_is_registered_by_the_loop_and_a_refused_change_shows_as_not_saved(self):
        from cron import jobs as native
        from .native_cron import owner_schedules
        home,job=self.asked()
        def lost(path,body,timeout=None):self.calls.append((path,body));raise TimeoutError('timed out')
        with self.assertRaises(TimeoutError):turn_capture(job['id'],home,home.name,'42',lost)
        (_,sent),=self.calls;stored=inspect(home)[0]
        self.assertFalse(stored['nocheh_registered']);self.assertIsNone(stored['nocheh_posting']['grant'])
        # The loop posts the same body, with no grant, to Hermes's own route: Nocheh takes it only if that turn saved it.
        self.calls.clear();self.scheduler.sync()
        (route,body),=self.calls
        self.assertEqual(route,'definition');self.assertNotIn('grant',body)
        self.assertEqual(body,{key:value for key,value in sent.items() if key!='notice'})
        self.assertTrue(inspect(home)[0]['nocheh_registered'])
        # A later change in a turn that Nocheh refuses: kept, but shown as not running, with nothing posted again.
        with store(home):native.update_job(job['id'],{'prompt':'Brief me with the weather'})
        self.failed='turn'
        with self.assertRaises(HTTPError):turn_capture(job['id'],home,home.name,'42',self.turn)
        stored=inspect(home)[0]
        self.assertEqual((stored['nocheh_registered'],stored['nocheh_posting'],stored['last_error']),(False,None,'not_saved'))
        row,=owner_schedules(self.admin,{'operation':'list'},self.call)['schedules']
        self.assertEqual((row['saved'],row['state'],row['next_run_at']),(False,'not_saved',None))
        self.calls.clear();self.scheduler.sync();self.assertEqual(self.calls,[])

    def test_a_turn_change_during_a_fire_is_not_taken_as_the_schedulers_own(self):
        job=self.create();self.migrate();home=self.due(job);version=inspect(home)[0]['nocheh_definition_version']
        original=self.scheduler.call
        def call(route,body):
            result=original(route,body)
            if route=='input':
                # Hermes's tool edits the prompt in a live turn while this capture is in flight; it does not take the lock.
                from cron import jobs as native
                native.update_job(job['id'],{'prompt':'Changed in chat'})
            return result
        self.scheduler.call=call;self.calls.clear()
        self.assertEqual(self.scheduler.advance(self.workflow(job))['state'],'completed')
        self.assertEqual([route for route,_ in self.calls],['input'],'no checkpoint posts the turn\'s change under the old version')
        from .native_cron import revision
        stored=inspect(home)[0];self.assertNotEqual(stored['nocheh_synced_revision'],revision(stored,home.name))
        # The turn that changed it then records it as a new version.
        turn_capture(job['id'],home,home.name,'42',self.turn)
        path,body=self.calls[-1]
        self.assertEqual((path,body['definition']['prompt']),('/v1/schedules/turn/definition','Changed in chat'))
        self.assertNotEqual(body['definition']['execution_version'],version)

    def test_refused_fires(self):
        from cron import jobs as native
        job=self.create();self.migrate();home=Path(job['hermes_home'])
        original=self.scheduler.call;answers={}
        def call(route,body):
            if route=='input' and body['fire_reason'] in answers:raise answers[body['fire_reason']]
            return original(route,body)
        self.scheduler.call=call
        # A press Nocheh did not grant (or whose grant expired) is dropped, so the job is not stuck on it.
        for code in ('fire_grant_run_now','schedule_catch_up_off'):
            reason='catch_up' if code=='schedule_catch_up_off' else 'manual'
            answers[reason]=refused(code)
            with store(home):native.update_job(job['id'],{'nocheh_pending':{'id':'press-'+reason,'reason':reason,'at':now().isoformat()}})
            self.assertEqual(self.scheduler.advance(self.workflow(job))['state'],'completed')
            stored=inspect(home)[0]
            self.assertEqual((stored['nocheh_pending'],stored.get('nocheh_running'),stored['last_error']),(None,None,'run_now_refused'))
            self.assertTrue(stored['nocheh_registered'] and stored['nocheh_workflow_synced'],'the checkpoint is posted')
        # A timed slot Nocheh's clock says is not due is skipped like a missed one, and never run.
        answers['scheduled']=refused('fire_grant_time');self.due(job);before=inspect(home)[0]
        self.assertEqual(self.scheduler.advance(self.workflow(job))['state'],'completed')
        stored=inspect(home)[0]
        self.assertEqual((stored.get('nocheh_running'),stored['last_status'],stored['last_error'],stored['nocheh_missed']['reason']),
                         (None,'skipped','scheduled_refused','refused'))
        self.assertGreater(stored['next_run_at'],before['next_run_at']);self.assertEqual(stored['repeat']['completed'],(before.get('repeat') or {}).get('completed',0)+1)
        self.assertTrue(stored['nocheh_registered'])
        # No clock grant: Inngest retries the same slot, nothing changes here.
        answers['scheduled']=refused('fire_grant_clock');self.due(job);before=inspect(home)[0]
        with self.assertRaises(HTTPError):self.scheduler.advance(self.workflow(job))
        self.assertEqual(inspect(home)[0],before)
        # A capture whose checkpoint Nocheh refuses: the job goes inert, the advance ends.
        answers.clear()
        def checkpoint(route,body):
            if route=='definition':raise refused('schedule_definition_not_allowed')
            return call(route,body)
        self.scheduler.call=checkpoint
        self.assertEqual(self.scheduler.advance(self.workflow(job))['state'],'completed')
        self.assertFalse(inspect(home)[0]['nocheh_registered'])
        self.assertFalse([route for route,_ in self.calls if route in ('ownership','announce','delivery')])

    def migrate(self):
        from .managed_async import ManagedAsync
        original=self.call
        def call(route,body):
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

    def test_inngest_missed_slot_run_now_and_edit_before_execution(self):
        from .native_cron import owner_schedules
        job=self.create();managed=self.migrate();home=self.due(job,120)
        self.assertEqual(self.scheduler.advance(self.workflow(job))['state'],'completed');self.assertEqual(self.executions,0)
        self.assertEqual(next(iter(self.inputs.values()))['fire_reason'],'missed')
        owner_schedules(self.admin,{'operation':'run','profile':home.name,'job_id':job['id'],'request_id':'one-press'},self.call)
        request=self.workflow(job);self.assertEqual(self.scheduler.advance(request)['state'],'completed')
        event=inspect(home)[0]['nocheh_running'];body={'channel':'scheduler','event_id':event,'attempt':1,'owner_epoch':2}
        self.scheduler.recover();self.assertEqual(inspect(home)[0]['nocheh_running'],event,'restart retains workflow occurrence')
        # The owner pauses it before it runs (with Nocheh's grant): a new version, so the waiting run is cancelled.
        owner_schedules(self.admin,{'operation':'pause','profile':home.name,'job_id':job['id'],'request_id':'one-pause'},self.call)
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
        self.admin.policy=Scopes({'enabled':False},Served.of('42',groups=['-10']))
        self.admin.profile_catalog=ProfileCatalog(self.root,self.admin.policy,self.admin.agent_key,self.control.request)

    def tearDown(self):
        self.store_env.stop();super().tearDown()

    def call(self,route,body):
        result=super().call(route,body)
        if route=='claim' and result.get('claimed'):
            claims={'scope':None,'event_id':body['event_id'],'audience':'nocheh-assistant','space':'42',
                'revision':self.control.epoch,'guard_epoch':self.control.epoch,'generation':self.control.generation,
                'logical_profile':body['profile'],'expires':(time.time()+600)*1000}
            encoded=base64.urlsafe_b64encode(json.dumps(keyed(claims,'scheduled')).encode()).decode().rstrip('=')
            signature=base64.urlsafe_b64encode(hmac.new(b'fixture-pass-signer',encoded.encode(),hashlib.sha256).digest()).decode().rstrip('=')
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
