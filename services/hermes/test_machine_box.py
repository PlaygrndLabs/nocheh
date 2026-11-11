"""The machine backend: Hermes's terminal and file tools on the owner's machine, through a fake nocheh-security."""
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from tools.runtime import box_server
from services.hermes import archive_tools,job_box,machine_box
from services.hermes.test_box_server import gone

CREDENTIAL='turn.synthetic'


def frame(kind,data):return kind+struct.pack('>I',len(data))+data
def end(code):return frame(b'X',struct.pack('>i',code))


class Broker(ThreadingHTTPServer):
    """A fake nocheh-security's /v1/machines/exec. By default it runs each script with real bash through the box
    server's own runner, as the machine service runs it over SSH: frames out, and the client going away ends the
    command. `answer` sets another reply: (status, body) refuses, a list of byte strings goes out as the body's
    chunks, and 'hang' sends the headers and waits for the client to go. It records every request."""
    def __init__(self):
        from services.hermes import mcp_fixture
        self.requests=[];self.answer=None;self.gone=threading.Event();self.scripts=tempfile.mkdtemp(prefix='machine-');outer=self
        # The broker also serves Nocheh's data tools at /mcp, as the real one does; those calls are not recorded.
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*args):pass
            def mcp(self,status,value=None):
                body=b'' if value is None else json.dumps(value).encode();self.close_connection=True
                self.send_response(status);self.send_header('Content-Length',str(len(body)));self.send_header('Connection','close')
                if value is not None:self.send_header('Content-Type','application/json')
                self.end_headers();self.wfile.write(body)
            def do_GET(self):self.mcp(405)
            do_DELETE=do_GET
            def do_POST(self):
                raw=self.rfile.read(int(self.headers['Content-Length']));body=json.loads(raw);self.close_connection=True
                if self.path=='/mcp':
                    return self.mcp(202) if 'id' not in body else self.mcp(200,{'jsonrpc':'2.0','id':body['id'],**mcp_fixture.result(body.get('method'),body.get('params') or {})})
                outer.requests.append({'path':self.path,'authorization':self.headers['Authorization'],'type':self.headers['Content-Type'],'body':body,'raw':raw})
                answer=outer.answer
                if isinstance(answer,tuple):
                    status,raw=answer;self.send_response(status);self.send_header('Content-Length',str(len(raw)));self.send_header('Connection','close')
                    self.end_headers();self.wfile.write(raw);return
                self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Connection','close')
                if answer is None:
                    self.end_headers();box_server.run(self.connection,outer.scripts,body['script'],body['stdin'],body['timeout'],body['login']);return
                self.send_header('Transfer-Encoding','chunked');self.end_headers()
                if answer=='hang':
                    while self.connection.recv(1):pass
                    outer.gone.set();return
                for chunk in answer:self.wfile.write(b'%x\r\n%s\r\n'%(len(chunk),chunk))
                self.wfile.write(b'0\r\n\r\n')
        super().__init__(('127.0.0.1',0),Handler);threading.Thread(target=self.serve_forever,daemon=True).start()
    def url(self):return 'http://127.0.0.1:%d'%self.server_address[1]
    def close(self):self.shutdown();self.server_close()
    def arrived(self,count):
        for _ in range(500):
            if len(self.requests)>=count:return True
            time.sleep(.01)
        return False


class Machine(unittest.TestCase):
    """A machine home in a folder outside Hermes's home, the fake broker, and this run's bound credential."""
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory(dir='/tmp');self.addCleanup(self.folder.cleanup)
        self.home=os.path.join(self.folder.name,'home');os.mkdir(self.home)
        self.broker=Broker();self.addCleanup(self.broker.close)
        for patcher in (patch.dict(box_server.ENV,{'HOME':self.home}),patch.object(archive_tools,'_PROCESS_CREDENTIAL',CREDENTIAL),
                        patch.dict(os.environ,{'ARCHIVE_URL':self.broker.url()})):
            patcher.start();self.addCleanup(patcher.stop)
        self.addCleanup(lambda:setattr(job_box,'_DEADLINE',None))


