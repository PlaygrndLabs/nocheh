"""A machine job: Hermes's own terminal and file tools run on the owner's machine, never in a turn.

``nocheh_machine`` is a plugin terminal backend. Each command Hermes runs for those tools goes, with its
stdin, to Nocheh's /v1/machines/exec as this run's turn. Nocheh checks the job, logs the command and runs it
over SSH on the machine the owner approved, with a key this turn never sees. The answer comes back in the
box's frames (tools/runtime/box_server.py); nothing is synced in or out. The job's sealed run, its deadline
and its fail-closed gate are job_box.py's.
"""
import contextlib
import contextvars
import http.client
import json
import os
import socket
import threading
import time
from urllib.parse import urlsplit

from agent.terminal_env_provider import TerminalEnvironmentProvider
from services.hermes import job_box
from services.hermes.archive_tools import endpoint

NAME=job_box.MACHINE
PATH='/v1/machines/exec'
# Seconds to open the connection to Nocheh; the answer then takes as long as the command, which Hermes bounds.
CONNECT=10
# nocheh-security relays one machine command for at most 15 minutes. Each command, and Hermes's wait for it, ends
# sooner, with Hermes's own timeout; longer work runs as a background command.
LONGEST=840
# Hermes's file tools: every command one of them runs is a file command in the machine log.
FILE_TOOLS=frozenset({'read_file','write_file','patch','search_files'})
# How Hermes starts a terminal command in the background on a backend like this one (spawn_via_env).
BACKGROUND='( nohup bash -lc '
# The tool call Hermes is executing (tool_execution below): its name and, for the terminal, the command the model
# asked for. Hermes runs the hooks on worker threads, but the call itself and its commands in this context.
_CALL=contextvars.ContextVar('nocheh_machine_call',default=None)
# The machine log's command and kind for the command execute() is running; _run_bash gets only the wrapped script.
_ASKED=contextvars.ContextVar('nocheh_machine_asked',default=None)
STOP=' Write the final report now.'
# Nocheh's refusals, as the model reads them. A command it refused never reached the machine.
REFUSALS={
    'invalid_machine_request':'Nocheh refused this command: the request was not valid.',
    'machine_not_allowed':'This job can no longer run commands on the machine.'+STOP,
    'machine_off':'Machine control is turned off, so nothing runs on the machine.'+STOP,
    'machine_changed':"The machine's settings changed after the owner approved this job, so nothing runs on it."+STOP,
    'machine_time_up':job_box.TIME_UP,
    'machine_unavailable':'Machine control is not available right now.',
    'machine_unreachable':'The machine cannot be reached.',
    'machine_auth_failed':"The machine refused Nocheh's key.",
    'machine_host_key_changed':"The machine's host key changed. The owner must trust the new key in Settings › Machines.",
    'machine_host_key_unknown':"The machine's host key is not trusted yet. The owner must test the connection in Settings › Machines.",
    'machine_script_too_long':'This command is too long to send to the machine.',
    'machine_timeout':'The command ran out of time on the machine.',
    'machine_key_missing':'Nocheh has no key for this machine. The owner must remove it and add it again in Settings › Machines.'+STOP,
}
REFUSED='Nocheh could not run this command on the machine.'
UNREACHABLE='Nocheh could not be reached, so nothing ran on the machine.'
UNBOUND='This run has no way to the machine.'
# A path in this turn's home or in Hermes's own folders; the file tools put ~ there while the machine has not told its own.
HERE='This path is in Nocheh, not on the machine. Use the full path on the machine instead of ~.'
ENDED='\n[nocheh machine: the connection ended before the command did]\n'


def refusal(response):
    """The model's line for an answer that is not the command's: words for a known code, else a plain line."""
    try:code=json.loads(response.read(4096)).get('error')
    except Exception:code=None
    return REFUSALS.get(code,REFUSED)


class Reader:
    """An HTTP answer's body as job_box.frames reads it."""
    def __init__(self,response):self.recv=response.read


