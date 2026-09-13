"""Single local supervisor for approved operations; receipts survive archive outages."""
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from .archive import API
from .configuration import ROOT
from .tool_execution import bounded_execute


def permitted_execute(state,action):
    from .native import call
    from urllib.parse import urlencode
    try:current=call(state,'/api/nocheh/preferences?'+urlencode({'profile':action['profile']}))
    except Exception:return {'exit_code':1,'error':'tool_policy_unavailable'}
    if current['values'].get('nocheh_tools.'+action['kind'])!='on':return {'exit_code':1,'error':'tool_disabled_by_owner'}
    return bounded_execute(state,action)


def atomic(path,value):
    temporary=path.with_suffix('.tmp')
    with temporary.open('w') as file:
        temporary.chmod(0o600);json.dump(value,file);file.flush();os.fsync(file.fileno())
    temporary.replace(path)
    fd=os.open(path.parent,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)


def flush_receipts(state,api,admit=None):
    receipts=Path(state)/'admin/tools/receipts';receipts.mkdir(parents=True,exist_ok=True,mode=0o700)
    completed=0
    for path in sorted(receipts.glob('*.json')):
        if admit is not None and not admit():break
        if path.is_symlink():raise ValueError('tool_receipt_path_denied')
        body=json.loads(path.read_text());api.call('/v1/tools/finish',body);path.unlink();completed+=1
    return completed


def tick(state,api,actor,executor=permitted_execute,action_id=None,workflow=None,admit=None):
    # Publish existing receipts before claiming new work. Never repeat execution.
    flush_receipts(state,api,admit)
    if admit is not None and not admit():return False
    action=api.call('/v1/tools/claim',{'actor':actor,**({'id':action_id} if action_id else {}),**(workflow or {})})
    if not action.get('claimed'):return False
    body={'id':action['id'],'actor':actor}
    try:
        ready=api.call('/v1/tools/start',{**body,**(workflow or {})})
        result=executor(state,action) if ready.get('started') else {'exit_code':1,'error':'security_start_denied'}
        body.update(state='failed' if result.get('exit_code',0)!=0 or result.get('limit') else 'done',result=result)
    except Exception:
        # A timeout or response failure may follow an already-sent remote request.
        # Do not infer safe retry from the exception class or response body.
        body.update(state='ambiguous',result={'error':'execution_outcome_unconfirmed'})
    path=Path(state)/'admin/tools/receipts'/(action['id']+'.json');atomic(path,body)
    api.call('/v1/tools/finish',body);path.unlink();return True


def serve(state):
    directory=Path(state)/'admin/tools';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (directory/'worker.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return 0
        actor=uuid.uuid4().hex;api=API();running=True
        def stop(*_):
            nonlocal running
            running=False
        signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
        while running:
            if (directory/'stop').exists():break
            atomic(directory/'status.json',{'actor':actor,'pid':os.getpid(),'seen_at':time.time(),'state':'ready'})
            try:busy=tick(state,api,actor)
            except Exception:busy=False;atomic(directory/'status.json',{'actor':actor,'pid':os.getpid(),'seen_at':time.time(),'state':'waiting_for_archive'})
            if not busy:time.sleep(2)
        atomic(directory/'status.json',{'actor':actor,'pid':os.getpid(),'seen_at':time.time(),'state':'stopped'})
    return 0


def start(state):
    directory=Path(state)/'admin/tools';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    if (directory/'inactive').exists():return {'state':'inactive_restore','note':'Restored executors remain inactive until explicitly reactivated.'}
    (directory/'stop').unlink(missing_ok=True)
    with (directory/'worker.log').open('ab') as output:
        os.chmod(directory/'worker.log',0o600)
        subprocess.Popen([sys.executable,'-m','scripts.tool_worker'],cwd=ROOT,
            env={**os.environ,'NOCHEH_STATE_DIR':str(state)},stdin=subprocess.DEVNULL,stdout=output,stderr=output,start_new_session=True)
    return {'state':'starting','execution':'approved operations only'}


def running(state):
    path=Path(state)/'admin/tools/worker.lock'
    if not path.exists():return False
    with path.open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);return False
        except BlockingIOError:return True


def stop(state,wait=False):
    directory=Path(state)/'admin/tools';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    (directory/'stop').touch()
    if wait:
        deadline=time.monotonic()+100
        while running(state):
            if time.monotonic()>deadline:raise RuntimeError('tool_executor_still_draining')
            time.sleep(.2)
    return {'state':'stopping','note':'No new claims; an already-started bounded operation drains first.'}


if __name__=='__main__':raise SystemExit(serve(Path(os.environ.get('NOCHEH_STATE_DIR',ROOT/'data/local'))))
