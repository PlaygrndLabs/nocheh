"""Host supervision and shutdown remain independent of Inngest availability."""
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from .configuration import ROOT,compose_environment
from .tool_worker import atomic


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
    with (directory/'worker.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return 0
        stopping=False;child=None
        def terminate(*_):
            nonlocal stopping
            stopping=True
        signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGINT,terminate)
        while not stopping and not (directory/'stop').exists():
            child=subprocess.Popen([env.get('NOCHEH_NODE','node'),str(ROOT/'dist/src/workflows/host.js')],cwd=ROOT,env=env,
                                   stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            atomic(directory/'status.json',{'pid':os.getpid(),'seen_at':time.time(),'state':'running'})
            while child.poll() is None and not stopping and not (directory/'stop').exists():time.sleep(.2)
            if child.poll() is None:child.terminate();child.wait();break
            atomic(directory/'status.json',{'pid':os.getpid(),'seen_at':time.time(),'state':'restarting'})
            for _ in range(25):
                if stopping or (directory/'stop').exists():break
                time.sleep(.2)
        atomic(directory/'status.json',{'pid':os.getpid(),'seen_at':time.time(),'state':'stopped'})
    return 0


if __name__=='__main__':raise SystemExit(serve(Path(os.environ.get('NOCHEH_STATE_DIR',ROOT/'data/local')).resolve()))
