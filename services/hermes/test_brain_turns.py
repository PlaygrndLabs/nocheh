import asyncio
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from .async_runs import CLOSED,identity
from .brain_turns import BrainTurns
from services.durable import canonical,digest,immutable_file
from .scopes import Scope,Scopes
from .subscription import ProviderNotConfigured

SECRET='synthetic-service-token-123456789'
BOT='123456'
CITED='e'*64
LEADER='ab'*32
REPO=Path(__file__).resolve().parents[2]


def credential(chat,event,topic=None,secret=SECRET):
    claims={'scope':chat,'event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant',
            **({'space':chat+'/topic/'+str(topic),'revision':1} if topic else {})}
    body=base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
    signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
    return 'turn.'+body+'.'+signature


def turn_body(update,chat='-20',text='synthetic question',topic=None,bot=BOT,secret=SECRET,**changes):
    # The Telegram run body storage sends today, without `asynchronous`.
    key=f'telegram:{bot}:update:{update}';event=digest(key)
    message={'message_id':update,'date':1700000000,'chat':{'id':int(chat),**({'type':'supergroup','is_forum':True} if topic else {'type':'group'})},
             'from':{'id':456,'is_bot':False,'first_name':'Participant'},'text':text,
             **({'message_thread_id':topic,'is_topic_message':True} if topic else {})}
    value={'channel':'telegram','event_id':event,'attempt':1,'source_key':key,'scope':chat,'payload':{'update_id':update,'message':message},
           'text':text,'transcripts':[],'files':[],'control_reply':None,'guard_mode':'on','archive_credential':credential(chat,event,topic,secret),'prompts':{}}
    value.update(changes)
    return value


def observe(body):return {'channel':'telegram','event_id':body['event_id'],'attempt':body['attempt'],'observe_only':True}


def resolve(payload,chat):
    message=payload['message'];topic=message.get('message_thread_id')
    return Scope(chat,str(message['from']['id']),False,Scopes.profile(chat),chat if topic is None else chat+'/topic/'+str(topic))


class BrainTurnTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup);self.root=Path(folder.name)
        environment=patch.dict(os.environ,{'SERVICE_TOKEN':SECRET,'HERMES_HOME':os.environ.get('HERMES_HOME') or str(self.root/'home')})
        environment.start();self.addCleanup(environment.stop)
        self.folder=self.root/'spool'/'brain-turns';self.calls=[]

    def brain(self,turn,capacity=3,resolve=resolve,credentials=lambda:'synthetic-credentials',opened=True):
        brain=BrainTurns(self.root,self.root/'spool',SimpleNamespace(enabled=True,resolve=resolve),'synthetic-model',credentials,turn=turn,capacity=capacity)
        if opened:brain.open();self.addCleanup(brain.stop)
        return brain

    def replying(self,text='Synthetic answer',session='nocheh-synthetic',**extra):
        async def turn(root,scope,body,model,credentials,cancelled=None):
            self.calls.append((scope,body['attempt'],model,credentials))
            return {'state':'done','text':text,'session_id':session,**extra}
        return turn

    def wait(self,brain,body):
        for _ in range(500):
            state=brain.resume(observe(body))
            if state['state'] in CLOSED:return state
            time.sleep(.01)
        self.fail('turn did not close')

    def until(self,condition):
        for _ in range(500):
            if condition():return
            time.sleep(.005)
        self.fail('condition not reached')

    def content_free(self,*phrases,kept=('.request','.outcome')):
        # Only the request and the outcome may hold content.
        for path in self.folder.iterdir():
            if path.suffix in kept:continue
            for phrase in phrases:self.assertNotIn(phrase,path.read_text(),path.name)

    def test_the_reply_comes_back_with_citations_rendered_and_only_its_outcome_holds_it(self):
        text=f'Synthetic answer 【nocheh:event:{CITED}】 from nocheh:event:{CITED}.'
        brain=self.brain(self.replying(text,timings={'conversation':{'ms':40,'calls':1},'private phrase':{'ms':1,'calls':1}}))
        # Nocheh decides group addressing before it starts a turn.
        body=turn_body(41,group_addressing={'direct':False,'handles':[]})
        self.assertIn(brain.start(body)['state'],('queued','running','done'))
        result=self.wait(brain,body)
        self.assertEqual(result['reply'],{'text':'Synthetic answer from the Archive.','session_id':'nocheh-synthetic'})
        self.assertEqual(result['timings'],{'conversation':{'ms':40,'calls':1}})
        self.assertEqual(set(result['window']),{'queued','assistant','finished'})
        scope,attempt,model,credentials=self.calls[0]
        self.assertEqual((scope.chat_id,scope.space,attempt,model,credentials),('-20','-20',1,'synthetic-model','synthetic-credentials'))
        run=result['run_id'];outcome=self.folder/(run+'.outcome')
        self.assertEqual(outcome.stat().st_mode&0o777,0o600)
        self.assertEqual(json.loads(outcome.read_bytes())['reply']['text'],'Synthetic answer from the Archive.')
        self.assertNotIn('reply',json.loads((self.folder/(run+'.result')).read_bytes()))
        self.content_free('Synthetic answer','the Archive','nocheh:event','private')
        self.assertEqual(brain.start({**body,'archive_credential':credential('-20',body['event_id'])}),result,'a repeated start answers from the receipt')
        self.assertEqual(brain.cancel(body),result,'a closed turn keeps its reply')
        events=brain.events({**observe(body),'after':0})['events']
        self.assertEqual([(event['state'],event['stage']) for event in events],[('queued','admission'),('running','assistant'),('done','delivery')])
        self.assertEqual(len(self.calls),1)

    def test_silence_closes_suppressed_without_a_reply(self):
        for update,text in ((41,''),(42,f' 【nocheh:event:{CITED}】'),(43,'  \n')):
            with self.subTest(text=text):
                brain=self.brain(self.replying(text));body=turn_body(update);brain.start(body)
                state=self.wait(brain,body)
                self.assertEqual((state['state'],state.get('error_code')),('suppressed','intentional_silence'));self.assertNotIn('reply',state)

    def test_a_restart_answers_from_the_outcome_without_running_the_turn_again(self):
        brain=self.brain(self.replying());body=turn_body(41);brain.start(body);done=self.wait(brain,body)
        # The process stopped after the outcome was kept, before the receipt closed the run.
        (self.folder/(done['run_id']+'.result')).unlink();brain.stop();self.calls.clear()
        restarted=self.brain(self.replying())
        observed=restarted.resume(observe(body))
        self.assertEqual((observed['state'],observed['reply']),('done',done['reply']))
        self.assertEqual(restarted.start(body)['reply'],done['reply'])
        # Without an outcome the effect is unknown: the run closes uncertain and never runs again.
        other=turn_body(42);run=identity(other)
        immutable_file(self.folder,run+'.request',canonical(other));immutable_file(self.folder,run+'.started',canonical({'run_id':run}))
        state=restarted.resume(observe(other))
        self.assertEqual((state['state'],state.get('error_code')),('ambiguous','runtime_execution_interrupted'));self.assertNotIn('reply',state)
        self.assertEqual(restarted.start(other)['state'],'ambiguous')
        self.assertEqual(self.calls,[])

    def test_observation_never_starts_a_turn(self):
        brain=self.brain(self.replying());body=turn_body(41)
        self.assertEqual(brain.resume(observe(body))['state'],'not_found')
        self.assertEqual(list(self.folder.iterdir()),[])
        # The request is kept, but the process stops before its worker starts.
        with patch('threading.Thread.start'):self.assertEqual(brain.start(body)['state'],'running')
        brain.runs.active.clear()
        closed=self.brain(self.replying(),opened=False)
        self.assertEqual(closed.resume(observe(body))['state'],'queued','observation needs no running loop')
        with self.assertRaisesRegex(RuntimeError,'brain_not_ready'):closed.resume({**observe(body),'observe_only':False})
        with self.assertRaisesRegex(RuntimeError,'brain_not_ready'):closed.start(body)
        restarted=self.brain(self.replying())
        self.assertEqual(restarted.resume(observe(body))['state'],'queued')
        time.sleep(.05);self.assertEqual(self.calls,[],'observation cannot launch a queued turn')
        resumed={key:value for key,value in observe(body).items() if key!='observe_only'}
        self.assertIn(restarted.resume(resumed)['state'],('running','done'))
        self.assertEqual(self.wait(restarted,body)['reply']['text'],'Synthetic answer');self.assertEqual(len(self.calls),1)

    def test_cancel_stops_a_running_turn_withdraws_a_late_answer_and_skips_a_queued_one(self):
        entered=threading.Event();answer=['cancelled']
        async def turn(root,scope,body,model,credentials,cancelled=None):
            entered.set()
            while not cancelled.is_set():await asyncio.sleep(.005)
            return {'state':answer[0],'text':'Withdrawn synthetic answer','session_id':'nocheh-synthetic'}
        brain=self.brain(turn)
        for update,result in ((41,'cancelled'),(42,'done')):
            with self.subTest(result=result):
                entered.clear();answer[0]=result;body=turn_body(update);brain.start(body);self.assertTrue(entered.wait(2))
                self.assertTrue(brain.cancel(body)['cancel_requested'])
                state=self.wait(brain,body)
                self.assertEqual(state['state'],'cancelled');self.assertNotIn('reply',state)
                self.assertEqual(brain.cancel(body)['state'],'cancelled')
        self.content_free('Withdrawn',kept=('.request',))
        gate=threading.Event();started=[]
        async def ordered(root,scope,body,model,credentials,cancelled=None):
            started.append(body['text'])
            while body['text']=='first' and not gate.is_set():await asyncio.sleep(.005)
            return {'state':'done','text':'Reply to '+body['text'],'session_id':'nocheh-synthetic'}
        brain=self.brain(ordered);first=turn_body(51,text='first');second=turn_body(52,text='second')
        brain.start(first);self.until(lambda:started==['first'])
        brain.start(second);self.assertTrue(brain.cancel(second)['cancel_requested'])
        gate.set()
        self.assertEqual(self.wait(brain,first)['reply']['text'],'Reply to first')
        self.assertEqual(self.wait(brain,second)['state'],'cancelled')
        self.assertEqual(started,['first'],'a turn cancelled in its lane never runs')

    def test_a_shutdown_is_not_a_cancel(self):
        # Nocheh never retries a cancelled turn, so a stop leaves unfinished turns to the restart.
        gate=threading.Event();started=[]
        async def turn(root,scope,body,model,credentials,cancelled=None):
            started.append(body['text'])
            while not cancelled.is_set() and not (body['text']=='quick' and gate.is_set()):await asyncio.sleep(.005)
            return {'state':'cancelled' if cancelled.is_set() else 'done','text':'Reply to '+body['text'],'session_id':'nocheh-synthetic'}
        brain=self.brain(turn)
        slow,later,quick=turn_body(1,'-20','slow'),turn_body(2,'-20','later'),turn_body(3,'-30','quick')
        for body in (slow,later,quick):brain.start(body)
        self.until(lambda:sorted(started)==['quick','slow'])
        timer=threading.Timer(.1,gate.set);timer.start();self.addCleanup(timer.cancel)
        brain.stop(wait=.5)
        self.assertEqual(brain.resume(observe(quick))['reply']['text'],'Reply to quick','a turn that ends before the deadline keeps its reply')
        for body in (slow,later):self.assertFalse((self.folder/(identity(body)+'.result')).exists())
        restarted=self.brain(turn)
        for body in (slow,later):
            with self.subTest(text=body['text']):
                state=restarted.resume(observe(body))
                self.assertEqual((state['state'],state.get('error_code')),('ambiguous','runtime_execution_interrupted'))
                self.assertFalse((self.folder/(state['run_id']+'.outcome')).exists())
        # A journal that ran the assistant and never reached delivery is one Nocheh reopens.
        events=restarted.events({**observe(slow),'after':0})['events']
        self.assertEqual([(event['state'],event['stage']) for event in events],[('queued','admission'),('running','assistant'),('ambiguous','assistant')])
        self.assertEqual(sorted(started),['quick','slow'],'the restart runs nothing again')

    def test_one_conversation_keeps_its_order_and_capacity_bounds_the_rest(self):
        names=('slow','later','other','topic','held','third');gates={name:threading.Event() for name in names};started=[]
        async def turn(root,scope,body,model,credentials,cancelled=None):
            text=body['text'];started.append(text)
            while not gates[text].is_set():await asyncio.sleep(.005)
            return {'state':'done','text':'Reply to '+text,'session_id':'nocheh-'+text}
        brain=self.brain(turn,capacity=2)
        slow,later,other=turn_body(1,'-20','slow'),turn_body(2,'-20','later'),turn_body(3,'-30','other')
        topic,held,third=turn_body(6,'-20','topic',topic=7),turn_body(4,'-30','held'),turn_body(5,'-40','third')
        brain.start(slow);self.until(lambda:'slow' in started)
        brain.start(later)
        gates['other'].set();brain.start(other)
        self.assertEqual(self.wait(brain,other)['reply']['text'],'Reply to other','another chat does not wait for a running turn')
        gates['topic'].set();brain.start(topic)
        self.assertEqual(self.wait(brain,topic)['reply']['text'],'Reply to topic','another topic of the same group does not wait')
        brain.start(held);self.until(lambda:'held' in started)
        brain.start(third);time.sleep(.05)
        self.assertNotIn('later',started,'the same chat keeps its order')
        self.assertNotIn('third',started,'a third chat waits for a free slot before its turn starts')
        gates['held'].set();self.assertEqual(self.wait(brain,held)['state'],'done')
        gates['third'].set();self.assertEqual(self.wait(brain,third)['state'],'done')
        self.assertNotIn('later',started,'a free slot does not reorder one chat')
        gates['later'].set();gates['slow'].set()
        self.assertEqual(self.wait(brain,slow)['reply']['text'],'Reply to slow')
        self.assertEqual(self.wait(brain,later)['reply']['text'],'Reply to later')
        self.assertLess(started.index('slow'),started.index('later'))
        self.assertEqual(sorted(started),sorted(names),'every turn ran exactly once')
        self.assertEqual(brain.lanes,{},'idle chats leave no lane behind')

    def test_a_continuation_attempt_is_its_own_run(self):
        brain=self.brain(self.replying());attempt='c1-'+LEADER[:40]
        follow=turn_body(41,attempt=attempt,continuation=LEADER);brain.start(follow)
        self.assertEqual(self.wait(brain,follow)['reply']['text'],'Synthetic answer')
        message=turn_body(41)
        self.assertEqual(brain.resume(observe(message))['state'],'not_found','the message turn is another run')
        brain.start(message);self.assertEqual(self.wait(brain,message)['state'],'done')
        self.assertEqual([call[1] for call in self.calls],[attempt,1])
        files=sorted(self.folder.iterdir())
        for body in (turn_body(41,attempt='c1-'+'f'*40,continuation=LEADER),turn_body(41,attempt=1,continuation=LEADER),
                     turn_body(41,attempt='c0-'+LEADER[:40],continuation=LEADER),turn_body(41,attempt='c2-'+LEADER[:40],continuation=LEADER,control_reply='Fixed'),
                     turn_body(41,attempt=attempt)):
            with self.subTest(attempt=body['attempt']),self.assertRaises(ValueError):brain.start(body)
        self.assertEqual(sorted(self.folder.iterdir()),files,'a refused continuation writes nothing')

    def test_a_malformed_turn_is_refused_before_anything_is_written(self):
        brain=self.brain(self.replying());other='telegram:654321:update:41'
        for body in (turn_body(41,control_reply='Fixed reply'),turn_body(41,channel='browser'),turn_body(41,channel='scheduler'),
                     turn_body(41,source_key=f'telegram:{BOT}:update:42'),
                     turn_body(41,source_key=f'telegram:{BOT}:update:42',event_id=digest(f'telegram:{BOT}:update:42')),
                     turn_body(41,source_key=f'telegram:{BOT}:update:041',event_id=digest(f'telegram:{BOT}:update:041')),
                     turn_body(41,payload={'update_id':'41','message':{}}),turn_body(41,attempt=True),turn_body(41,attempt='1'),turn_body(41,event_id='A'*64)):
            with self.subTest(body={key:body[key] for key in ('channel','attempt','source_key','control_reply')}),self.assertRaises(ValueError):brain.start(body)
        for route in (brain.resume,brain.cancel,brain.events):
            with self.subTest(route=route.__name__),self.assertRaisesRegex(ValueError,'runtime_channel_unavailable'):route({**observe(turn_body(41)),'channel':'browser'})
        self.assertEqual(list(self.folder.iterdir()),[]);self.assertEqual(self.calls,[])
        # No bot id is compared: the source key's shape and digest, and the signed pass, bind the turn.
        body=turn_body(41,bot='654321');self.assertEqual(other,body['source_key']);brain.start(body)
        self.assertEqual(self.wait(brain,body)['state'],'done')

    def test_failures_keep_the_gateways_bounded_codes(self):
        names=['web_search','private name!',7]+['tool_'+str(n) for n in range(20)]
        cases=[({'state':'failed','error_code':'assistant_runtime_unavailable','error_type':'TimeoutError','error_stage':'collect','text':'private answer'},
                {'state':'failed','error_code':'assistant_runtime_unavailable','error_type':'TimeoutError','error_stage':'collect'}),
               ({'state':'failed','error_code':'assistant_runtime_unavailable','error_type':'private text here','text':''},
                {'state':'failed','error_code':'assistant_runtime_unavailable'}),
               ({'state':'failed','error_code':'unexpected_profile_tool','unexpected_tool_names':names},
                {'state':'failed','error_code':'unexpected_profile_tool','unexpected_tool_names':['web_search']+['tool_'+str(n) for n in range(13)]}),
               ({'state':'failed'},{'state':'failed','error_code':'model_unavailable'}),
               ({'state':'failed','error_code':'space_policy_changed'},{'state':'failed','error_code':'space_policy_changed'}),
               (RuntimeError('private provider response'),{'state':'failed','error_code':'assistant_runtime_unavailable','error_type':'RuntimeError','error_stage':'turn'})]
        async def turn(root,scope,body,model,credentials,cancelled=None):
            value=cases[int(body['text'])][0]
            if isinstance(value,Exception):raise value
            return value
        brain=self.brain(turn)
        for index,(_,expected) in enumerate(cases):
            with self.subTest(expected=expected):
                body=turn_body(60+index,text=str(index));brain.start(body);state=self.wait(brain,body)
                self.assertEqual({key:value for key,value in state.items() if key not in ('run_id','timings','window')},expected)
        def unconfigured():raise ProviderNotConfigured()
        brain=self.brain(self.replying(),credentials=unconfigured);body=turn_body(70);brain.start(body)
        self.assertEqual({key:value for key,value in self.wait(brain,body).items() if key!='run_id'},{'state':'failed','error_code':'provider_not_configured'})
        silent=self.brain(self.replying(),resolve=lambda payload,chat:None);body=turn_body(71);silent.start(body)
        self.assertEqual({key:value for key,value in self.wait(silent,body).items() if key!='run_id'},{'state':'suppressed'})
        forged=turn_body(72,secret='another-synthetic-secret-123456');brain.start(forged);state=self.wait(brain,forged)
        self.assertEqual((state['state'],state.get('error_code')),('ambiguous','runtime_execution_interrupted'),'a refused pass never reaches the turn')
        self.assertFalse((self.folder/(state['run_id']+'.outcome')).exists())
        self.assertEqual(self.calls,[])
        self.content_free('private',kept=('.request',))

    def test_the_real_native_turn_returns_its_reply(self):
        from .assistant_gateway import native_turn
        child={'state':'done','text':f'Synthetic native answer 【nocheh:event:{CITED}】','session_id':'nocheh-native-session','timings':{'total':{'ms':9,'calls':1}}}
        def prepare(root,scope,model):
            profile=Path(root)/'profiles'/scope.profile;profile.mkdir(parents=True,exist_ok=True)
            return profile
        with patch('services.hermes.assistant_gateway.prepare_profile',side_effect=prepare),\
             patch('services.hermes.turn_process._run_process',new_callable=AsyncMock,return_value=child) as run,\
             patch('services.hermes.assistant_gateway.check_delivery_policy',return_value=True),\
             patch('services.hermes.assistant_gateway.title_session') as title:
            brain=self.brain(native_turn);body=turn_body(41);brain.start(body);state=self.wait(brain,body)
        self.assertEqual(state['reply'],{'text':'Synthetic native answer','session_id':'nocheh-native-session'})
        self.assertEqual(state['timings'],{'total':{'ms':9,'calls':1}})
        logical=digest('-20:main');profile=self.root/'profiles'/Scopes.profile('-20')
        self.assertEqual(run.await_args.args[5],'nocheh-'+logical)
        self.assertEqual(json.loads((profile/('active-'+logical+'.json')).read_text()),{'session_id':'nocheh-native-session'})
        title.assert_called_once()

    def test_turns_run_with_telegram_unavailable(self):
        # A first turn loads what the loop imports lazily, so only the blocked turn runs under the patch.
        brain=self.brain(self.replying());body=turn_body(40);brain.start(body);self.wait(brain,body)
        with patch.dict(sys.modules,{'telegram':None,'telegram.ext':None}):
            body=turn_body(41);brain.start(body)
            self.assertEqual(self.wait(brain,body)['reply']['text'],'Synthetic answer')
        code=('import sys;sys.modules["telegram"]=None;sys.modules["telegram.ext"]=None\n'
              'import services.hermes.brain_turns,services.hermes.runtime\n'
              'assert not [name for name,module in sys.modules.items() if module is not None and name.split(".")[0]=="telegram"]')
        environment={**os.environ,'PYTHONPATH':os.pathsep.join([str(REPO),os.environ.get('PYTHONPATH','')]),'HERMES_HOME':str(self.root/'home')}
        done=subprocess.run([sys.executable,'-c',code],cwd=REPO,env=environment,capture_output=True,text=True,timeout=120)
        self.assertEqual(done.returncode,0,done.stderr[-2000:])

    def test_runtime_routes_reach_the_brain(self):
        from . import runtime
        handler=object.__new__(runtime.Handler);body=turn_body(41)
        with patch.object(runtime,'BRAIN',None):
            handler.path='/internal/turn/start'
            with self.assertRaisesRegex(RuntimeError,'brain_not_started'):handler.dispatch(body)
        brain=self.brain(self.replying())
        with patch.object(runtime,'BRAIN',brain),patch.object(runtime,'MANAGED',None):
            handler.path='/internal/turn/start';self.assertIn(handler.dispatch(body)['state'],('queued','running','done'))
            handler.path='/internal/turn/resume'
            for _ in range(500):
                state=handler.dispatch(observe(body))
                if state['state'] in CLOSED:break
                time.sleep(.01)
            self.assertEqual(state['reply']['text'],'Synthetic answer')
            handler.path='/internal/turn/events'
            self.assertEqual(handler.dispatch({**observe(body),'after':2})['events'][-1]['state'],'done')
            handler.path='/internal/turn/cancel';self.assertEqual(handler.dispatch(observe(body)),state)
            # A Telegram turn has only the turn routes; the run routes refuse it, with or without a channel.
            for route in ('start','resume','events','cancel'):
                handler.path='/internal/run/'+route
                for value in (body,{key:item for key,item in body.items() if key!='channel'}):
                    with self.assertRaisesRegex(ValueError,'runtime_channel_unavailable'):handler.dispatch(value)

    def test_the_service_answers_turn_routes_and_reports_active_turns(self):
        from . import runtime
        server=ThreadingHTTPServer(('127.0.0.1',0),runtime.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def call(route,body=None):
            request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+route,data=None if body is None else canonical(body),
                                           headers={'Authorization':'Bearer '+runtime.TOKEN})
            try:
                with urllib.request.urlopen(request,timeout=5) as response:return response.status,json.load(response)
            except urllib.error.HTTPError as error:
                with error:return error.code,json.load(error)
        try:
            with patch.object(runtime,'BRAIN',None):
                self.assertEqual(call('/internal/turn/start',turn_body(41))[0],503)
                self.assertEqual(call('/health')[1]['brain_turns'],0)
            with patch.object(runtime,'BRAIN',self.brain(self.replying())):
                self.assertEqual(call('/internal/turn/start',turn_body(41,control_reply='Fixed reply')),(400,{'error':'invalid_request'}))
                status,state=call('/internal/turn/start',turn_body(41));self.assertEqual(status,200)
                self.assertIn(state['state'],('queued','running','done'))
                health=call('/health')[1]
                self.assertIn('brain_turns',health)
                # Telegram's health is the bot's own; Hermes reports none.
                self.assertFalse({'telegram','telegram_details'}&set(health))
                # Nothing that reached Telegram is left: these are unknown routes.
                for route in ('/internal/dispatch','/internal/action','/internal/file','/internal/telegram/approval','/internal/telegram/refusal',
                              '/internal/telegram/notice','/internal/telegram/chat'):
                    self.assertEqual(call(route,{'chat_id':'-20'}),(400,{'error':'invalid_request'}),route)
                self.assertEqual(call('/internal/run/start',turn_body(42)),(400,{'error':'invalid_request'}))
        finally:server.shutdown();server.server_close();thread.join()

    def test_journal_retention_prunes_finished_brain_turns(self):
        from .journal_retention import DAY,prune
        def write(name,value,age):
            path=self.folder/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(value)
            stamp=time.time()-age*DAY;os.utime(path,(stamp,stamp))
        for stem,age,closed in (('old',40,True),('recent',5,True),('live',40,False)):
            for suffix in ('.request','.events','.started','.outcome'):write(stem+suffix,b'{}',age)
            if closed:write(stem+'.result',canonical({'state':'done'}),age)
        self.assertEqual(prune(self.root/'spool',self.root/'managed',30),1)
        self.assertEqual(sorted(path.name for path in self.folder.iterdir()),sorted(
            [stem+suffix for stem in ('recent','live') for suffix in ('.request','.events','.started','.outcome')]+['recent.result']))


if __name__=='__main__':unittest.main()