class MachineBackendTests(Machine):
    def setUp(self):
        super().setUp();job_box._DEADLINE=time.time()+600
        self.env=machine_box.Environment(cwd='~',timeout=20)

    def test_commands_go_there_as_this_turn_and_keep_cwd_exports_and_stdin(self):
        self.assertEqual(self.env.cwd,self.home,'the session starts in the home the machine reported')
        self.assertEqual(self.env.execute('mkdir -p sub && cd sub && export X="Alice: hello"')['returncode'],0)
        result=self.env.execute('echo "$X"; pwd')
        self.assertEqual(result['output'].split('\n')[:2],['Alice: hello',self.home+'/sub'])
        self.assertEqual(self.env.execute('cat',stdin_data='Bob: hi\n')['output'].strip(),'Bob: hi')
        self.assertEqual(self.env.execute('exit 7')['returncode'],7)
        self.assertEqual(self.broker.requests[-2]['body']['stdin'],'Bob: hi\n')
        for request in self.broker.requests:
            self.assertEqual((request['path'],request['authorization'],request['type']),('/v1/machines/exec','Bearer '+CREDENTIAL,'application/json'))
            self.assertEqual(set(request['body']),{'script','stdin','timeout','login','command','kind'})
        self.assertTrue(self.broker.requests[0]['body']['login'],'the session setup runs in a login shell')

    def test_text_goes_as_utf8_and_a_lone_surrogate_as_its_escape(self):
        # A file's text keeps its size on the way, so a big file stays within the relay's limit.
        self.broker.answer=[end(0)];text='Alice: café, naïve, Ωμέγα\n'*200
        for stdin in (text,'Bob: \udcff'):
            process=self.env._run_bash('cat',stdin_data=stdin);process.wait(5);process.stdout.close()
            self.assertEqual(self.broker.requests[-1]['body']['stdin'],stdin)
        self.assertNotIn(b'\\u',self.broker.requests[-2]['raw']);self.assertIn('Ωμέγα'.encode(),self.broker.requests[-2]['raw'])
        self.assertIn(b'Bob: \\udcff',self.broker.requests[-1]['raw'])

    def test_a_refusal_fails_the_command_with_its_words_and_is_not_retried(self):
        cases=[(409 if code!='machine_unreachable' else 502,json.dumps({'error':code}).encode(),words) for code,words in machine_box.REFUSALS.items()]
        cases+=[(409,b'{"error":"private storage detail"}',machine_box.REFUSED),(503,b'not json',machine_box.REFUSED),(413,b'',machine_box.REFUSED)]
        for status,raw,words in cases:
            self.broker.answer=(status,raw);sent=len(self.broker.requests)
            with self.subTest(status=status,raw=raw):
                result=self.env.execute('echo "Alice: hello"')
                self.assertEqual((result['returncode'],result['output'].strip()),(1,words))
                self.assertEqual(len(self.broker.requests),sent+1)
        self.assertEqual(machine_box.REFUSALS['machine_time_up'],job_box.TIME_UP)
        self.assertTrue(machine_box.REFUSALS['machine_off'].endswith('Write the final report now.'))
        # Without its key nothing more runs there: the owner adds the machine again, which is another machine.
        self.assertIn('remove it and add it again',machine_box.REFUSALS['machine_key_missing'])
        self.assertTrue(machine_box.REFUSALS['machine_key_missing'].endswith('Write the final report now.'))

    def test_nocheh_out_of_reach_or_no_credential_fails_the_command_at_once(self):
        with socket.socket() as spare:spare.bind(('127.0.0.1',0));port=spare.getsockname()[1]
        with patch.dict(os.environ,{'ARCHIVE_URL':'http://127.0.0.1:%d'%port}):
            started=time.monotonic();result=self.env.execute('echo "Alice: hello"')
        self.assertEqual((result['returncode'],result['output'].strip()),(1,machine_box.UNREACHABLE));self.assertLess(time.monotonic()-started,5)
        with patch.object(archive_tools,'_PROCESS_CREDENTIAL',None):result=self.env.execute('echo "Alice: hello"')
        self.assertEqual((result['returncode'],result['output'].strip()),(1,machine_box.UNBOUND))

    def test_a_kill_closes_the_connection_and_the_command_ends_there(self):
        process=self.env._run_bash('sleep 30 & echo $!; wait',timeout=60)
        pid=int(process.stdout.readline())
        started=time.monotonic();process.kill()
        self.assertEqual(process.wait(2),255);self.assertLess(time.monotonic()-started,1)
        self.assertTrue(gone(pid));process.stdout.close()
        self.assertFalse(hasattr(process,'pid'))
        # The broker sees the connection end, whatever it is waiting for.
        self.broker.answer='hang';sent=len(self.broker.requests);process=self.env._run_bash('sleep 30',timeout=60)
        self.assertTrue(self.broker.arrived(sent+1));process.kill()
        self.assertEqual(process.wait(2),255);self.assertTrue(self.broker.gone.wait(2));process.stdout.close()

    def test_a_kill_before_the_connection_is_open_sends_nothing(self):
        go=threading.Event();connect=machine_box.http.client.HTTPConnection.connect
        def slow(connection):go.wait(5);connect(connection)
        sent=len(self.broker.requests)
        with patch.object(machine_box.http.client.HTTPConnection,'connect',slow):
            process=self.env._run_bash('echo "Alice: hello"',timeout=30);process.kill();go.set()
            self.assertEqual(process.wait(5),255)
        self.assertEqual(process.stdout.read(),'');process.stdout.close();time.sleep(.3)
        self.assertEqual(len(self.broker.requests),sent)

    def test_frames_are_read_across_any_chunks_and_a_cut_answer_says_so(self):
        body=frame(b'O',b'Alice: ')+frame(b'O',b'hello\n')+end(3)
        self.broker.answer=[body[:3],body[3:9],body[9:10],body[10:]]
        process=self.env._run_bash('true')
        self.assertEqual(process.wait(5),3);self.assertEqual(process.stdout.read(),'Alice: hello\n');process.stdout.close()
        for answer in ([frame(b'O',b'Alice: hello\n')],[frame(b'O',b'Alice: hello\n')+b'Z'+struct.pack('>I',1)+b'x'+end(0)]):
            self.broker.answer=answer;process=self.env._run_bash('true')
            with self.subTest(answer=answer):
                self.assertEqual(process.wait(5),255);self.assertEqual(process.stdout.read(),'Alice: hello\n'+machine_box.ENDED)
            process.stdout.close()

    def test_every_command_ends_before_the_step_does(self):
        self.broker.answer=[end(0)];env=self.env
        job_box._DEADLINE=time.time()+100.5;env.execute('sleep 1',timeout=500);env.execute('sleep 1')
        job_box._DEADLINE=time.time()+100.5;process=env._run_bash('sleep 1',timeout=500);process.wait(5);process.stdout.close()
        self.assertEqual([item['body']['timeout'] for item in self.broker.requests[-3:]],[70,20,95])
        # Hermes's own last commands, such as a kill, still reach the machine until the deadline itself.
        for deadline,timeout in ((39.5,9),(3.5,1)):
            job_box._DEADLINE=time.time()+deadline
            with self.subTest(deadline=deadline):
                self.assertEqual(env.execute('kill 1234',timeout=15)['returncode'],0);self.assertEqual(self.broker.requests[-1]['body']['timeout'],timeout)
        # Once it has passed, nothing is sent and the model is told why.
        for deadline in (time.time()-1,None):
            job_box._DEADLINE=deadline;sent=len(self.broker.requests)
            with self.subTest(deadline=deadline):
                result=env.execute('echo "Alice: hello"')
                self.assertNotEqual(result['returncode'],0);self.assertIn(job_box.TIME_UP,result['output'])
                self.assertEqual(len(self.broker.requests),sent)

    def test_no_command_outlasts_the_relay_and_its_timeout_is_whole_seconds(self):
        # nocheh-security relays a command for 15 minutes at most: the command, and Hermes's wait for it, end sooner.
        self.broker.answer=[end(0)];job_box._DEADLINE=time.time()+3300
        self.env.execute('true',timeout=3000);self.env.execute('true',timeout=30.7)
        process=self.env._run_bash('true',timeout=2000.5);process.wait(5);process.stdout.close()
        self.assertEqual([item['body']['timeout'] for item in self.broker.requests[-3:]],[machine_box.LONGEST,30,machine_box.LONGEST])
        self.assertLess(machine_box.LONGEST,900)
        self.broker.answer='hang';started=time.monotonic()
        with patch.object(machine_box,'LONGEST',2):result=self.env.execute('sleep 300',timeout=500)
        self.assertEqual((result['returncode'],self.broker.requests[-1]['body']['timeout']),(124,2));self.assertLess(time.monotonic()-started,10)
        self.assertTrue(self.broker.gone.wait(5))

    def test_hermes_stops_waiting_when_the_step_ends_and_closes_the_connection(self):
        self.broker.answer='hang';job_box._DEADLINE=time.time()+job_box.MARGIN+2.5;started=time.monotonic()
        result=self.env.execute('sleep 300',timeout=500)
        self.assertEqual(self.broker.requests[-1]['body']['timeout'],2);self.assertEqual(result['returncode'],124);self.assertLess(time.monotonic()-started,10)
        self.assertTrue(self.broker.gone.wait(5))

    def test_this_turns_folders_and_results_never_reach_the_machine(self):
        sent=len(self.broker.requests)
        result=self.env.execute('umask 077 && mkdir -p /tmp/hermes-results && cat > /tmp/hermes-results/call_1.txt',stdin_data='Alice: secret')
        self.assertNotEqual(result['returncode'],0)
        from tools.tool_result_storage import maybe_persist_tool_result
        preview=maybe_persist_tool_result(content='Alice: hello\n'*12000,tool_name='terminal',tool_use_id='call_2',env=self.env)
        self.assertIn('Full output could not be saved to sandbox',preview)
        # A file tool's ~ is this turn's home: the model is told to use the machine's own path.
        with patch.dict(os.environ,{'HERMES_HOME':'/profile'}):
            result=self.env.execute("cat '/profile/home/notes.txt'")
        self.assertEqual((result['returncode'],result['output'].strip()),(1,machine_box.HERE))
        self.assertEqual(len(self.broker.requests),sent)
        with patch('tools.tool_output_limits.get_max_bytes',return_value=1000):
            result=self.env.execute("head -c 20000 /dev/zero | tr '\\0' a",bounded_capture=True)
        self.assertIn('OUTPUT TRUNCATED',result['output']);self.assertNotIn('full_output_path',result);self.assertNotIn('output_total_chars',result)

    def test_the_log_gets_the_terminal_command_file_commands_and_hermes_own_as_internal(self):
        self.assertEqual(self.broker.requests[0]['body']['kind'],'internal','the session setup')
        self.broker.answer=[end(0)];sent=len(self.broker.requests)
        def call(name,*commands,**args):
            def run(payload=None):
                for command in commands:command()
                return 'result'
            self.assertEqual(machine_box.tool_execution(tool_name=name,args=args,next_call=run,task_id='t'),'result')
        execute=lambda command:lambda:self.env.execute(command)
        call('terminal',execute('ls -la ~'),execute('cat /tmp/hermes_bg_1.log'),command='ls -la ~')
        call('read_file',execute("wc -c < 'notes.txt'"),path='notes.txt')
        call('process_manage',execute('kill 1234'),action='kill',session_id='proc_1')
        # Another thread runs the same command while the terminal call runs: a poll, not the call.
        def worker():
            thread=threading.Thread(target=self.env.execute,args=('uptime',));thread.start();thread.join(10)
        call('terminal',worker,command='uptime')
        # After the call, the same command is Hermes's own again.
        self.env.execute('ls -la ~')
        process=self.env._run_bash('true');process.wait(5);process.stdout.close()
        self.assertEqual([(item['body']['command'],item['body']['kind']) for item in self.broker.requests[sent:]],[
            ('ls -la ~','command'),('cat /tmp/hermes_bg_1.log','internal'),("wc -c < 'notes.txt'",'file'),('kill 1234','internal'),
            ('uptime','internal'),('ls -la ~','internal'),('true','internal')])
        with self.assertRaises(RuntimeError):
            machine_box.tool_execution(tool_name='terminal',args={'command':'ls'},next_call=lambda payload=None:(_ for _ in ()).throw(RuntimeError('failed')))
        self.assertIsNone(machine_box._CALL.get())

    def test_a_background_command_is_logged_as_asked_and_its_polls_as_internal(self):
        from tools.process_registry import process_registry
        command='sleep 1; echo "Alice: done"'
        sent=len(self.broker.requests)
        session=machine_box.tool_execution(tool_name='terminal',args={'command':command,'background':True},
                                           next_call=lambda payload=None:process_registry.spawn_via_env(self.env,command,cwd=self.home,task_id='machine_test'))
        for _ in range(100):
            if session.exited:break
            time.sleep(.1)
        self.assertTrue(session.exited);self.assertIn('Alice: done',session.output_buffer)
        logged=[(item['body']['kind'],item['body']['command']) for item in self.broker.requests[sent:]]
        self.assertEqual(logged[0],('command',command));self.assertGreaterEqual(len(logged),3)
        self.assertEqual({kind for kind,_ in logged[1:]},{'internal'})


