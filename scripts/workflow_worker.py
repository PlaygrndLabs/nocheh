"""Executor supervision and shutdown remain independent of Inngest availability."""
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from .configuration import ROOT,compose_environment,compose_command
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
    if (state/'workflows/inactive').exists() or (state/'spool/.restore-inactive').exists():return {'state':'inactive_restore'}
    directory=state/'admin/workflows';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    if running(state):return {'state':'running'}
    (directory/'stop').unlink(missing_ok=True)
    subprocess.run(compose_command(state)+['up','-d','--no-build','--no-deps','--wait','nocheh-host-executor'],env=env,check=True)
    return {'state':'running'}


def stop(state,wait=False):
    # Compose suppresses restart while SIGTERM drains the foreground supervisor.
    # A stop-file alone races restart: unless-stopped and can relaunch the worker.
    subprocess.run(compose_command(state)+['stop','nocheh-host-executor'],env=compose_environment(state),check=True)
    return {'state':'stopped'}


def serve(state):
    directory=Path(state)/'admin/workflows';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    env=compose_environment(state);port=env['NOCHEH_PORT']
    base='http://nocheh-app:8780' if os.environ.get('NOCHEH_CONTAINER')=='1' else 'http://127.0.0.1:'+port
    env.update(INNGEST_BASE_URL=base,INNGEST_CONNECT_GATEWAY_URL=base.replace('http://','ws://')+'/v0/connect',NOCHEH_PYTHON=sys.executable)
    if os.environ.get('NOCHEH_CONTAINER')=='1':env['NOCHEH_NODE']='node'
    node=executable(env)
    with (directory/'worker.lock').open('a') as lock,ThreadPoolExecutor(max_workers=1) as recovery:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return 0
        (directory/'stop').unlink(missing_ok=True)
        stopping=False;child=None;pending=None;next_recovery=0;next_start=0;receipt_state='starting';next_status=0
        def terminate(*_):
            nonlocal stopping
            stopping=True
        signal.signal(signal.SIGTERM,terminate);signal.signal(signal.SIGINT,terminate)
        while not stopping and not (directory/'stop').exists():
            now=time.monotonic()
            if (state/'workflows/inactive').exists() or (state/'spool/.restore-inactive').exists():
                if child is not None and child.poll() is None:child.terminate();child.wait();child=None
                atomic(directory/'status.json',{'pid':os.getpid(),'seen_at':time.time(),'state':'inactive'})
                time.sleep(1);continue
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
