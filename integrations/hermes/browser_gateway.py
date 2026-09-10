"""Native TUI session transport; model turns use Nocheh's common isolated runner."""
import asyncio
import base64
import contextlib
import io
import json
import hashlib
import logging
import os
import re
import sys
import threading
import uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from .scopes import Scope
from .capture import canonical, immutable_file


class BrowserGateway:
    def __init__(self, server, root, scope, model, call=None, runner=None):
        self.server, self.root, self.scope, self.model = server, Path(root), scope, model
        self.home = self.root / 'profiles' / scope.profile
        self.actor = uuid.uuid4().hex
        self.call = call or self.http
        if runner is None:
            from .turn_process import run_process
            runner = run_process
        self.runner = runner
        self.lock = threading.Lock(); self.running = {}; self.inputs = {}
        self.original = dict(server._methods)

    def http(self, route, body):
        base = os.environ.get('ARCHIVE_URL','http://archive:8780') if route.startswith('/v1/') else 'http://127.0.0.1:8781'
        request = Request(base + route, data=canonical(body), headers={
            'Authorization':'Bearer ' + os.environ['SERVICE_TOKEN'], 'Content-Type':'application/json'})
        try:
            with urlopen(request, timeout=230 if route.endswith('/prepare') else 15) as response: return json.load(response)
        except HTTPError as error:
            try: code=json.load(error).get('error')
            except Exception: code=None
            allowed={'quota_paused','subscription_unavailable','transcription_unavailable','run_lease_lost','browser_audience_changed','profile_policy_changed'}
            raise RuntimeError(code if code in allowed else 'managed_service_unavailable') from None
        except Exception: raise RuntimeError('managed_service_unavailable') from None

    def session(self, params):
        sid = params.get('session_id')
        session = self.server._sessions.get(sid)
        if not session: raise ValueError('session_not_ready')
        return sid, session

    def capture(self, rid, params):
        sid, session = self.session(params)
        text = params.get('text')
        if not isinstance(text,str) or len(text)>100000: raise ValueError('invalid_text')
        files = list(session.get('_nocheh_attachments',{}).values())
        request = {'scope':self.scope.chat_id, 'profile':self.scope.profile,
                   'space':self.scope.space or self.scope.chat_id,'revision':self.scope.revision,
                   'conversation':session['session_key'], 'id':params['id'], 'text':text, 'files':files,
                   'submission':params.get('submission','composer'), 'display':params.get('display',text)}
        result = self.call('/v1/browser/input',request)
        self.inputs[result['event_id']] = {'sid':sid,'text':text,'files':files}
        if len(self.inputs)>256: self.inputs.pop(next(iter(self.inputs)))
        return self.server._ok(rid,result)

    def attach(self, name, rid, params):
        _, session = self.session(params)
        pending = session.setdefault('_nocheh_attachments',{})
        if name=='image.detach':
            removed=pending.pop(params.get('path',''),None)
            return self.server._ok(rid,{'detached':removed is not None,'count':len(pending)})
        raw=params.get('content_base64') or params.get('data') or params.get('data_url')
        filename=params.get('filename') or params.get('name') or 'attachment.bin'
        if raw:
            if not isinstance(raw,str) or len(raw)>36*1024*1024: raise ValueError('attachment_limit')
            if raw.startswith('data:'):
                header,raw=raw.split(',',1)
                if not header.endswith(';base64'): raise ValueError('invalid_attachment')
            try: data=base64.b64decode(raw,validate=True)
            except Exception: raise ValueError('invalid_attachment') from None
        else:
            path=Path(str(params.get('path',''))).resolve()
            if not any(path.is_relative_to((self.home/sub).resolve()) and (self.home/sub).resolve().is_relative_to(self.home.resolve()) for sub in ('images','attachments','workspace')):
                raise ValueError('attachment_scope_denied')
            if not path.is_file() or path.stat().st_size>25*1024*1024: raise ValueError('attachment_limit')
            data=path.read_bytes();filename=path.name
        if not isinstance(filename,str) or not filename or len(filename)>255 or re.search(r'[\x00-\x1f/\\]',filename): raise ValueError('invalid_attachment')
        if not data or len(data)>25*1024*1024 or len(pending)>=10: raise ValueError('attachment_limit')
        kind='image' if name.startswith('image.') else 'audio' if Path(filename).suffix.lower() in ('.ogg','.oga','.mp3','.wav','.m4a','.flac') else 'file'
        ref='nocheh-upload-'+hashlib.sha256(data).hexdigest()
        pending[ref]={'name':filename,'kind':kind,'bytes_base64':base64.b64encode(data).decode()}
        return self.server._ok(rid,{'attached':True,'path':ref,'name':filename,'count':len(pending),
            'ref_path':ref,'ref_text':'@file:'+ref,'text':'[Attached: '+filename+']','remainder':'','uploaded':True})

    def submit(self, rid, params):
        sid, session = self.session(params)
        event = params.get('nocheh_event_id')
        captured = self.inputs.get(event)
        if not captured or captured['sid']!=sid or params.get('text')!=captured['text']:
            raise ValueError('captured_input_required')
        # Edits/regeneration become new observed submissions. No source rewrite or
        # caller-supplied history can pass through the managed model bootstrap.
        if any(params.get(key) for key in ('messages','truncate_before_row_id','truncate_before_user_ordinal','rewind_confirmed')):
            raise ValueError('history_rewrite_unavailable')
        with self.lock:
            if session.get('running'):
                if session.get('_nocheh_event')==event: return self.server._ok(rid,{'status':'streaming','duplicate':True})
                return self.server._err(rid,4091,'session busy')
            claim = self.call('/v1/browser/claim',{'event_id':event,'actor':self.actor,
                'scope':self.scope.chat_id,'profile':self.scope.profile})
            if not claim.get('claimed'):
                if claim['state']!='running':
                    self.server._emit('message.complete',sid,{'text':claim.get('text') or 'This input already ended with status: '+claim['state'],
                        'usage':{},'status':'complete' if claim['state']=='done' else 'interrupted'})
                return self.server._ok(rid,{'status':claim['state'],'duplicate':True})
            session['running'] = True
            session['_nocheh_event']=event
            session['_nocheh_attachments']={}
            cancel = threading.Event(); self.running[sid] = cancel
        thread = threading.Thread(target=self.execute,args=(sid,session,claim,cancel),daemon=True)
        session['_nocheh_thread'] = thread;thread.start()
        return self.server._ok(rid,{'status':'streaming','event_id':event})

    def finish(self, body):
        directory = self.home / 'nocheh-browser-receipts'
        directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        name = body['event_id'] + '.json'
        immutable_file(directory,name,canonical(body))
        receipt=self.call('/v1/browser/finish',body)
        (directory/name).unlink(missing_ok=True)
        return receipt

    def flush_receipts(self):
        for path in (self.home/'nocheh-browser-receipts').glob('*.json'):
            try:
                body=json.loads(path.read_text())
                if path.name!=body['event_id']+'.json': continue
                self.call('/v1/browser/finish',body);path.unlink()
            except Exception: pass  # Remains durable and retried at startup/next turn.

    def execute(self, sid, session, claim, cancel):
        result = {'state':'failed','text':'','session_id':session['session_key'],'error_code':'managed_execution_failed'}
        stopped=threading.Event();lost=threading.Event()
        def heartbeat():
            while not stopped.wait(10):
                try: self.call('/v1/browser/heartbeat',{'event_id':claim['event_id'],'actor':self.actor})
                except Exception: lost.set();cancel.set();return
        monitor=threading.Thread(target=heartbeat,daemon=True);monitor.start()
        try:
            self.flush_receipts()
            prepared=self.call('/v1/browser/prepare',{'event_id':claim['event_id'],'actor':self.actor})
            if cancel.is_set(): raise RuntimeError('cancelled')
            credentials = self.call('/internal/browser-credentials',{
                'event_id':claim['event_id'], 'archive_credential':claim['archive_credential'],
                'scope':self.scope.chat_id,'profile':self.scope.profile})
            if cancel.is_set(): raise RuntimeError('cancelled')
            body = {**claim,**prepared,'channel':'browser'}
            from .subscription import SubscriptionCredentials
            runtime=SubscriptionCredentials(credentials['api_key'],credentials['base_url'],credentials['provider'],credentials['api_mode'])
            result = asyncio.run(self.runner(self.root,self.scope,body,credentials['model'],
                runtime, session['session_key'],
                emit=lambda text:self.server._emit('message.delta',sid,{'text':text}),cancelled=cancel))
        except Exception as error:
            if str(error) in ('quota_paused','subscription_unavailable','transcription_unavailable','run_lease_lost','profile_busy'):
                result['error_code']=str(error)
        try:
            if cancel.is_set(): result.update(state='cancelled')
            if lost.is_set(): result.update(state='interrupted',error_code='run_lease_lost')
            result.setdefault('session_id',session['session_key'])
            receipt=self.finish({'event_id':claim['event_id'],'actor':self.actor,'state':result['state'],
                'text':result.get('text',''),'session':result['session_id'],
                **({'error_code':result['error_code']} if result.get('error_code') else {})})
            if receipt and receipt.get('state')!='done': result.update(state=receipt['state'])
        except Exception:
            result.update(state='failed',error_code='result_commit_pending')
        finally:
            stopped.set();monitor.join(timeout=16)
            with self.lock:
                session['running'] = False;session['session_key'] = result.get('session_id',session['session_key'])
                self.running.pop(sid,None)
            with contextlib.suppress(Exception):
                from hermes_state import SessionDB
                from .isolated_profile import database_path
                db = SessionDB(database_path(self.home),read_only=True)
                try: session['history'] = db.get_messages_as_conversation(session['session_key'])
                finally: db.close()
            state=result['state'];text=result.get('text','')
            from .assistant_gateway import check_delivery_policy
            if state=='done' and not check_delivery_policy(claim['archive_credential']): state='interrupted'
            if state != 'done': text = 'The managed turn did not complete. Its original input is preserved. See Nocheh status before retrying.'
            self.server._emit('message.complete',sid,{'text':text,'usage':{},
                'status':'complete' if state=='done' else 'interrupted' if state=='cancelled' else 'error'})
            self.server._emit('session.info',sid,self.info(session))

    def info(self, session):
        from .assistant_turn import ALLOWED_TOOLS
        return {'version':'0.21.0','model':self.model,'provider':'openai-codex','tools':{'Nocheh':sorted(ALLOWED_TOOLS)},'skills':{},
                'cwd':str(self.home/'workspace'),'profile_name':self.scope.profile,
                'stored_session_id':session['session_key'],'running':session.get('running',False),
                'lazy':False,'managed_execution':'isolated_per_turn','approval_mode':'manual','yolo':False,'nocheh_scope':'owner-private' if self.scope.owner else 'selected-group'}

    def interrupt(self, rid, params):
        sid, _ = self.session(params)
        if sid in self.running: self.running[sid].set()
        return self.server._ok(rid,{'status':'interrupted'})

    def invoke(self, name, rid, params):
        try:
            if params.get('profile') not in (None,'',self.scope.profile): raise ValueError('profile_scope_denied')
            params = {**params};params.pop('profile',None)
            if name == 'nocheh.input': return self.capture(rid,params)
            if name in ('image.attach','image.attach_bytes','image.detach','file.attach','pdf.attach'): return self.attach(name,rid,params)
            if name == 'prompt.submit': return self.submit(rid,params)
            if name == 'session.interrupt': return self.interrupt(rid,params)
            if name == 'session.info': return self.server._ok(rid,self.info(self.session(params)[1]))
            if name == 'setup.status': return self.server._ok(rid,{'provider_configured':True,'managed_by':'Nocheh'})
            if name in ('wake.start','wake.status'):
                return self.server._ok(rid,{'started':False,'enabled':False,'listening':False,
                    'reason':'disabled','hint':'Use archived audio attachments; local wake-word models are disabled.'})
            if name == 'input.detect_drop': return self.server._ok(rid,{'matched':False})
            if name == 'config.get':
                if re.search(r'api.?key|token|password|credential|secret',str(params.get('key','')),re.I):
                    raise ValueError('credential_read_denied')
                def redact(value):
                    if isinstance(value,dict): return {key:('[managed secret]' if re.search(r'api.?key|token|password|credential|secret',key,re.I) and item else redact(item)) for key,item in value.items()}
                    if isinstance(value,list): return [redact(item) for item in value]
                    return value
                return redact(self.original[name](rid,params))
            if name == 'session.create':
                if params.get('messages') or params.get('parent_session_id'): raise ValueError('seeded_history_unavailable')
                params = {'source':'browser','cwd':str(self.home/'workspace'),'follow_profile_config':True,
                          **({'cols':params['cols']} if 'cols' in params else {})}
            if name == 'session.resume': params.update(lazy=True,cwd=str(self.home/'workspace'))
            if name == 'session.close':
                sid, session = self.session(params)
                if sid in self.running:
                    self.running[sid].set(); session['_nocheh_thread'].join(timeout=5)
                    if session.get('running'): raise ValueError('wait_for_cancellation')
            result=self.original[name](rid,params)
            if name in ('session.create','session.resume') and 'result' in result:
                data=result['result'];session=self.server._sessions.get(data.get('session_id'))
                if session:
                    data['info']={**data.get('info',{}),**self.info(session)}
            return result
        except Exception as error:
            code = str(error) if isinstance(error,ValueError) and re.fullmatch(r'[a-z_]+',str(error)) else 'managed_operation_unavailable'
            if str(error) in ('browser_audience_changed','profile_policy_changed'):code='Audience policy changed. Select the current group profile to start a fresh context. Your input remains archived.'
            return self.server._err(rid,4032,code)

    def install(self):
        allowed = {'session.create','session.resume','session.list','session.most_recent','session.history',
                   'session.active_list','session.info','session.interrupt','session.close',
                   'config.get','setup.status','wake.start','wake.status','commands.catalog','complete.slash','plugins.compat_report','input.detect_drop',
                   'image.attach','image.attach_bytes','image.detach','file.attach','pdf.attach'}
        names = set(self.original) | allowed | {'nocheh.input','prompt.submit','session.info'}
        for name in names:
            if name in allowed or name in ('nocheh.input','prompt.submit'):
                self.server._methods[name] = lambda rid,params,name=name:self.invoke(name,rid,params)
            else:
                self.server._methods[name] = lambda rid,params,name=name:self.server._err(rid,4032,'managed_operation_unavailable: '+name)
        self.server._schedule_agent_build = lambda *_:None
        self.server._start_agent_build = lambda *_:None
        self.server._make_agent = lambda *_args,**_kwargs: (_ for _ in ()).throw(RuntimeError('managed_bootstrap_required'))
        # Native resume must never discover/adopt a sibling profile's session.
        self.server._profile_home = lambda name: None if name in (None,'',self.scope.profile) else (_ for _ in ()).throw(ValueError('profile_scope_denied'))
        self.server._resume_adopt_stranded = lambda *_:None


