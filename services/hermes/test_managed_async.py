import asyncio,base64,hashlib,hmac,json,tempfile,threading,time,unittest
from pathlib import Path
from types import SimpleNamespace
from .managed_async import ManagedAsync
from .async_runs import identity
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
