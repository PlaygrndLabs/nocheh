"""Managed native transport tests, without provider or Telegram traffic."""
import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from .browser_gateway import BrowserGateway
from .scopes import Scope


class BrowserGatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.events=[];self.calls=[];self.failed_route=None;self.finished={};self.run_count=0
        self.server=SimpleNamespace(_methods={'shell.exec':lambda *_:None},_sessions={'sid':{'session_key':'stored-one'}},
            _ok=lambda rid,result:{'id':rid,'result':result},_err=lambda rid,code,message:{'id':rid,'error':{'code':code,'message':message}},
            _emit=lambda kind,sid,payload:self.events.append((kind,sid,payload)))
        self.gateway=BrowserGateway(self.server,self.root,Scope('-10','42',False,'group-one'),'model',self.call,self.runner)
        self.gateway.install()
    def tearDown(self): self.temp.cleanup()
    def call(self,route,body):
        self.calls.append((route,body))
        if route==self.failed_route: raise RuntimeError('outage with secret provider response')
        if route.endswith('/input'): return {'event_id':body['id'],'attachments':body['files']}
        if route.endswith('/admit'):
            self.finished.setdefault(body['event_id'],{'state':'done','text':'answer'})
            return {'owned':True}
        if route=='/internal/browser/events':return {'state':'done','visible':True,'text':'answer','events':[]}
        if route.endswith('/claim'):
            if body['event_id'] in self.finished: return {'claimed':False,**self.finished[body['event_id']]}
            return {'claimed':True,'state':'running','event_id':body['event_id'],'archive_credential':'scoped', 'text':' exact\r\n '}
        if route.endswith('/prepare'): return {'files':[],'transcripts':[]}
        if route.endswith('credentials'): return {'model':'model','api_key':'client-key','base_url':'http://cliproxy-api:8317/v1','provider':'openai','api_mode':'chat_completions'}
        if route.endswith('/finish'): self.finished[body['event_id']]=body
        return {}
    async def runner(self,root,scope,body,model,credentials,session_id,emit,cancelled):
        self.run_count+=1
        self.assertFalse(scope.owner);self.assertEqual(body['archive_credential'],'scoped')
        self.assertEqual(credentials.runtime(),{'api_key':'client-key','base_url':'http://cliproxy-api:8317/v1','provider':'openai','api_mode':'chat_completions'});emit('answer')
        return {'state':'done','text':'answer','session_id':session_id}
    def invoke(self,name,**params): return self.server._methods[name](1,{'session_id':'sid',**params})
    def capture(self): return self.invoke('nocheh.input',id='event-one',text=' exact\r\n ')
    def submit(self):
        result=self.invoke('prompt.submit',text=' exact\r\n ',nocheh_event_id='event-one')
        if thread:=self.server._sessions['sid'].get('_nocheh_thread'): thread.join(10);self.assertFalse(thread.is_alive())
        return result
    def test_control_requests_use_stable_logical_profile(self):
        from dataclasses import replace
        self.gateway.scope=replace(self.gateway.scope,logical_profile='profile-'+'a'*48,
            generation='11111111-1111-4111-8111-111111111111',guard_epoch=2)
        self.assertIn('result',self.capture());self.assertIn('result',self.submit())
        for route,body in self.calls:
            if route.endswith(('/input','/admit')) or route=='/internal/browser/events':
                self.assertEqual(body['profile'],self.gateway.scope.logical_profile)
        self.assertEqual(self.gateway.home,self.root/'profiles/group-one')
    def test_capture_required_scope_and_forbidden_operations(self):
        self.assertIn('error',self.submit());self.assertEqual(self.run_count,0)
        self.assertIn('error',self.invoke('shell.exec',command='echo secret'))
        self.assertIn('error',self.invoke('nocheh.input',id='event-one',text='x',profile='owner'))
        self.failed_route='/v1/browser/input';self.assertIn('error',self.capture());self.assertIn('error',self.submit())
        self.assertNotIn('secret',json.dumps(self.events))
    def test_exact_files_and_one_execution(self):
        workspace=self.gateway.home/'workspace';workspace.mkdir(parents=True)
        path=workspace/'notes.txt';path.write_bytes(b'original\r\n')
        self.assertIn('result',self.invoke('file.attach',path=str(path)))
        path.write_bytes(b'changed after attachment')
        self.capture();captured=self.calls[-1][1]
        self.assertEqual(base64.b64decode(captured['files'][0]['bytes_base64']),b'original\r\n')
        self.assertEqual(captured['text'],' exact\r\n ')
        self.submit();self.submit();self.assertEqual(self.run_count,0)
        self.assertEqual(self.finished['event-one']['text'],'answer')
        self.assertFalse(list((self.gateway.home/'nocheh-browser-receipts').glob('*')))
        outside=self.root/'secret';outside.write_text('secret');(workspace/'link').symlink_to(outside)
        self.assertIn('error',self.invoke('file.attach',path=str(workspace/'link')))
    def test_admission_failure_and_retained_receipt_recovery(self):
        self.capture();self.failed_route='/v1/browser/admit';self.assertIn('error',self.submit());self.assertEqual(self.run_count,0)
        self.assertFalse(any(route.endswith('/claim') for route,_ in self.calls))
        directory=self.gateway.home/'nocheh-browser-receipts';directory.mkdir(parents=True)
        receipt={'event_id':'event-one','actor':'original','state':'done','text':'answer','session':'stored-one'}
        path=directory/'event-one.json';path.write_text(json.dumps(receipt))
        self.failed_route='/v1/browser/finish';self.gateway.flush_receipts();self.assertTrue(path.exists())
        self.failed_route=None;self.gateway.flush_receipts();self.assertFalse(path.exists())
        self.assertEqual(self.finished['event-one'],receipt);self.assertEqual(self.run_count,0)

    def test_duplicate_submit_and_cancel_use_the_same_durable_request(self):
        entered=threading.Event();state=['running'];original=self.call
        def call(route,body):
            if route.endswith('/admit'):return {'owned':True}
            if route=='/internal/browser/events':entered.set();return {'state':state[0],'visible':True,'text':'','events':[]}
            if route.endswith('/cancel'):state[0]='cancelled';return {}
            return original(route,body)
        self.gateway.call=call;self.capture()
        self.assertEqual(self.invoke('prompt.submit',text=' exact\r\n ',nocheh_event_id='event-one')['result']['status'],'streaming')
        self.assertTrue(entered.wait(2))
        duplicate=self.invoke('prompt.submit',text=' exact\r\n ',nocheh_event_id='event-one')
        self.assertTrue(duplicate['result']['duplicate'])
        self.invoke('session.interrupt');self.server._sessions['sid']['_nocheh_thread'].join(5)
        self.assertEqual(state[0],'cancelled');self.assertEqual(self.run_count,0)
    def test_native_boot_never_constructs_agent(self):
        home=self.root/'profiles/group-one';home.mkdir(parents=True)
        env={**os.environ,'NOCHEH_RUNTIME_HOME':str(self.root),'HERMES_HOME':str(home),
             'NOCHEH_BROWSER_PROFILE':'group-one','NOCHEH_BROWSER_SCOPE':'-10','NOCHEH_BROWSER_OWNER':'0',
             'NOCHEH_BROWSER_OWNER_ID':'42','NOCHEH_MODEL':'gpt-5.6-sol','NOCHEH_CAPTURE_ENABLED':'0'}
        requests=[{'jsonrpc':'2.0','id':1,'method':'session.create','params':{}},
                  {'jsonrpc':'2.0','id':2,'method':'shell.exec','params':{'command':'true'}}]
        result=subprocess.run([sys.executable,'-m','integrations.hermes.browser_gateway'],
            input=''.join(json.dumps(x)+'\n' for x in requests),text=True,capture_output=True,env=env,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr[-500:])
        rows=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
        created=next(row for row in rows if row.get('id')==1)
        self.assertIn('session_id',created.get('result',{}),created)
        self.assertEqual(created['result']['info']['managed_execution'],'isolated_per_turn')
        self.assertEqual(set(created['result']['info']['tools']['Nocheh']),{'memory','session_search','nocheh_archive_search','nocheh_archive_read','nocheh_action_request','nocheh_shell','nocheh_browser','nocheh_mcp','nocheh_action_status','nocheh_memory_recall'})
        self.assertIn('error',next(row for row in rows if row.get('id')==2))
        self.assertFalse((home/'auth.json').exists())

    def test_durable_reconnect_follows_existing_stream_without_new_execution(self):
        import time
        original=self.call;state=['running'];read=threading.Event()
        def call(route,body):
            if route.endswith('/admit'):return {'owned':True,'state':'captured'}
            if route.endswith('/active'):return {'active':True,'event_id':'event-one'}
            if route=='/internal/browser/events':
                read.set();return {'state':state[0],'visible':True,'text':'durable answer',
                    'events':[] if body['after'] else [{'sequence':1,'text':'durable delta'}]}
            if route.endswith('/cancel'):state[0]='cancelled';return {'cancel_requested':True}
            return original(route,body)
        self.gateway.call=call;self.capture()
        self.invoke('prompt.submit',text=' exact\r\n ',nocheh_event_id='event-one');self.assertTrue(read.wait(2))
        session=self.server._sessions['sid'];self.gateway.running['sid'].set();session['_nocheh_thread'].join(2)
        self.assertEqual(state[0],'running');self.assertEqual(self.run_count,0)
        self.gateway.original['session.resume']=lambda rid,params:self.server._ok(rid,{'session_id':'sid'})
        self.assertIn('result',self.invoke('session.resume'));self.assertTrue(session['running'])
        state[0]='done';session['_nocheh_thread'].join(2)
        self.assertFalse(session['running']);self.assertEqual(self.run_count,0)
        complete=[payload for kind,_,payload in self.events if kind=='message.complete']
        self.assertEqual(complete[-1]['text'],'durable answer')

    def test_durable_interrupt_cancels_the_archive_request(self):
        original=self.call;state=['running'];entered=threading.Event();cancelled=[]
        def call(route,body):
            if route.endswith('/admit'):return {'owned':True}
            if route=='/internal/browser/events':entered.set();return {'state':state[0],'visible':True,'text':'','events':[]}
            if route.endswith('/cancel'):cancelled.append(body['event_id']);state[0]='cancelled';return {}
            return original(route,body)
        self.gateway.call=call;self.capture();self.invoke('prompt.submit',text=' exact\r\n ',nocheh_event_id='event-one')
        self.assertTrue(entered.wait(2));self.invoke('session.interrupt');self.server._sessions['sid']['_nocheh_thread'].join(2)
        self.assertEqual(cancelled,['event-one']);self.assertEqual(self.run_count,0)

    def test_actual_native_tui_capture_failure_keeps_composer(self):
        import fcntl,select,struct,termios,time
        from .browser_launch import launch
        from .scopes import Scopes
        profile=Scopes.profile('-10');home=self.root/'profiles'/profile
        admin=SimpleNamespace(root=self.root,model='gpt-5.6-sol',
            profile=lambda _: (profile,home),binding=lambda _:Scope('-10','42',False,profile,'-10'),policy=SimpleNamespace(owner='42',groups=['-10']))
        with patch.dict(os.environ,{'SERVICE_TOKEN':'fixture-only','ARCHIVE_URL':'http://127.0.0.1:9','NOCHEH_SECURITY_RUNTIME':'isolated','NOCHEH_MEMORY_CONTEXT':'evidence'}):
            argv,cwd,env=launch(admin,profile=profile)
        self.assertEqual(env['NOCHEH_SECURITY_RUNTIME'],'isolated');self.assertEqual(env['NOCHEH_MEMORY_CONTEXT'],'evidence')
        master,slave=os.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',32,100,0,0))
        process=subprocess.Popen(argv,cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave);output=b'';sent=False;entered=False;sent_at=0;deadline=time.monotonic()+45
        try:
            while time.monotonic()<deadline:
                if select.select([master],[],[],.1)[0]:
                    try: output+=os.read(master,65536)
                    except OSError: break
                if not sent and b'gpt-5.6-sol' in output:
                    os.write(master,b'capture boundary fixture');sent=True;sent_at=time.monotonic()
                if sent and not entered and time.monotonic()-sent_at>.5:
                    os.write(master,b'\r');entered=True
                if b'archivecaptureisunavailable' in __import__('re').sub(rb'\s|\x1b\[[0-?]*[ -/]*[@-~]',b'',output): break
            plain=__import__('re').sub(rb'\x1b\[\d*C',b' ',output)
            plain=__import__('re').sub(rb'\x1b\[[0-?]*[ -/]*[@-~]',b'',plain)
            self.assertIn(b'archive capture is unavailable',plain,plain[-4000:].decode(errors='replace'))
            self.assertNotIn(b'managed_operation_unavailable:',plain,plain[-4000:].decode(errors='replace'))
            if (home/'state.db').exists():
                import sqlite3
                with sqlite3.connect(home/'state.db') as db: self.assertEqual(db.execute('SELECT count(*) FROM messages').fetchone()[0],0)
        finally:
            import signal
            os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=5);os.close(master)


if __name__=='__main__': unittest.main()