class Process:
    """One machine command, asked of Nocheh in its own thread. The answer is pumped into a pipe as it comes, so
    Hermes's drain, timeout and interrupt work as for a local process. It has no pid: nothing here may be killed
    locally. kill() closes the connection; Nocheh then ends the command on the machine."""
    def __init__(self,base,credential,body):
        self._lock=threading.Lock();self._sock=None;self._killed=False;self._code=None;self._done=threading.Event()
        read,self._write=os.pipe();self.stdout=os.fdopen(read,'r',encoding='utf-8',errors='replace')
        threading.Thread(target=self._pump,args=(base,credential,body),daemon=True).start()

    def _put(self,data):
        view=memoryview(data)
        while view:view=view[os.write(self._write,view):]

    def _pump(self,base,credential,body):
        url=urlsplit(base);connection=None;sent=False
        try:
            connection=(http.client.HTTPSConnection if url.scheme=='https' else http.client.HTTPConnection)(url.hostname,url.port,timeout=CONNECT)
            connection.connect()
            with self._lock:
                if self._killed:return
                self._sock=connection.sock
            connection.sock.settimeout(None)
            connection.request('POST',url.path.rstrip('/')+PATH,body=body,headers={'Authorization':'Bearer '+credential,'Content-Type':'application/json'})
            sent=True
            response=connection.getresponse()
            # Nocheh refused it, or the machine could not start it: the command fails with the reason, and Hermes
            # does not retry it as it would after an exception.
            if response.status!=200:self._put((refusal(response)+'\n').encode());self._code=1;return
            self._code=job_box.frames(Reader(response),self._put)
        except (OSError,ValueError,http.client.HTTPException):pass
        finally:
            if self._code is None:
                if not self._killed:
                    with contextlib.suppress(OSError):self._put((ENDED if sent else UNREACHABLE+'\n').encode())
                self._code=255 if sent or self._killed else 1
            for close in (lambda:os.close(self._write),connection.close if connection else lambda:None):
                with contextlib.suppress(OSError):close()
            self._done.set()

    @property
    def returncode(self):return self._code if self._done.is_set() else None
    def poll(self):return self.returncode
    def wait(self,timeout=None):
        self._done.wait(timeout);return self.returncode
    def kill(self):
        # shutdown, unlike close, wakes the pump's read; Nocheh sees the connection end and stops the command.
        with self._lock:self._killed=True;sock=self._sock
        with contextlib.suppress(OSError):os.set_blocking(self._write,False)
        if sock is not None:
            with contextlib.suppress(OSError):sock.shutdown(socket.SHUT_RDWR)


def asked(command):
    """The machine log's command and kind for a command Hermes runs in the tool call it is executing. The terminal
    call's own command, run now or started in the background, is a command, logged as the model asked for it;
    any command of a file tool is a file command; anything else Hermes runs by itself, such as its polls of a
    background command and its session setup, is internal."""
    tool,wanted=_CALL.get() or ('',None)
    if tool=='terminal' and isinstance(wanted,str) and (command==wanted or BACKGROUND in command):return wanted,'command'
    return command,'file' if tool in FILE_TOOLS else 'internal'


