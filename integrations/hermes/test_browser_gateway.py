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
        if route.endswith('/claim'):
            if body['event_id'] in self.finished: return {'claimed':False,**self.finished[body['event_id']]}
            return {'claimed':True,'state':'running','event_id':body['event_id'],'archive_credential':'scoped', 'text':' exact\r\n '}
        if route.endswith('/prepare'): return {'files':[],'transcripts':[]}
        if route.endswith('credentials'): return {'model':'model','api_key':'client-key','base_url':'http://cliproxy:8317/v1','provider':'openai','api_mode':'chat_completions'}
        if route.endswith('/finish'): self.finished[body['event_id']]=body
        return {}
    async def runner(self,root,scope,body,model,credentials,session_id,emit,cancelled):
        self.run_count+=1
        self.assertFalse(scope.owner);self.assertEqual(body['archive_credential'],'scoped')
        self.assertEqual(credentials.runtime(),{'api_key':'client-key','base_url':'http://cliproxy:8317/v1','provider':'openai','api_mode':'chat_completions'});emit('answer')
        return {'state':'done','text':'answer','session_id':session_id}
    def invoke(self,name,**params): return self.server._methods[name](1,{'session_id':'sid',**params})
    def capture(self): return self.invoke('nocheh.input',id='event-one',text=' exact\r\n ')
    def submit(self):
        result=self.invoke('prompt.submit',text=' exact\r\n ',nocheh_event_id='event-one')
        if thread:=self.server._sessions['sid'].get('_nocheh_thread'): thread.join(10);self.assertFalse(thread.is_alive())
        return result
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
        self.submit();self.submit();self.assertEqual(self.run_count,1)
        self.assertEqual(self.finished['event-one']['text'],'answer')
        self.assertFalse(list((self.gateway.home/'nocheh-browser-receipts').glob('*')))
        outside=self.root/'secret';outside.write_text('secret');(workspace/'link').symlink_to(outside)
        self.assertIn('error',self.invoke('file.attach',path=str(workspace/'link')))
    def test_credentials_failure_and_receipt_recovery(self):
        self.capture();self.failed_route='/internal/browser-credentials';self.submit();self.assertEqual(self.run_count,0)
        self.assertEqual(self.finished['event-one']['state'],'failed')
        self.finished.clear();self.failed_route='/v1/browser/finish';self.submit()
        paths=list((self.gateway.home/'nocheh-browser-receipts').glob('*.json'));self.assertEqual(len(paths),1)
        self.failed_route=None;self.gateway.flush_receipts();self.assertFalse(paths[0].exists())
        self.assertEqual(self.finished['event-one']['state'],'done')
    def test_cancel_stops_runner_and_reconnect_does_not_repeat(self):
        entered=threading.Event()
        async def slow(*args,emit,cancelled):
            self.run_count+=1;entered.set()
            while not cancelled.is_set(): await asyncio.sleep(.01)
            return {'state':'cancelled','text':'','session_id':'stored-one'}
        self.gateway.runner=slow;self.capture()
        result=self.invoke('prompt.submit',text=' exact\r\n ',nocheh_event_id='event-one')
        self.assertEqual(result['result']['status'],'streaming');self.assertTrue(entered.wait(2))
        duplicate=self.invoke('prompt.submit',text=' exact\r\n ',nocheh_event_id='event-one')
        self.assertTrue(duplicate['result']['duplicate'])
        self.invoke('session.interrupt');self.server._sessions['sid']['_nocheh_thread'].join(5)
        self.assertEqual(self.finished['event-one']['state'],'cancelled');self.assertEqual(self.run_count,1)
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
        os.close(slave);output=b'';sent=False;entered=False;sent_at=0;deadline=time.monotonic()+20
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
