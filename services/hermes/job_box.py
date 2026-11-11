"""The sealed job box: Hermes's own terminal, file and code tools run in it, never in a turn.

``nocheh_box`` is a plugin terminal backend. Each command Hermes runs for those tools goes,
with its stdin, over one connection to the box's exec socket (tools/runtime/box_server.py);
nothing is synced in or out. A fail-closed ``pre_tool_call`` hook blocks those tools in every
turn that is not a sealed run on this backend, or on the machine backend of machine_box.py.
"""
import contextlib
import json
import math
import os
import re
import socket
import stat
import struct
import threading
import time
import uuid

from agent.terminal_env_provider import TerminalEnvironmentProvider
from tools.environments.base import BaseEnvironment,EnvironmentConnectionError

NAME='nocheh_box'
# A machine run (machine_box.py) is sealed here too, on its own backend.
MACHINE='nocheh_machine'
# Hermes's terminal, file and code_execution toolsets; process_manage follows background commands in the box.
TOOLS=frozenset({'terminal','process_manage','read_file','write_file','patch','search_files','execute_code'})
REQUIRED=TOOLS-{'process_manage'}
# A machine run has the same tools except execute_code: its code would run there as one opaque command.
MACHINE_REQUIRED=REQUIRED-{'execute_code'}
# The box caps a command's output at 8 MiB; a box that sends more is cut off.
MAX_OUTPUT=8*1024*1024+65536
# Set once by a sealed run: the run's exact tool names and its absolute deadline (the job's hard deadline).
_STEP=None
_DEADLINE=None
# A box tool's command ends MARGIN seconds before the run does; with less than FLOOR seconds left, no box tool
# starts. Hermes's own commands, such as the kill of a code cell that ran out of time, reach the box until the
# deadline itself, each cut to the time left less END seconds (one second at least).
MARGIN=30
FLOOR=10
END=5
TIME_UP="The job's time is up. Write the final report now."


def left():
    """Seconds a box tool's command may still take in this run: none before the run is sealed."""
    return _DEADLINE-time.time()-MARGIN if _DEADLINE is not None else 0


def turn_side(cmd_string,*homes):
    """Whether a command names Hermes's own folders: its home and spill folders in this turn, or the
    results folder it would write in the box; or one of ``homes``, other folders of this turn. Hermes saves
    an oversized result in this turn, then asks the box whether it can read it there; a box that says yes
    would send the model to a file it cannot open."""
    from hermes_constants import get_hermes_home
    return (any(name in cmd_string for name in ('hermes-results','cache/spillover','cache/terminal-output'))
            or any(home and re.search(r'(?<![\w.~/-])'+re.escape(home)+r'(?![\w.-])',cmd_string)
                   for home in (str(path).rstrip('/') for path in (get_hermes_home(),*homes))))


def connect(path):
    """The box's socket, opened without following a link: commands in the box can replace it."""
    try:descriptor=os.open(path,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC)
    except OSError as error:raise EnvironmentConnectionError(f'nocheh box unavailable ({error.strerror})') from None
    try:
        if not stat.S_ISSOCK(os.fstat(descriptor).st_mode):raise EnvironmentConnectionError('nocheh box refused: its socket is not a socket')
        sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
        try:sock.settimeout(5);sock.connect(f'/proc/self/fd/{descriptor}');sock.settimeout(None)
        except OSError as error:
            sock.close();raise EnvironmentConnectionError(f'nocheh box unreachable ({error.strerror or error})') from None
        return sock
    finally:os.close(descriptor)


def exact(sock,size):
    data=bytearray()
    while len(data)<size:
        chunk=sock.recv(min(size-len(data),1<<20))
        if not chunk:return None
        data+=chunk
    return bytes(data)


def frames(sock,put):
    """Puts each output frame of a command's answer, up to MAX_OUTPUT; returns its exit code, or None when the
    answer ended, broke its framing or sent more first. ``sock`` needs only recv(size)."""
    size=0
    while (head:=exact(sock,5)) is not None and head[:1] in (b'O',b'X'):
        length=struct.unpack('>I',head[1:])[0]
        if length>1<<20 or (data:=exact(sock,length)) is None:return None
        if head[:1]==b'X':return struct.unpack('>i',data)[0] if length==4 else None
        size+=length
        if size>MAX_OUTPUT:return None
        put(data)
    return None


