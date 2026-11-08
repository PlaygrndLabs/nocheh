"""Durable native browser runs; only their metadata crosses the workflow boundary."""
import asyncio
import json
import os
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request,urlopen
from .async_runs import AsyncRuns,identity,CLOSED
from .capture import canonical,immutable_file
from .job_progress import merge
from .scopes import Scope,verify_capability
from .usage import _count

# A run's heartbeat every HEARTBEAT_SECONDS, each waiting at most HEARTBEAT_TIMEOUT. A background job run outlasts
# TOLERANCE_SECONDS without an answer from storage (an app restart, a guard publication), and no more.
HEARTBEAT_SECONDS,TOLERANCE_SECONDS,HEARTBEAT_TIMEOUT=5,45,10


class ServiceError(RuntimeError):
    """A failed storage call: its HTTP status and error code when storage answered, else None. The message stays opaque."""
    def __init__(self,status=None,code=None):super().__init__('managed_service_unavailable');self.status,self.code=status,code


def tolerated(error):
    """A heartbeat failure a background run outlasts for TOLERANCE_SECONDS: no answer, a server error, or a guard publication in progress."""
    return isinstance(error,ServiceError) and (error.status is None or error.status>=500 or error.status==409 and error.code=='guard_transition_pending')


class Relay:
    """The newest progress of a background run: what its heartbeat carries and its receipt keeps.
    Counts only grow; the to-do list is the newest one. A heartbeat carries what changed since the last one storage took."""
    ZERO={'input_tokens':0,'output_tokens':0,'cache_read_tokens':0,'cache_write_tokens':0,'calls':0}

    def __init__(self):
        self.lock=threading.Lock();self.tokens=None;self.unknown_calls=0;self.todo=None;self.sent=None;self.sent_todo=None

    def update(self,value):
        with self.lock:
            self.tokens=merge(self.tokens,value['tokens']);self.unknown_calls=max(self.unknown_calls,value['unknown_calls'])
            if 'todo' in value:self.todo=value['todo']

    def pending(self):
        with self.lock:
            counts=(self.tokens or self.ZERO,self.unknown_calls);todo=self.todo is not None and self.todo!=self.sent_todo
            if not todo and (counts==self.sent or self.tokens is None and not self.unknown_calls):return {}
            return {'progress':{'tokens':dict(counts[0]),'unknown_calls':counts[1],**({'todo':self.todo} if todo else {})}}

    def delivered(self,sent):
        with self.lock:
            if 'progress' in sent:
                progress=sent['progress'];self.sent=(progress['tokens'],progress['unknown_calls'])
                if 'todo' in progress:self.sent_todo=progress['todo']