class MachineProviderTests(unittest.TestCase):
    def test_the_backend_is_remote_starts_at_the_machine_home_and_asks_no_approval_per_command(self):
        provider=machine_box.Provider()
        self.assertEqual((provider.name,provider.is_remote,provider.is_container,provider.skip_container_guards,provider.default_cwd),
                         ('nocheh_machine',True,False,True,'~'))
        self.assertEqual(provider.env_description,"the owner's machine (Linux) over SSH")
        for value,available in (('1',True),('',False),('0',False),('true',False)):
            with self.subTest(value=value),patch.dict(os.environ,{'NOCHEH_MACHINE_RUN':value}):self.assertIs(provider.is_available(),available)
        from agent.terminal_env_registry import register_provider,restore_registration
        register_provider(provider)
        try:
            from tools.approval import check_all_command_guards
            from tools.terminal_tool_config import _is_container_backend
            for command in ('rm -rf /','echo hunter2 | sudo -S apt-get install -y nginx'):
                with self.subTest(command=command),patch.dict(os.environ):
                    os.environ.pop('SUDO_PASSWORD',None)
                    self.assertTrue(check_all_command_guards(command,'nocheh_machine')['approved'],'Hermes skips its floors here, so tool_call keeps them')
            self.assertFalse(_is_container_backend('nocheh_machine'))
        finally:restore_registration(machine_box.NAME,provider,None)

    def test_the_hardline_and_sudo_floors_still_block_terminal_commands(self):
        patcher=patch.dict(os.environ);patcher.start();self.addCleanup(patcher.stop);os.environ.pop('SUDO_PASSWORD',None)
        for command in ('rm -rf /','sudo reboot','mkfs.ext4 /dev/sda1','rm -rf ~'):
            with self.subTest(command=command):
                verdict=machine_box.tool_call(tool_name='terminal',args={'command':command},task_id='t')
                self.assertEqual(verdict['action'],'block');self.assertTrue(verdict['message'].startswith('BLOCKED (hardline): '))
        # A password guessed into sudo -S, as Hermes blocks it on a host or over its own SSH.
        for command in ('echo hunter2 | sudo -S apt-get install -y nginx','cd /srv && sudo -S true <<< hunter2'):
            with self.subTest(command=command):
                verdict=machine_box.tool_call(tool_name='terminal',args={'command':command},task_id='t')
                self.assertEqual(verdict,{'action':'block','message':'BLOCKED: sudo password guessing via stdin (sudo -S). '
                                          'Nocheh never pipes a password to sudo on the machine.'})
        for command in ('rm -rf build','echo "do not reboot"','ls -la ~','sudo apt-get update','echo "never use sudo -S"'):
            with self.subTest(command=command):self.assertIsNone(machine_box.tool_call(tool_name='terminal',args={'command':command},task_id='t'))
        self.assertIsNone(machine_box.tool_call(tool_name='read_file',args={'path':'/etc/hostname'},task_id='t'))
        for name in ('detect_hardline_command','_check_sudo_stdin_guard'):
            with self.subTest(name=name),patch('tools.approval_detection.'+name,side_effect=RuntimeError('broken')):
                self.assertEqual(machine_box.tool_call(tool_name='terminal',args={'command':'ls'},task_id='t')['action'],'block')
                self.assertIsNone(machine_box.tool_call(tool_name='read_file',args={'path':'notes.txt'},task_id='t'))

    def test_the_plugin_adds_the_backend_its_hook_and_its_middleware_only_for_a_machine_run(self):
        from services.hermes import register
        class Context:
            def __init__(self):self.calls=[]
            def __getattr__(self,name):return lambda *args,**kwargs:self.calls.append((name,args))
        for value,backend in (('',False),('0',False),('1',True)):
            with self.subTest(value=value),patch.dict(os.environ,{'NOCHEH_MACHINE_RUN':value,'NOCHEH_BOX_SOCKET':''}):
                context=Context();register(context)
                providers=[args[0] for name,args in context.calls if name=='register_terminal_environment_provider']
                self.assertEqual([type(item) for item in providers],[machine_box.Provider] if backend else [])
                self.assertIs(('register_hook',('pre_tool_call',machine_box.tool_call)) in context.calls,backend)
                self.assertIs(('register_middleware',('tool_execution',machine_box.tool_execution)) in context.calls,backend)
                self.assertIn(('register_hook',('pre_tool_call',job_box.tool_gate)),context.calls)