class Environment(job_box.Forwarded):
    """Commands and their stdin go to the owner's machine through Nocheh, as this run's turn."""
    def __init__(self,cwd='~',timeout=120):
        super().__init__(cwd=cwd,timeout=timeout)
        # Before its run is sealed every command is refused, so the prompt's probe environment asks Nocheh nothing.
        self.init_session()

    def _run_bash(self,cmd_string,*,login=False,timeout=120,stdin_data=None):
        if job_box._DEADLINE is None or (until:=job_box._DEADLINE-time.time())<=0:return job_box.Refused(job_box.TIME_UP)
        # Hermes then keeps its inline preview of an oversized result, and a file tool's path in this turn is not sent.
        if job_box.turn_side(cmd_string,os.path.expanduser('~')):return job_box.Refused(HERE)
        try:base,credential=endpoint()
        except RuntimeError:return job_box.Refused(UNBOUND)
        # Hermes's own commands, such as its session setup, call this directly.
        command,kind=_ASKED.get() or (cmd_string,'internal')
        # Nocheh takes whole seconds; a model's fractional timeout is cut to them. Text goes as UTF-8, so a file's
        # body stays within the relay's limit; a lone surrogate goes as the JSON escape json.dumps writes by default.
        body=json.dumps({'script':cmd_string,'stdin':stdin_data,'timeout':int(max(1,min(timeout,LONGEST,until-job_box.END))),
                         'login':bool(login),'command':command,'kind':kind},ensure_ascii=False).encode('utf-8','backslashreplace')
        return Process(base,credential,body)

    def execute(self,command,cwd='',**kwargs):
        # Hermes's own wait ends before the relay's, so a command that runs too long ends with Hermes's timeout.
        kwargs['timeout']=max(1,min(kwargs.get('timeout') or self.timeout,LONGEST))
        token=_ASKED.set(asked(command))
        try:return super().execute(command,cwd,**kwargs)
        finally:_ASKED.reset(token)


class Provider(TerminalEnvironmentProvider):
    is_remote=True
    # The machine's own paths, such as /home/<login>, are used as they are, never taken for this turn's.
    is_container=False

    @property
    def name(self):return NAME
    @property
    def display_name(self):return "the owner's machine"
    @property
    def skip_container_guards(self):
        # The owner approved the job's plan on one card: Hermes asks for no approval per command. Its hardline
        # and sudo -S floors still apply (tool_call below), as Hermes skips them for such a backend.
        return True
    @property
    def default_cwd(self):return '~'
    @property
    def env_description(self):return "the owner's machine (Linux) over SSH"
    def is_available(self):return os.environ.get('NOCHEH_MACHINE_RUN')=='1'
    def create_environment(self,*,cwd,timeout,task_id='default',image=None,container_config=None,**kwargs):
        return Environment(cwd=cwd or '~',timeout=timeout)


def home(path):
    """From now on ~ and ~/... in Hermes's file tools name the machine's home ``path``, as in its commands. Hermes
    expands them in this turn, for a backend that is not a container, to this turn's own home."""
    from tools import file_tools,file_tools_paths,file_tools_write_guards
    expand=file_tools_paths._expand_tilde
    def tilde(value):return path+value[1:] if isinstance(value,str) and (value=='~' or value.startswith('~/')) else expand(value)
    for module in (file_tools_paths,file_tools,file_tools_write_guards):module._expand_tilde=tilde


def tool_execution(tool_name='',args=None,next_call=None,**_):
    """tool_execution middleware in a machine run: notes the tool call for the machine log while Hermes executes it."""
    token=_CALL.set((tool_name,args.get('command') if isinstance(args,dict) else None))
    try:return next_call()
    finally:_CALL.reset(token)


def tool_call(tool_name='',args=None,**_):
    """pre_tool_call in a machine run: blocks a terminal command on Hermes's floors: its hardline floor, such as a
    recursive delete of / or a shutdown, and a password piped to sudo -S. Fails closed for the terminal."""
    try:
        command=args.get('command') if isinstance(args,dict) else None
        if tool_name=='terminal' and isinstance(command,str):
            from tools.approval_detection import _check_sudo_stdin_guard,detect_hardline_command
            hardline,description=detect_hardline_command(command)
            if hardline:return {'action':'block','message':f'BLOCKED (hardline): {description}. Nocheh never runs this on the machine.'}
            guess,description=_check_sudo_stdin_guard(command)
            if guess:return {'action':'block','message':f'BLOCKED: {description}. Nocheh never pipes a password to sudo on the machine.'}
    except Exception:
        if tool_name=='terminal':return {'action':'block','message':'This command could not be checked, so it did not run.'}
    return None