class Process:
    """One box command. Output is pumped into a pipe as it comes, so Hermes's drain, timeout and
    interrupt work as for a local process. It has no pid: nothing here may be killed locally."""
    def __init__(self,sock):
        self._sock=sock;self._code=None;self._done=threading.Event();self._killed=False
        read,self._write=os.pipe();self.stdout=os.fdopen(read,'r',encoding='utf-8',errors='replace')
        threading.Thread(target=self._pump,daemon=True).start()

    def _put(self,data):
        view=memoryview(data)
        while view:view=view[os.write(self._write,view):]

    def _pump(self):
        try:self._code=frames(self._sock,self._put)
        except OSError:pass
        finally:
            if self._code is None:
                if not self._killed:
                    with contextlib.suppress(OSError):self._put(b'\n[nocheh box: the connection ended before the command did]\n')
                self._code=255
            for close in (lambda:os.close(self._write),self._sock.close):
                with contextlib.suppress(OSError):close()
            self._done.set()

    @property
    def returncode(self):return self._code if self._done.is_set() else None
    def poll(self):return self.returncode
    def wait(self,timeout=None):
        self._done.wait(timeout);return self.returncode
    def kill(self):
        # shutdown, unlike close, wakes the pump's recv; the box then kills the command's process group.
        self._killed=True
        with contextlib.suppress(OSError):os.set_blocking(self._write,False)
        with contextlib.suppress(OSError):self._sock.shutdown(socket.SHUT_RDWR)


class Refused:
    """A command that is not sent: nothing reaches the box, and the command fails with its reason."""
    returncode=1
    def __init__(self,reason):
        read,write=os.pipe();os.write(write,(reason+'\n').encode());os.close(write)
        self.stdout=os.fdopen(read,'r')
    def poll(self):return 1
    def wait(self,timeout=None):return 1
    def kill(self):pass


class Forwarded(BaseEnvironment):
    """Commands and their stdin go elsewhere, each ending before the run does; nothing is synced in or out."""
    _stdin_mode='payload'

    def execute(self,command,cwd='',**kwargs):
        # Hermes's own wait ends with the command there, before the run does.
        kwargs['timeout']=max(1,min(kwargs.get('timeout') or self.timeout,int(left())))
        result=super().execute(command,cwd,**kwargs)
        # The full copy of a long output stays in this turn, where the file tools there cannot open it.
        result.pop('output_total_chars',None)
        if spill:=result.pop('full_output_path',None):
            with contextlib.suppress(OSError):os.unlink(spill)
        return result

    def cleanup(self):
        """Nocheh owns the other end: nothing to sync back or tear down."""


class Environment(Forwarded):
    """Commands and their stdin go to the box."""
    def __init__(self,path,cwd='/work',timeout=120):
        super().__init__(cwd=cwd,timeout=timeout)
        self._path=path
        connect(path).close()  # a box that is down fails here, and Hermes keeps no environment
        self.init_session()

    def _run_bash(self,cmd_string,*,login=False,timeout=120,stdin_data=None):
        if _DEADLINE is None or (until:=_DEADLINE-time.time())<=0:return Refused(TIME_UP)
        # Hermes then keeps its inline preview of an oversized result.
        if turn_side(cmd_string):return Refused("nocheh box: Hermes's own folders are not used in the box")
        timeout=max(1,min(timeout,int(until-END)))
        sock=connect(self._path)
        body=json.dumps({'script':cmd_string,'stdin':stdin_data,'timeout':timeout,'login':bool(login)}).encode()
        try:sock.sendall(struct.pack('>Q',len(body))+body)
        except OSError as error:
            sock.close();raise EnvironmentConnectionError(f'nocheh box send failed ({error.strerror or error})') from None
        return Process(sock)


class Provider(TerminalEnvironmentProvider):
    is_remote=True
    is_container=True

    @property
    def name(self):return NAME
    @property
    def display_name(self):return 'Nocheh sealed box'
    @property
    def default_cwd(self):return '/work'
    @property
    def env_description(self):return 'a sealed Nocheh job box (Linux, no network)'
    def is_available(self):return bool(os.environ.get('NOCHEH_BOX_SOCKET'))
    def create_environment(self,*,cwd,timeout,task_id='default',image=None,container_config=None,**kwargs):
        return Environment(os.environ['NOCHEH_BOX_SOCKET'],cwd=cwd or '/work',timeout=timeout)


def classes(name):
    """A sealed backend's provider and environment classes."""
    if name==MACHINE:
        from services.hermes import machine_box
        return machine_box.Provider,machine_box.Environment
    return Provider,Environment