def machine_env(**changes):
    return patch.dict(os.environ,{'NOCHEH_ISOLATED_TURN':'1','TERMINAL_ENV':'nocheh_machine','NOCHEH_MACHINE_RUN':'1','TERMINAL_CWD':'~','NOCHEH_BOX_SOCKET':'',**changes})


def file_tool(name,**args):
    from tools import file_tools
    return json.loads(getattr(file_tools,name)(task_id='call_task',**args))


class MachineGateTests(Machine):
    def setUp(self):
        super().setUp()
        from agent.terminal_env_registry import register_provider
        from tools import file_tools,file_tools_paths,file_tools_write_guards
        self.provider=machine_box.Provider();register_provider(self.provider);self.deadline=time.time()+300
        # A sealed step points the file tools' ~ at the machine for the rest of its process: here, until the test ends.
        for module in (file_tools,file_tools_paths,file_tools_write_guards):
            patcher=patch.object(module,'_expand_tilde',module._expand_tilde);patcher.start();self.addCleanup(patcher.stop)
        # As in a turn: its own home is not the machine's, and Hermes's home holds no home folder.
        self.turn=os.path.join(self.folder.name,'turn');os.mkdir(self.turn)
        self.names=job_box.MACHINE_REQUIRED|{'process_manage','mcp__nocheh__archive_page','todo_list'}

    def tearDown(self):
        from agent.terminal_env_registry import restore_registration
        from tools.file_tools import clear_file_ops_cache
        from tools.terminal_tool import _active_environments,clear_session_cwd
        from tools.terminal_tool_lifecycle import _unregister_env
        restore_registration(machine_box.NAME,self.provider,None)
        for key,env in list(_active_environments.items()):
            if key=='machine_box_test' or isinstance(env,machine_box.Environment):_unregister_env(key)
        clear_file_ops_cache();clear_session_cwd('call_task')
        job_box._STEP=job_box._DEADLINE=None

    def blocked(self,name):
        return (job_box.tool_gate(tool_name=name,args={},task_id='t') or {}).get('action')=='block'

    def test_machine_tools_are_blocked_outside_a_sealed_machine_step(self):
        for name in job_box.TOOLS:
            with self.subTest(name=name):self.assertTrue(self.blocked(name))
        with machine_env():
            self.assertTrue(self.blocked('terminal'));self.assertTrue(self.blocked('delegate_task'))
        with patch.dict(os.environ,{'NOCHEH_MACHINE_RUN':'1'}):self.assertTrue(self.blocked('delegate_task'))

    def test_a_sealed_machine_step_runs_its_terminal_and_file_tools_there_and_no_code(self):
        from tools.terminal_tool import _active_environments
        from tools.terminal_tool_lifecycle import get_active_env
        with machine_env():
            job_box.seal(self.names,self.deadline)
            for name in self.names:
                with self.subTest(name=name):self.assertFalse(self.blocked(name))
            for name in ('execute_code','delegate_task','mcp__nocheh__shell','memory'):
                with self.subTest(name=name):self.assertTrue(self.blocked(name))
            self.assertEqual(job_box.tool_gate(tool_name='execute_code',args={},task_id='t'),{'action':'block','message':'This tool is not available in this job.'})
            env=get_active_env('call_task');self.assertIsInstance(env,machine_box.Environment)
            # Its relative file paths start where its commands do: the home the machine reported.
            self.assertEqual((env.cwd,os.environ['TERMINAL_CWD']),(self.home,self.home))
            from tools.file_tools_paths import _resolve_path_for_task
            self.assertEqual(str(_resolve_path_for_task('notes.txt','call_task')),self.home+'/notes.txt')
            job_box._DEADLINE=time.time()+35
            for name in job_box.MACHINE_REQUIRED:
                with self.subTest(name=name):self.assertEqual(job_box.tool_gate(tool_name=name,args={},task_id='t'),{'action':'block','message':job_box.TIME_UP})
            # Hermes's wait for a background command ends with the step too.
            job_box._DEADLINE=time.time()+100.5;self.assertFalse(self.blocked('terminal'));self.assertEqual(os.environ['TERMINAL_TIMEOUT'],'70')
            job_box._DEADLINE=self.deadline
            for changes in ({'NOCHEH_BOX_SOCKET':'/box/exec.sock'},{'NOCHEH_MACHINE_RUN':''},{'TERMINAL_ENV':'nocheh_box'},{'NOCHEH_ISOLATED_TURN':'0'}):
                with self.subTest(changes=changes),patch.dict(os.environ,changes):self.assertTrue(self.blocked('read_file'))
            _active_environments['machine_box_test']=object()
            self.assertTrue(self.blocked('terminal'))

    def test_a_file_tools_tilde_is_the_machine_home_as_in_its_commands(self):
        with machine_env(HOME=self.turn):
            job_box.seal(self.names,self.deadline)
            self.assertEqual(file_tool('write_file_tool',path='~/notes.txt',content='Alice: hello\n')['resolved_path'],self.home+'/notes.txt')
            self.assertIn('Alice: hello',file_tool('read_file_tool',path='~/notes.txt')['content'])
            patched=file_tool('patch_tool',path='~/notes.txt',old_string='hello',new_string='bye')
            self.assertEqual((patched.get('error'),patched['resolved_path']),(None,self.home+'/notes.txt'))
            found=file_tool('search_tool',pattern='Alice',path='~')
            self.assertEqual([match['path'] for match in found['matches']],[self.home+'/notes.txt'],found)
            # The terminal keeps the machine's own ~, and a ~user is Hermes's as before.
            from tools.terminal_tool_lifecycle import get_active_env
            self.assertEqual(get_active_env('call_task').execute('cat ~/notes.txt')['output'].strip(),'Alice: bye')
            from tools.file_tools_paths import _expand_tilde
            self.assertEqual((_expand_tilde('~'),_expand_tilde('~/a b'),_expand_tilde('/srv/~x')),(self.home,self.home+'/a b','/srv/~x'))
        self.assertEqual(os.listdir(self.turn),[],'nothing of the machine lands in this turn')

    def test_a_file_tools_path_in_this_turns_home_is_never_sent(self):
        # The machine did not tell its home at the seal: ~ and relative paths of the file tools stay in this turn, so
        # they are refused, and the model is told to use the full path.
        self.broker.answer=(502,b'{"error":"machine_unreachable"}')
        with machine_env(HOME=self.turn):
            job_box.seal(self.names,self.deadline);self.broker.answer=None;sent=len(self.broker.requests)
            for path in ('~/notes.txt','notes.txt'):
                with self.subTest(path=path):
                    written=file_tool('write_file_tool',path=path,content='Alice: hello\n')
                    self.assertIn(machine_box.HERE,json.dumps(written));self.assertNotIn('notes.txt',os.listdir(self.home))
            self.assertEqual(len(self.broker.requests),sent)
            from tools.terminal_tool_lifecycle import get_active_env
            result=get_active_env('call_task').execute(f'cat {self.turn}/notes.txt')
            self.assertEqual((result['returncode'],result['output'].strip()),(1,machine_box.HERE))
            self.assertEqual(get_active_env('call_task').execute(f'ls {self.turn}x; true')['returncode'],0,'another folder is sent')

    def test_a_machine_step_is_sealed_once_with_its_tools_and_never_with_code(self):
        with self.assertRaisesRegex(RuntimeError,'job_box_unavailable'):job_box.seal(self.names,self.deadline)
        with machine_env():
            for names in (self.names|{'execute_code'},self.names-{'read_file'},self.names|{'delegate_task'}):
                with self.subTest(names=names),self.assertRaisesRegex(RuntimeError,'job_machine_unavailable'):job_box.seal(names,self.deadline)
            for changes in ({'NOCHEH_ISOLATED_TURN':'0'},{'NOCHEH_MACHINE_RUN':''},{'NOCHEH_BOX_SOCKET':'/box/exec.sock'}):
                with self.subTest(changes=changes),patch.dict(os.environ,changes),self.assertRaisesRegex(RuntimeError,'job_machine_unavailable'):
                    job_box.seal(self.names,self.deadline)
            self.assertEqual(self.broker.requests,[],'nothing reaches the machine before the step is sealed')
            job_box.seal(self.names,self.deadline);self.assertEqual(job_box._DEADLINE,self.deadline)
            with self.assertRaisesRegex(RuntimeError,'job_machine_unavailable'):job_box.seal(self.names,self.deadline)

    def test_a_machine_that_is_down_is_sealed_and_each_command_says_why(self):
        self.broker.answer=(502,b'{"error":"machine_unreachable"}')
        with machine_env():
            job_box.seal(self.names,self.deadline)
            from tools.terminal_tool_lifecycle import get_active_env
            env=get_active_env('call_task');self.assertEqual(os.environ['TERMINAL_CWD'],'~','no home was reported')
            result=env.execute('ls')
        self.assertEqual((result['returncode'],result['output'].strip()),(1,machine_box.REFUSALS['machine_unreachable']))


