"""Host supervision and shutdown remain independent of Inngest availability."""
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from .configuration import ROOT,compose_environment
from .tool_receipts import atomic,flush_receipts
from .archive import API
from .node_runtime import executable


def recover_receipts(state):
    class ReceiptAPI(API):
        def call(self,path,body=None,binary=False,timeout=5):
            return super().call(path,body,binary,5)
    deadline=time.monotonic()+10
    return flush_receipts(state,ReceiptAPI(),lambda:time.monotonic()<deadline)


def running(state):
    path=Path(state)/'admin/workflows/worker.lock'
    if not path.exists():return False
    with path.open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);return False
        except BlockingIOError:return True


def start(state):
    state=Path(state);env=compose_environment(state)
    if env.get('NOCHEH_WORKFLOWS_ENABLED')!='true':return {'state':'disabled'}
    if (state/'workflows/inactive').exists() or (state/'spool/.restore-inactive').exists():return {'state':'inactive_restore'}
    directory=state/'admin/workflows';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    if running(state):return {'state':'running'}
    executable(env)
    (directory/'stop').unlink(missing_ok=True)
    subprocess.Popen([sys.executable,'-m','scripts.workflow_worker'],cwd=ROOT,env={**os.environ,'NOCHEH_STATE_DIR':str(state)},
                     stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    return {'state':'starting'}


def stop(state,wait=False):
    directory=Path(state)/'admin/workflows';directory.mkdir(parents=True,exist_ok=True,mode=0o700);(directory/'stop').touch()
    if wait:
        deadline=time.monotonic()+420
        while running(state):
            if time.monotonic()>deadline:raise RuntimeError('workflow_host_still_draining')
            time.sleep(.2)
    return {'state':'stopping'}


def serve(state):
    directory=Path(state)/'admin/workflows';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    env=compose_environment(state);port=env['NOCHEH_PORT']
    if env.get('NOCHEH_WORKFLOWS_ENABLED')!='true' or (state/'workflows/inactive').exists() or (state/'spool/.restore-inactive').exists():return 0
    env.update(INNGEST_BASE_URL='http://127.0.0.1:'+port,INNGEST_CONNECT_GATEWAY_URL='ws://127.0.0.1:'+port+'/v0/connect',NOCHEH_PYTHON=sys.executable)
    node=executable(env)
    with (directory/'worker.lock').open('a') as lock,ThreadPoolExecutor(max_workers=1) as recovery:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return 0
        stopping=False;child=None;pending=None;next_recovery=0;next_start=0;receipt_state='starting';next_status=0
        def terminate(*_):
            nonlocal stopping
            stopping=True
        signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGINT,terminate)
        while not stopping and not (directory/'stop').exists():
            now=time.monotonic()
            if pending is not None and pending.done():
                try:pending.result();receipt_state='ready'
                except Exception:receipt_state='waiting_for_archive'
                pending=None;next_recovery=now+2
            if pending is None and now>=next_recovery:pending=recovery.submit(recover_receipts,state)
            if child is not None and child.poll() is not None:child=None;next_start=now+5
            if child is None and now>=next_start:
                try:
                    child=subprocess.Popen([node,str(ROOT/'dist/src/workflows/host.js')],cwd=ROOT,env=env,
                                           stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
                except OSError:next_start=now+5
            if now>=next_status:
                atomic(directory/'status.json',{'pid':os.getpid(),'seen_at':time.time(),'state':'running',
                    'connect_process':'running' if child else 'restarting','receipts':receipt_state})
                next_status=now+5
            time.sleep(.2)
        if child is not None and child.poll() is None:child.terminate();child.wait()
        atomic(directory/'status.json',{'pid':os.getpid(),'seen_at':time.time(),'state':'stopped'})
    return 0


if __name__=='__main__':raise SystemExit(serve(Path(os.environ.get('NOCHEH_STATE_DIR',ROOT/'data/local')).resolve()))
