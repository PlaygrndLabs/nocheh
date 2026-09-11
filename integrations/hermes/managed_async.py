"""Durable native browser runs; only their metadata crosses the workflow boundary."""
import asyncio
import json
import os
import threading
import time
from pathlib import Path
from urllib.request import Request,urlopen
from .async_runs import AsyncRuns,identity,CLOSED
from .capture import canonical,immutable_file
from .scopes import verify_capability


class ManagedAsync:
    def __init__(self,admin,credentials,call=None,runner=None,scheduler=None):
        self.admin,self.credentials=admin,credentials
        self.root=Path(admin.root);self.directory=self.root/'nocheh-managed-runs'
        self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.call=call or self.http
        self.scheduler=scheduler
        if runner is None:
            from .turn_process import run_process
            runner=run_process
        self.runner=runner;self.journal_lock=threading.RLock();self.sequences={}
        self.runs=AsyncRuns(self.directory,self.execute,self.reconcile)

    def http(self,route,body):
        request=Request(os.environ.get('ARCHIVE_URL','http://archive:8780')+'/v1/browser/'+route,
            data=canonical(body),headers={'Authorization':'Bearer '+self.admin.token,'Content-Type':'application/json'})
        try:
            with urlopen(request,timeout=230 if route=='prepare' else 15) as response:return json.load(response)
        except Exception:raise RuntimeError('managed_service_unavailable') from None

    def path(self,body,suffix):return self.directory/(identity(body)+suffix)

    def rpc(self,body,route,payload):
        return self.scheduler.call(route,payload) if body.get('channel')=='scheduler' else self.call(route,payload)

    def start(self,body):
        if body.get('channel')=='scheduler' and not self.path(body,'.request').exists():
            ready=self.scheduler.context(body)
            if ready['state']!='ready':return {'run_id':identity(body),'state':ready['state']}
        return self.runs.start(body)

    def publish(self,body,receipt):
        if body.get('channel')=='scheduler':
            details=receipt['_schedule'];finish={key:value for key,value in receipt.items() if key!='_schedule'}
            result=self.scheduler.publish({**details,'finish':finish})
        else:result=self.call('finish',receipt)
        immutable_file(self.directory,identity(body)+'.published',b'{}')
        return result

    def flush(self):
        for path in self.directory.glob('*.receipt'):
            run=path.stem
            if (self.directory/(run+'.published')).exists():continue
            request=self.directory/(run+'.request')
            if not request.exists():continue
            self.publish(json.loads(request.read_bytes()),json.loads(path.read_bytes()))

    def emit(self,body,text):
        if not isinstance(text,str):raise ValueError('invalid_stream_event')
        run=identity(body);path=self.path(body,'.stream')
        with self.journal_lock:
            sequence=self.sequences.get(run,0)+1
            data=canonical({'sequence':sequence,'text':text})+b'\n'
            if (path.stat().st_size if path.exists() else 0)+len(data)>8*1024*1024:raise ValueError('stream_limit')
            with path.open('ab') as file:
                path.chmod(0o600);file.write(data);file.flush();os.fsync(file.fileno())
            self.sequences[run]=sequence

    def events(self,body):
        # The authenticated browser bridge also proves the current scoped archive
        # audience before any protected output can leave the journal.
        status=self.call('observe',body)
        after=body.get('after',0)
        if type(after) is not int or after<0:raise ValueError('invalid_run_cursor')
        path=self.path({'channel':'browser','event_id':body['event_id'],'attempt':1},'.stream')
        with self.journal_lock:
            rows=[json.loads(line) for line in path.read_bytes().splitlines()] if status.get('visible') and path.exists() else []
        return {**status,'events':[row for row in rows if row['sequence']>after][:100]}

    def reconcile(self,body):
        receipt=self.path(body,'.receipt')
        if receipt.exists():
            result=self.publish(body,json.loads(receipt.read_bytes()))
            return {'state':'ambiguous' if result['state']=='interrupted' else result['state']}
        context=self.path(body,'.context')
        if context.exists():
            status=self.rpc(body,'observe',json.loads(context.read_bytes()))
            if status['state'] in ('done','failed','cancelled'):return {'state':status['state']}
        return {'state':'ambiguous','error_code':'runtime_execution_interrupted'}

    def execute(self,body,progress,cancelled):
        channel=body.get('channel')
        if channel not in ('browser','scheduler'):raise ValueError('runtime_channel_unavailable')
        if cancelled.is_set():return {'state':'cancelled'}
        if channel=='scheduler':
            ready=self.scheduler.context(body,claim=True)
            if ready['state']!='ready':return {'state':'cancelled' if ready['state']=='cancelled' else 'ambiguous'}
            context,scope,claim=ready['context'],ready['scope'],ready['claim']
        else:
            context=self.call('workflow-context',body)
            name,_=self.admin.profile(context['profile']);scope=self.admin.binding(name)
            if scope.chat_id!=context['scope']:raise ValueError('profile_scope_denied')
            claim=self.call('claim',context)
        immutable_file(self.directory,identity(body)+'.context',canonical(context))
        if not claim.get('claimed'):
            return {'state':claim['state'] if claim['state'] in CLOSED else 'ambiguous'}
        claims=verify_capability(claim['archive_credential'],self.admin.token,scope,context['event_id'])
        if not scope.owner and claims.get('revision')!=scope.revision:raise ValueError('browser_audience_changed')
        stopped=threading.Event();lost=threading.Event()
        def heartbeat():
            while not stopped.wait(5):
                try:
                    status=self.rpc(body,'heartbeat',context)
                    if status.get('cancel_requested'):cancelled.set()
                except Exception:lost.set();cancelled.set();return
        monitor=threading.Thread(target=heartbeat,daemon=True);monitor.start()
        result={'state':'failed','text':'','session_id':context['conversation'],'error_code':'managed_execution_failed'}
        try:
            prepared=self.rpc(body,'prepare',context)
            if cancelled.is_set():result['state']='cancelled'
            else:
                progress('assistant')
                native={**claim,**prepared,'channel':channel}
                if channel=='scheduler':native.update(job_id=context['job_id'],job_preferences=context['definition'].get('preferences',{}))
                result=asyncio.run(self.runner(self.root,scope,native,self.admin.model,
                    self.credentials(),context['conversation'],emit=(lambda text:self.emit(body,text)) if channel=='browser' else None,cancelled=cancelled))
        except Exception:
            # An exception after claim cannot establish absence of a tool effect.
            result.update(state='interrupted',error_code='runtime_execution_interrupted')
        finally:
            stopped.set();monitor.join(timeout=16)
        state='interrupted' if lost.is_set() else 'cancelled' if cancelled.is_set() else result['state']
        receipt={'event_id':context['event_id'],'actor':context['actor'],'state':state,'text':result.get('text',''),
            'session':result.get('session_id',context['conversation']),'error_code':result.get('error_code')}
        if channel=='scheduler':
            from .scheduler import now
            receipt['_schedule']={'logical_profile':context['logical_profile'],'job_id':context['job_id'],'scope':context['scope'],
                'deliver':context['definition'].get('deliver','local'),'at':now().isoformat()}
        immutable_file(self.directory,identity(body)+'.receipt',canonical(receipt))
        outcome=self.publish(body,receipt)
        return {'state':'ambiguous' if outcome['state']=='interrupted' else outcome['state']}

    def stop(self):
        with self.runs.lock:
            for cancelled in self.runs.active.values():cancelled.set()
        deadline=time.monotonic()+30
        while self.runs.active and time.monotonic()<deadline:time.sleep(.1)
