"""Asynchronous runtime receipts; protected requests never enter workflow history."""
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from .capture import canonical,immutable_file

CLOSED={'done','failed','ambiguous','suppressed','cancelled'}
STAGES={'admission','assistant','delivery'}
CODES={'model_unavailable','assistant_runtime_unavailable','runtime_restart_during_dispatch','unsupported_message',
       'delivery_unconfirmed','dispatch_interrupted','space_policy_changed','runtime_execution_interrupted','intentional_silence'}


def identity(body):
    channel=body.get('channel','telegram');event=body.get('event_id');attempt=body.get('attempt')
    if channel not in ('telegram','browser','scheduler') or not isinstance(event,str) or not re.fullmatch('[a-f0-9]{64}',event):raise ValueError('invalid_run_identity')
    if isinstance(attempt,bool) or not isinstance(attempt,(int,str)) or (isinstance(attempt,int) and attempt<1) or not re.fullmatch('[a-zA-Z0-9_-]{1,100}',str(attempt)):raise ValueError('invalid_run_attempt')
    return hashlib.sha256(canonical([channel,event,attempt])).hexdigest()


class AsyncRuns:
    def __init__(self,directory,execute,reconcile):
        self.directory=Path(directory);self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.execute,self.reconcile=execute,reconcile
        self.lock=threading.RLock();self.active={}

    def _path(self,run,suffix):return self.directory/(run+suffix)

    def _observe(self,run,state,stage):
        path=self._path(run,'.events')
        previous=path.read_bytes().splitlines() if path.exists() else []
        value={'sequence':len(previous)+1,'state':state,'stage':stage,'at':int(time.time()*1000)}
        with path.open('ab') as file:
            path.chmod(0o600);file.write(canonical(value)+b'\n');file.flush();os.fsync(file.fileno())

    def _finish(self,run,result):
        state=result.get('state')
        if state not in CLOSED:state='ambiguous'
        receipt={'state':state}
        if result.get('error_code') in CODES:receipt['error_code']=result['error_code']
        immutable_file(self.directory,run+'.result',canonical(receipt))
        self._observe(run,state,'delivery' if state=='done' else 'assistant')

    def _snapshot(self,run,body):
        receipt=self._path(run,'.result')
        if receipt.exists():return {'run_id':run,**json.loads(receipt.read_bytes())}
        if run not in self.active and self._path(run,'.started').exists():
            result=self.reconcile(body)
            self._finish(run,result if result and result.get('state') in CLOSED else {'state':'ambiguous','error_code':'runtime_execution_interrupted'})
            return {'run_id':run,**json.loads(receipt.read_bytes())}
        events=self._path(run,'.events')
        last=json.loads(events.read_bytes().splitlines()[-1]) if events.exists() else {'stage':'admission'}
        return {'run_id':run,'state':'running' if run in self.active else 'queued','stage':last['stage']}

    def _launch(self,run,body):
        if run in self.active or self._path(run,'.result').exists():return
        cancelled=threading.Event();self.active[run]=cancelled
        def progress(stage):
            if stage not in STAGES:raise ValueError('invalid_run_stage')
            with self.lock:self._observe(run,'running',stage)
        def work():
            try:
                with self.lock:
                    if self._path(run,'.result').exists():return
                    immutable_file(self.directory,run+'.started',canonical({'run_id':run}))
                result=self.execute(body,progress,cancelled)
            except Exception:
                try:result=self.reconcile(body)
                except Exception:result=None
                result=result or {'state':'ambiguous','error_code':'runtime_execution_interrupted'}
            finally:
                with self.lock:
                    if not self._path(run,'.result').exists():self._finish(run,locals().get('result',{'state':'ambiguous'}))
                    self.active.pop(run,None)
        threading.Thread(target=work,name='nocheh-runtime-'+run[:12],daemon=True).start()

    def start(self,body):
        run=identity(body)
        with self.lock:
            path=self._path(run,'.request')
            if path.exists():
                previous=json.loads(path.read_bytes())
                # Credentials can expire between delivery attempts. They are not
                # execution identity, but every domain handler rechecks them.
                omit=lambda value:{k:v for k,v in value.items() if k not in ('archive_credential','asynchronous')}
                if canonical(omit(previous))!=canonical(omit(body)):raise ValueError('run_identity_conflict')
            else:
                immutable_file(self.directory,run+'.request',canonical(body));self._observe(run,'queued','admission')
            state=self._snapshot(run,body)
            if state['state']=='queued':self._launch(run,body)
            return self._snapshot(run,body)

    def resume(self,body):
        run=identity(body)
        with self.lock:
            path=self._path(run,'.request')
            if not path.exists():return {'run_id':run,'state':'not_found'}
            request=json.loads(path.read_bytes())
            state=self._snapshot(run,request)
            if state['state']=='queued' and body.get('observe_only') is not True:
                if 'archive_credential' in body:request['archive_credential']=body['archive_credential']
                self._launch(run,request)
            return self._snapshot(run,request)

    def events(self,body):
        run=identity(body);after=body.get('after',0)
        if not isinstance(after,int) or after<0:raise ValueError('invalid_run_cursor')
        with self.lock:
            path=self._path(run,'.events')
            events=[json.loads(line) for line in path.read_bytes().splitlines()] if path.exists() else []
            return {'run_id':run,'events':[e for e in events if e['sequence']>after][-100:]}

    def cancel(self,body):
        run=identity(body)
        with self.lock:
            path=self._path(run,'.request')
            if not path.exists():return {'run_id':run,'state':'not_found'}
            request=json.loads(path.read_bytes());state=self._snapshot(run,request)
            if state['state'] in CLOSED:return state
            if run in self.active:self.active[run].set();return {**state,'cancel_requested':True}
            self._finish(run,{'state':'cancelled'});return {'run_id':run,'state':'cancelled'}
