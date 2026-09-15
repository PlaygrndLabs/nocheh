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


from .tool_receipts import atomic,permitted_execute,flush_receipts,tick


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