class ManagedAsync:
    def __init__(self,admin,credentials,call=None,runner=None,scheduler=None,background_call=None):
        self.admin,self.credentials=admin,credentials
        self.root=Path(admin.root);self.directory=self.root/'nocheh-managed-runs'
        self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.call=call or self.http
        # Background job runs have their own routes in storage.
        self.background_call=background_call or (lambda route,body:self.http(route,body,'background'))
        self.scheduler=scheduler
        if runner is None:
            from .turn_process import run_process
            runner=run_process
        self.runner=runner;self.journal_lock=threading.RLock();self.sequences={}
        self.runs=AsyncRuns(self.directory,self.execute,self.reconcile)

    def http(self,route,body,family='browser'):
        request=Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/v1/'+family+'/'+route,
            data=canonical(body),headers={'Authorization':'Bearer '+self.admin.token,'Content-Type':'application/json'})
        timeout=230 if route=='prepare' else HEARTBEAT_TIMEOUT if family=='background' and route=='heartbeat' else 15
        try:
            with urlopen(request,timeout=timeout) as response:return json.load(response)
        except HTTPError as error:
            # Storage's answer decides whether a background run's heartbeat may try again.
            try:code=json.loads(error.read(4096)).get('error')
            except Exception:code=None
            finally:error.close()
            raise ServiceError(error.code,code if isinstance(code,str) else None) from None
        except Exception:raise ServiceError() from None

    def path(self,body,suffix):return self.directory/(identity(body)+suffix)

    def rpc(self,body,route,payload):
        if body.get('channel')=='scheduler':return self.scheduler.call(route,payload)
        return self.background_call(route,payload) if body.get('channel')=='background' else self.call(route,payload)

    def start(self,body):
        if body.get('channel')=='scheduler' and not self.path(body,'.request').exists():
            ready=self.scheduler.context(body)
            if ready['state']!='ready':return {'run_id':identity(body),'state':ready['state']}
        return self.runs.start(body)

    def publish(self,body,receipt):
        if body.get('channel')=='scheduler':
            details=receipt['_schedule'];finish={key:value for key,value in receipt.items() if key!='_schedule'}
            result=self.scheduler.publish({**details,'finish':finish})
        else:result=self.rpc(body,'finish',receipt)
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
        if channel not in ('browser','scheduler','background'):raise ValueError('runtime_channel_unavailable')
        if cancelled.is_set():return {'state':'cancelled'}
        if channel=='scheduler':
            ready=self.scheduler.context(body,claim=True)
            if ready['state']!='ready':return {'state':'cancelled' if ready['state']=='cancelled' else 'ambiguous'}
            context,scope,claim=ready['context'],ready['scope'],ready['claim']
        else:
            context=self.rpc(body,'workflow-context',body)
            if context.get('storage_layout')=='original-only-v1':
                # The authenticated control service supplies the admitted logical
                # profile. Native storage identity comes only from its signed
                # capability, never from a caller's filesystem/profile lookup.
                policy=self.admin.policy;chat=context['scope'];space=context['space'];name=context['profile']
                if not policy.owner or chat!=policy.owner and chat not in policy.groups or space.split('/topic/')[0]!=chat:
                    raise ValueError('profile_scope_denied')
                scope=Scope(chat,policy.owner,chat==policy.owner,name,space,context['revision'],logical_profile=name)
            else:
                name,_=self.admin.profile(context['profile']);scope=self.admin.binding(name)
            if scope.chat_id!=context['scope']:raise ValueError('profile_scope_denied')
            claim=self.rpc(body,'claim',context)
        immutable_file(self.directory,identity(body)+'.context',canonical(context))
        if not claim.get('claimed'):
            return {'state':claim['state'] if claim['state'] in CLOSED else 'ambiguous'}
        claims=verify_capability(claim['archive_credential'],self.admin.token,scope,context['event_id'])
        if not scope.owner and claims.get('revision')!=scope.revision:raise ValueError('browser_audience_changed')
        stopped=threading.Event();lost=threading.Event()
        # A background run's progress lines reach its heartbeat and receipt through the relay.
        relay=Relay() if channel=='background' else None
        def heartbeat():
            last=time.monotonic()
            while not stopped.wait(HEARTBEAT_SECONDS):
                sent=relay.pending() if relay else {}
                try:status=self.rpc(body,'heartbeat',{**context,**sent})
                except Exception as error:
                    # A background run keeps going through a short outage; any refusal from storage stops it at once.
                    if relay and tolerated(error) and time.monotonic()-last<TOLERANCE_SECONDS:continue
                    lost.set();cancelled.set();return
                last=time.monotonic()
                if relay:relay.delivered(sent)
                if status.get('cancel_requested'):cancelled.set()
        monitor=threading.Thread(target=heartbeat,daemon=True);monitor.start()
        result={'state':'failed','text':'','session_id':context['conversation'],'error_code':'managed_execution_failed'}
        try:
            prepared=self.rpc(body,'prepare',context)
            if cancelled.is_set():result['state']='cancelled'
            else:
                progress('assistant')
                native={**claim,**prepared,'channel':channel}
                if channel=='scheduler':native.update(job_id=context['job_id'],job_preferences=context['definition'].get('preferences',{}))
                if channel=='background':native.update(background=context['background'])
                result=asyncio.run(self.runner(self.root,scope,native,self.admin.model,
                    self.credentials(),context['conversation'],emit=(lambda text:self.emit(body,text)) if channel=='browser' else None,cancelled=cancelled,
                    **({'progress':relay.update} if relay else {})))
        except Exception:
            # An exception after claim cannot establish absence of a tool effect.
            result.update(state='interrupted',error_code='runtime_execution_interrupted')
        finally:
            stopped.set();monitor.join(timeout=16)
        state='interrupted' if lost.is_set() else 'cancelled' if cancelled.is_set() else result['state']
        receipt={'event_id':context['event_id'],'actor':context['actor'],'state':state,'text':result.get('text',''),
            'session':result.get('session_id',context['conversation']),'error_code':result.get('error_code')}
        if channel=='background':
            # The run's final counts, the larger of its last progress and Hermes's own, which Nocheh prices, and its last to-do list.
            # Hermes's calls include those without usage, which the relay already prices as unknown calls: not twice.
            own=result.get('tokens') if isinstance(result.get('tokens'),dict) else None
            if own is not None:own={**own,'calls':max(0,_count(own.get('calls'))-relay.unknown_calls)}
            receipt.update(tokens=merge(relay.tokens,own),unknown_calls=relay.unknown_calls)
            if relay.todo is not None:receipt['todo']=relay.todo
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