class MachineStepTests(unittest.TestCase):
    def test_a_machine_step_needs_the_isolated_turn_and_the_machine_backend_in_both_directions(self):
        from services.hermes.assistant_turn import machine_step
        step=lambda machine,box=False:{'channel':'background','background':{'max_iterations':20,'box':box,'machine':machine}}
        sealed={'NOCHEH_ISOLATED_TURN':'1','NOCHEH_MACHINE_RUN':'1','TERMINAL_ENV':'nocheh_machine'}
        cases=[(step(True),sealed,True),(step(False),{},False),({'channel':'telegram'},{},False),
               ({'channel':'background','background':{'max_iterations':20}},{},False),
               (step(True),{**sealed,'NOCHEH_ISOLATED_TURN':'0'},None),(step(True),{**sealed,'NOCHEH_MACHINE_RUN':''},None),
               (step(True),{**sealed,'NOCHEH_MACHINE_RUN':'true'},None),(step(True),{**sealed,'TERMINAL_ENV':'nocheh_box'},None),(step(True),{},None),
               (step(False),sealed,None),(step(False),{'TERMINAL_ENV':'nocheh_machine'},None),({'channel':'telegram'},{'NOCHEH_MACHINE_RUN':'1'},None),
               ({'channel':'background','review':True,'background':{'machine':True}},sealed,None),(step(True,box=True),sealed,None)]
        for body,environment,expected in cases:
            with self.subTest(body=body,environment=environment),patch.dict(os.environ,{'NOCHEH_ISOLATED_TURN':'','NOCHEH_MACHINE_RUN':'','TERMINAL_ENV':'',**environment}):
                if expected is None:
                    with self.assertRaisesRegex(ValueError,'job_machine_unavailable'):machine_step(body)
                else:self.assertIs(machine_step(body),expected)
        with self.assertRaisesRegex(ValueError,'invalid_background_run'):machine_step(step('true'))

    def test_machine_toolsets_offer_exactly_the_machine_tools(self):
        from hermes_constants import set_hermes_home_override,reset_hermes_home_override
        from hermes_cli.plugins import discover_plugins
        from model_tools import get_tool_definitions
        from services.hermes.assistant_turn import BACKGROUND_TOOLS,BOX_TOOLS,MACHINE_TOOLS,MACHINE_TOOLSETS,turn_tools,verify_profile_tools
        from services.hermes.test_scopes import JOB_MACHINE_TOOLS
        from services.hermes.profile_config import atomic_yaml,resolved
        self.assertNotIn('memory',MACHINE_TOOLSETS);self.assertEqual(MACHINE_TOOLS-BACKGROUND_TOOLS,job_box.TOOLS-{'execute_code'})
        self.assertEqual(BOX_TOOLS-MACHINE_TOOLS,{'execute_code'});self.assertEqual(MACHINE_TOOLS,JOB_MACHINE_TOOLS)
        with tempfile.TemporaryDirectory() as folder,machine_env():
            profile=Path(folder);atomic_yaml(profile/'config.yaml',resolved({},'synthetic'))
            (profile/'plugins').mkdir();(profile/'plugins'/'nocheh').symlink_to(Path(job_box.__file__).parent,target_is_directory=True)
            token=set_hermes_home_override(str(profile))
            try:
                discover_plugins()
                from services.hermes import mcp_fixture
                with mcp_fixture.connected():
                    names={item['function']['name'] for item in get_tool_definitions(enabled_toolsets=MACHINE_TOOLSETS,quiet_mode=True)}
                removed,allowed=turn_tools(True,False,True)
                self.assertEqual(names-removed,JOB_MACHINE_TOOLS);self.assertEqual(allowed,JOB_MACHINE_TOOLS)
                verify_profile_tools(names-removed,allowed)
            finally:reset_hermes_home_override(token)

    def test_a_step_that_disagrees_with_its_environment_stops_before_the_agent_runs(self):
        from services.hermes import assistant_turn
        step=lambda machine,box=False:{'session_id':'s','text':'Set up the project.','channel':'background','background':{'max_iterations':5,'machine':machine,'box':box}}
        for body,environment in ((step(False),{'NOCHEH_ISOLATED_TURN':'1','NOCHEH_MACHINE_RUN':'1','TERMINAL_ENV':'nocheh_machine'}),
                                 (step(True),{'NOCHEH_ISOLATED_TURN':'1'}),
                                 (step(True,True),{'NOCHEH_ISOLATED_TURN':'1','NOCHEH_BOX_SOCKET':'/box/exec.sock','TERMINAL_ENV':'nocheh_box'})):
            with self.subTest(body=body),patch.dict(os.environ,{'NOCHEH_BOX_SOCKET':'','NOCHEH_MACHINE_RUN':'','TERMINAL_ENV':'',**environment}),\
                 patch.object(assistant_turn,'sealed_dependencies',side_effect=AssertionError('the agent was started')):
                with self.assertRaisesRegex(ValueError,'job_machine_unavailable'):assistant_turn.run(body)

    def test_a_step_without_its_machine_reports_job_machine_unavailable(self):
        # As the launcher runs a machine step whose binding named no machine: System › Background work shows this code.
        body={'session_id':'s','text':'Set up the project.','channel':'background','background':{'max_iterations':5,'machine':True},'archive_credential':CREDENTIAL}
        with tempfile.TemporaryDirectory() as folder:
            environment={**os.environ,'HERMES_HOME':folder,'NOCHEH_ISOLATED_TURN':'','NOCHEH_MACHINE_RUN':'','TERMINAL_ENV':''}
            child=subprocess.run([sys.executable,'-m','services.hermes.assistant_turn'],input=json.dumps(body),cwd=Path(__file__).resolve().parents[2],
                                 env=environment,capture_output=True,text=True,timeout=120)
        self.assertEqual(child.returncode,0,child.stderr[-2000:])
        result=json.loads(child.stdout.splitlines()[-1])
        self.assertEqual((result['state'],result['error_code'],result['error_stage']),('failed','job_machine_unavailable','machine_step'))