def backend():
    """True only while every way to the job's tools leads to one sealed backend: the box's, or the machine's.
    A process runs one of them, never both."""
    from agent.terminal_env_registry import get_provider
    from tools.terminal_tool import _active_environments,_get_env_config
    name=os.environ.get('TERMINAL_ENV');box,machine=bool(os.environ.get('NOCHEH_BOX_SOCKET')),os.environ.get('NOCHEH_MACHINE_RUN')=='1'
    if name not in (NAME,MACHINE) or (box,machine)!=(name==NAME,name==MACHINE):return False
    provider,environment=classes(name)
    return (os.environ.get('NOCHEH_ISOLATED_TURN')=='1' and _get_env_config()['env_type']==name and isinstance(get_provider(name),provider)
            and all(isinstance(env,environment) for env in list(_active_environments.values())))


def seal(names,deadline):
    """Bind this turn to one box or machine run once its tools are known: the box or machine tools on
    that backend and the run's other tools run, nothing else, and no command there outlives the run's deadline."""
    global _STEP,_DEADLINE
    names=frozenset(names);name=os.environ.get('TERMINAL_ENV')
    error='job_machine_unavailable' if name==MACHINE else 'job_box_unavailable'
    if (_STEP is not None or not (MACHINE_REQUIRED if name==MACHINE else REQUIRED)<=names or (name==MACHINE and 'execute_code' in names)
            or 'delegate_task' in names or type(deadline) not in (int,float) or not math.isfinite(deadline) or not backend()):raise RuntimeError(error)
    _DEADLINE=float(deadline)
    # While a task has no environment, Hermes spills an oversized tool result into this turn and
    # sends the model to a path the box or machine cannot open. The environment is made now, as Hermes
    # makes it for any tool, and its idle reaper keeps it for this one-run process; such a result
    # then keeps its inline preview.
    from tools.terminal_tool_lifecycle import ensure_task_env,get_active_env
    os.environ['TERMINAL_LIFETIME_SECONDS']='86400'
    env=ensure_task_env()
    if not isinstance(env,classes(name)[1]) or get_active_env(str(uuid.uuid4())) is not env or not backend():raise RuntimeError(error)
    _STEP=names
    if name==MACHINE:
        # The file tools take a relative path from TERMINAL_CWD, whose ~ is this turn's home, and expand ~ in this
        # turn: once the machine told its own home, both start there, as its commands do.
        if isinstance(env.cwd,str) and env.cwd.startswith('/'):os.environ['TERMINAL_CWD']=env.cwd
        from tools.terminal_tool_config import plugin_sandbox_home
        from services.hermes import machine_box
        if home:=plugin_sandbox_home(env):machine_box.home(home)
        return
    # execute_code also keeps a long output's full copy in this turn; it gives no path the box cannot open.
    from tools import code_execution_tool
    code_execution_tool._spill_full_stdout=lambda text:None
    # A code cell ends MARGIN+FLOOR seconds before the run: room for Hermes's last poll, its wait for the
    # cell's tool calls and its kill, which all reach the box before the deadline.
    load=code_execution_tool._load_config
    def bounded():
        config=load()
        return {**config,'timeout':max(1,min(config.get('timeout',code_execution_tool.DEFAULT_TIMEOUT),int(left())-FLOOR))}
    code_execution_tool._load_config=bounded


BLOCKED={'action':'block','message':"This tool runs only in a background job's sealed box or on its machine."}


def tool_gate(tool_name='',**_):
    """pre_tool_call, fail closed: anything unexpected blocks."""
    try:
        if tool_name=='delegate_task' and (_STEP is not None or os.environ.get('NOCHEH_BOX_SOCKET') or os.environ.get('TERMINAL_ENV') in (NAME,MACHINE)
                                           or os.environ.get('NOCHEH_MACHINE_RUN')):
            return {'action':'block','message':"Subagents are not available in a background job that runs commands."}
        if _STEP is not None and tool_name not in _STEP:return {'action':'block','message':'This tool is not available in this job.'}
        if _STEP is not None and tool_name in TOOLS and left()<FLOOR:return {'action':'block','message':TIME_UP}
        if tool_name not in TOOLS:return None
        if _STEP is not None and backend():
            # Hermes's wait for a background command there is clamped by TERMINAL_TIMEOUT: it ends with the run too.
            os.environ['TERMINAL_TIMEOUT']=str(int(left()));return None
    except Exception:pass
    return BLOCKED