def main():
    logging.disable(logging.CRITICAL)
    from .isolated_profile import install_database_paths
    install_database_paths()
    root=Path(os.environ['NOCHEH_RUNTIME_HOME']).resolve();home=Path(os.environ['HERMES_HOME']).resolve()
    profile=os.environ['NOCHEH_BROWSER_PROFILE'];chat=os.environ['NOCHEH_BROWSER_SCOPE']
    if home != root/'profiles'/profile: raise SystemExit('managed_profile_mismatch')
    scope=Scope(chat,os.environ['NOCHEH_BROWSER_OWNER_ID'],os.environ['NOCHEH_BROWSER_OWNER']=='1',profile,
                os.environ.get('NOCHEH_BROWSER_SPACE',chat),int(os.environ.get('NOCHEH_BROWSER_REVISION','0')))
    from tui_gateway import server
    gateway=BrowserGateway(server,root,scope,os.environ['NOCHEH_MODEL']);gateway.install();gateway.flush_receipts()
    from .request_boundary import install
    from .compatibility_patch import install as native_gate
    install();native_gate()
    # Neither entry.main's MCP discovery nor native authentication startup runs.
    server.write_json({'jsonrpc':'2.0','method':'event','params':{'type':'gateway.ready',
        'payload':{'skin':server.resolve_skin(),'change_events':False}}})
    try:
        for raw in sys.stdin:
            try:
                if len(raw)>36*1024*1024: raise ValueError()
                response=server.dispatch(json.loads(raw))
                if response is not None: server.write_json(response)
            except Exception: server.write_json({'jsonrpc':'2.0','id':None,'error':{'code':4032,'message':'managed_request_failed'}})
    finally:
        for cancel in list(gateway.running.values()): cancel.set()
        for session in list(server._sessions.values()):
            if thread:=session.get('_nocheh_thread'): thread.join(timeout=5)


if __name__=='__main__': main()