# One machine step through assistant_turn.run, in its own process as in production: the test's fake nocheh-security
# runs its commands in a folder, and the step's model is outside.
TURN='''import json,os,sys
from pathlib import Path
from unittest.mock import patch
body,folder,url=json.loads(sys.argv[1]),Path(sys.argv[2]),sys.argv[3]
os.environ.update(NOCHEH_ISOLATED_TURN='1',TERMINAL_ENV='nocheh_machine',NOCHEH_MACHINE_RUN='1',TERMINAL_CWD='~',ARCHIVE_URL=url)
from services.hermes import archive_tools,assistant_turn,job_box,request_boundary,subscription
def archive(path,value=None):
    if path=='/v1/context/prepare':return value
    return {'imports':[]} if path=='/v1/imports/pending' else {'hits':[]}
install=request_boundary.install
with patch.object(request_boundary,'install',lambda:install(request_boundary.Boundary('on',transform=lambda url,payload:payload))),\\
     patch.object(subscription,'configured_urls',lambda:{body['base_url']}),patch.object(archive_tools,'request',archive):
    lines=[]
    try:result=assistant_turn.run(body,None,lines.append)
    except Exception as error:result={'raised':str(error)}
(folder/'result.json').write_text(json.dumps({'result':result,'step':sorted(job_box._STEP or []),'deadline':job_box._DEADLINE}))
'''


