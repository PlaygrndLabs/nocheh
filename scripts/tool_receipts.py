"""Approved host effects and durable receipts, independent of the event engine."""
import fcntl
import json
import os
from contextlib import contextmanager
from pathlib import Path
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


@contextmanager
def receipt_lock(state):
    directory=Path(state)/'admin/tools';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (directory/'receipts.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        yield


def flush_receipts(state,api,admit=None):
    with receipt_lock(state):return _flush_receipts(state,api,admit)


def _flush_receipts(state,api,admit=None):
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
    with receipt_lock(state):
        path=Path(state)/'admin/tools/receipts'/(action['id']+'.json');atomic(path,body)
        api.call('/v1/tools/finish',body);path.unlink()
    return True
