"""The sealed job box: Hermes's own terminal, file and code tools run in it, never in a turn.

``nocheh_box`` is a plugin terminal backend. Each command Hermes runs for those tools goes,
with its stdin, over one connection to the box's exec socket (tools/runtime/box_server.py);
nothing is synced in or out. A fail-closed ``pre_tool_call`` hook blocks those tools in every
turn that is not a sealed box step on this backend.
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
# Hermes's terminal, file and code_execution toolsets; process_manage follows background commands in the box.
TOOLS=frozenset({'terminal','process_manage','read_file','write_file','patch','search_files','execute_code'})
REQUIRED=TOOLS-{'process_manage'}
# The box caps a command's output at 8 MiB; a box that sends more is cut off.
MAX_OUTPUT=8*1024*1024+65536
# Set once by a sealed box step: the step's exact tool names and its absolute deadline.
_STEP=None
_DEADLINE=None
# A box tool's command ends MARGIN seconds before the step does; with less than FLOOR seconds left, no box tool
# starts. Hermes's own commands, such as the kill of a code cell that ran out of time, reach the box until the
# deadline itself, each cut to the time left less END seconds (one second at least).
MARGIN=30
FLOOR=10
END=5
TIME_UP="This step's time is up. Write down what you found so far; the next step continues."


def left():
    """Seconds a box tool's command may still take in this step: none before the step is sealed."""
    return _DEADLINE-time.time()-MARGIN if _DEADLINE is not None else 0


def turn_side(cmd_string):
    """Whether a command names Hermes's own folders: its home and spill folders in this turn, or the
    results folder it would write in the box. Hermes saves an oversized result in this turn, then asks
    the box whether it can read it there; a box that says yes would send the model to a file it cannot open."""
    from hermes_constants import get_hermes_home
    home=str(get_hermes_home()).rstrip('/')
    return (any(name in cmd_string for name in ('hermes-results','cache/spillover','cache/terminal-output'))
            or bool(home) and re.search(r'(?<![\w.~/-])'+re.escape(home)+r'(?![\w.-])',cmd_string) is not None)


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
        size=0
        try:
            while (head:=exact(self._sock,5)) is not None and head[:1] in (b'O',b'X'):
                length=struct.unpack('>I',head[1:])[0]
                if length>1<<20 or (data:=exact(self._sock,length)) is None:break
                if head[:1]==b'X':
                    if length==4:self._code=struct.unpack('>i',data)[0]
                    break
                size+=length
                if size>MAX_OUTPUT:break
                self._put(data)
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


class Environment(BaseEnvironment):
    """Commands and their stdin go to the box; nothing is synced in or out."""
    _stdin_mode='payload'

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

    def execute(self,command,cwd='',**kwargs):
        # Hermes's own wait ends with the box command, before the step does.
        kwargs['timeout']=max(1,min(kwargs.get('timeout') or self.timeout,int(left())))
        result=super().execute(command,cwd,**kwargs)
        # The full copy of a long output stays in this turn, where the box's file tools cannot open it.
        result.pop('output_total_chars',None)
        if spill:=result.pop('full_output_path',None):
            with contextlib.suppress(OSError):os.unlink(spill)
        return result

    def cleanup(self):
        """The launcher owns the box: nothing to sync back or tear down."""


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


def backend():
    """True only while every way to the box tools leads to this backend."""
    from agent.terminal_env_registry import get_provider
    from tools.terminal_tool import _active_environments,_get_env_config
    return (os.environ.get('NOCHEH_ISOLATED_TURN')=='1' and os.environ.get('TERMINAL_ENV')==NAME and bool(os.environ.get('NOCHEH_BOX_SOCKET'))
            and _get_env_config()['env_type']==NAME and isinstance(get_provider(NAME),Provider)
            and all(isinstance(env,Environment) for env in list(_active_environments.values())))


def seal(names,deadline):
    """Bind this turn to one box step once its tools are known: the box tools on this backend
    and the step's other tools run, nothing else, and no box command outlives the step's deadline."""
    global _STEP,_DEADLINE
    names=frozenset(names)
    if (_STEP is not None or not REQUIRED<=names or 'delegate_task' in names or type(deadline) not in (int,float)
            or not math.isfinite(deadline) or not backend()):raise RuntimeError('job_box_unavailable')
    _DEADLINE=float(deadline)
    # While a task has no environment, Hermes spills an oversized tool result into this turn and
    # sends the model to a path the box cannot open. The box environment is made now, as Hermes
    # makes it for any tool, and its idle reaper keeps it for this one-step process; such a result
    # then keeps its inline preview.
    from tools.terminal_tool_lifecycle import ensure_task_env,get_active_env
    os.environ['TERMINAL_LIFETIME_SECONDS']='86400'
    env=ensure_task_env()
    if not isinstance(env,Environment) or get_active_env(str(uuid.uuid4())) is not env or not backend():raise RuntimeError('job_box_unavailable')
    _STEP=names
    # execute_code also keeps a long output's full copy in this turn; it gives no path the box cannot open.
    from tools import code_execution_tool
    code_execution_tool._spill_full_stdout=lambda text:None
    # A code cell ends MARGIN+FLOOR seconds before the step: room for Hermes's last poll, its wait for the
    # cell's tool calls and its kill, which all reach the box before the deadline.
    load=code_execution_tool._load_config
    def bounded():
        config=load()
        return {**config,'timeout':max(1,min(config.get('timeout',code_execution_tool.DEFAULT_TIMEOUT),int(left())-FLOOR))}
    code_execution_tool._load_config=bounded


BLOCKED={'action':'block','message':"This tool runs only in a background job's sealed box."}


def tool_gate(tool_name='',**_):
    """pre_tool_call, fail closed: anything unexpected blocks."""
    try:
        if tool_name=='delegate_task' and (_STEP is not None or os.environ.get('NOCHEH_BOX_SOCKET') or os.environ.get('TERMINAL_ENV')==NAME):
            return {'action':'block','message':"Subagents are not available in a background job's sealed box."}
        if _STEP is not None and tool_name not in _STEP:return {'action':'block','message':'This tool is not available in this job step.'}
        if _STEP is not None and tool_name in TOOLS and left()<FLOOR:return {'action':'block','message':TIME_UP}
        if tool_name not in TOOLS:return None
        if _STEP is not None and backend():
            # Hermes's wait for a background command in the box is clamped by TERMINAL_TIMEOUT: it ends with the step too.
            os.environ['TERMINAL_TIMEOUT']=str(int(left()));return None
    except Exception:pass
    return BLOCKED