class MachineTurnTests(unittest.TestCase):
    def test_a_machine_step_runs_its_tools_there_and_logs_each_command_as_asked(self):
        from services.hermes.assistant_turn import MACHINE_TOOLS
        from services.hermes.profile_config import atomic_yaml,resolved
        sent=[];command='echo "Alice: hello" > marker.txt; pwd'
        calls=[{'name':'terminal','arguments':json.dumps({'command':command})},{'name':'read_file','arguments':json.dumps({'path':'marker.txt'})}]
        class Model(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def reply(self,body,kind='application/json'):
                self.send_response(200);self.send_header('content-type',kind);self.send_header('content-length',str(len(body)));self.end_headers();self.wfile.write(body)
            def do_GET(self):self.reply(json.dumps({'object':'list','data':[{'id':'synthetic','object':'model','context_length':128000}]}).encode())
            def do_POST(self):
                payload=json.loads(self.rfile.read(int(self.headers.get('content-length',0))));sent.append(payload)
                done=sum(message.get('role')=='tool' for message in payload.get('messages',[]))
                call=calls[done] if payload.get('tools') and done<len(calls) else None
                message={'role':'assistant','content':None,'tool_calls':[{'id':'call_%d'%done,'type':'function','function':call}]} if call else {'role':'assistant','content':'Report: done'}
                usage={'prompt_tokens':10,'completion_tokens':2,'total_tokens':12};reason='tool_calls' if call else 'stop'
                if not payload.get('stream'):
                    return self.reply(json.dumps({'id':'r','object':'chat.completion','created':0,'model':'synthetic','usage':usage,
                        'choices':[{'index':0,'message':message,'finish_reason':reason}]}).encode())
                delta={**message,**({'tool_calls':[{**message['tool_calls'][0],'index':0}]} if call else {})}
                chunks=[{'choices':[{'index':0,'delta':delta,'finish_reason':None}]},{'choices':[{'index':0,'delta':{},'finish_reason':reason}],'usage':usage}]
                self.reply(b''.join(b'data: '+json.dumps({'id':'r','object':'chat.completion.chunk','created':0,'model':'synthetic',**c}).encode()+b'\n\n' for c in chunks)+b'data: [DONE]\n\n','text/event-stream')
        server=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start()
        broker=Broker()
        try:
            with tempfile.TemporaryDirectory(dir='/tmp') as folder:
                folder=Path(folder);profile=folder/'profile';home=folder/'home';(profile/'native-state').mkdir(parents=True);(profile/'memories').mkdir();home.mkdir()
                atomic_yaml(profile/'config.yaml',resolved({},'synthetic'))
                (profile/'plugins').mkdir();(profile/'plugins'/'nocheh').symlink_to(Path(job_box.__file__).parent,target_is_directory=True)
                body={'session_id':'s','chat_id':'5','user_id':'5','owner':True,'text':'Set up the project.','channel':'background',
                      'background':{'max_iterations':5,'box':False,'machine':True,'soft_deadline':time.time()+100,
                                    'rates':{'input':2,'output':10,'cache_read':None,'cache_write':None,'request':None},'cost_limit_usd':5,'prior_cost_usd':0},
                      'model':'synthetic','api_key':'synthetic','base_url':'http://127.0.0.1:%d/v1'%server.server_address[1],'provider':'openai','api_mode':'chat_completions',
                      'archive_credential':CREDENTIAL,'turn_deadline_epoch':time.time()+120,'model_context_length':128000}
                with patch.dict(box_server.ENV,{'HOME':str(home)}):
                    child=subprocess.run([sys.executable,'-c',TURN,json.dumps(body),str(folder),broker.url()],cwd=Path(__file__).resolve().parents[2],
                                         env={**os.environ,'HERMES_HOME':str(profile)},capture_output=True,text=True,timeout=240)
                self.assertEqual(child.returncode,0,child.stderr[-2000:])
                outcome=json.loads((folder/'result.json').read_text());marker=(home/'marker.txt').read_text()
        finally:server.shutdown();server.server_close();broker.close()
        self.assertEqual((outcome['result'].get('state'),outcome['result'].get('text')),('done','Report: done'),outcome['result'])
        steps=[payload for payload in sent if payload.get('tools')]
        self.assertEqual([{tool['function']['name'] for tool in payload['tools']} for payload in steps],[set(MACHINE_TOOLS)]*3)
        self.assertEqual(outcome['step'],sorted(MACHINE_TOOLS));self.assertEqual(outcome['deadline'],body['turn_deadline_epoch'])
        self.assertEqual(marker,'Alice: hello\n')
        terminal,read=[json.dumps(message['content']) for message in steps[-1]['messages'] if message.get('role')=='tool']
        self.assertIn(str(folder/'home'),terminal);self.assertIn('Alice: hello',read)
        logged=[(item['body']['kind'],item['body']['command']) for item in broker.requests]
        self.assertEqual({item['authorization'] for item in broker.requests},{'Bearer '+CREDENTIAL})
        self.assertEqual(logged[0][0],'internal','the session setup')
        self.assertEqual([entry for entry in logged if entry[0]=='command'],[('command',command)],'the model\'s command, once, as it asked')
        self.assertTrue(any(kind=='file' and 'marker.txt' in text for kind,text in logged),logged)


if __name__=='__main__':unittest.main()
