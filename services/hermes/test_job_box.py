import json
import os
import socket
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.runtime import box_server
from services.hermes import job_box
from services.hermes.test_box_server import gone
from tools.environments.base import EnvironmentConnectionError


class Box:
    """The real in-box server, in this process; the test's own uid is not refused."""
    def __init__(self,folder):
        self.path=os.path.join(folder,'exec.sock');self.server=box_server.listen(self.path,os.getgid())
        threading.Thread(target=box_server.serve,args=(self.server,-1),daemon=True).start()
    def stop(self):
        if self.server.fileno()!=-1:self.server.shutdown(socket.SHUT_RDWR);self.server.close()


class Fake:
    """An exec socket that answers every command with exit 0 and no output, as a box command that
    replaced the box's own server could; hang=True never answers. It records every request."""
    def __init__(self,folder,hang=False):
        self.path=os.path.join(folder,'hung.sock' if hang else 'fake.sock');self.hang=hang;self.requests=[]
        self.server=socket.socket(socket.AF_UNIX);self.server.bind(self.path);self.server.listen()
        threading.Thread(target=self.serve,daemon=True).start()
    def serve(self):
        while True:
            try:conn,_=self.server.accept()
            except OSError:return
            with conn:
                # Environment's own check connects and sends nothing.
                if (head:=job_box.exact(conn,8)) is None:continue
                self.requests.append(json.loads(job_box.exact(conn,struct.unpack('>Q',head)[0])))
                if self.hang:conn.recv(1)
                else:conn.sendall(b'X'+struct.pack('>I',4)+struct.pack('>i',0))
    def stop(self):
        self.server.shutdown(socket.SHUT_RDWR);self.server.close()


def sealed_env(path):
    return patch.dict(os.environ,{'NOCHEH_ISOLATED_TURN':'1','TERMINAL_ENV':'nocheh_box','NOCHEH_BOX_SOCKET':path,'TERMINAL_CWD':'/work'})


class BoxBackendTests(unittest.TestCase):
    def setUp(self):
        # Outside Hermes's home, where Hermes points TMPDIR once booted: commands naming its home are never sent.
        self.folder=tempfile.TemporaryDirectory(dir='/tmp');self.box=Box(self.folder.name);job_box._DEADLINE=time.time()+600
        self.env=job_box.Environment(self.box.path,cwd=self.folder.name,timeout=20)

    def tearDown(self):
        job_box._DEADLINE=None;self.box.stop();self.folder.cleanup()

    def test_commands_keep_cwd_and_exports_and_get_their_stdin(self):
        self.assertEqual(self.env.execute('mkdir -p sub && cd sub && export X="Alice: hello"')['returncode'],0)
        result=self.env.execute('echo "$X"; pwd')
        self.assertEqual(result['output'].split('\n')[:2],['Alice: hello',self.folder.name+'/sub'])
        self.assertEqual(self.env.execute('cat',stdin_data='Bob: hi\n')['output'].strip(),'Bob: hi')
        self.assertEqual(self.env.execute('exit 7')['returncode'],7)

    def test_the_socket_is_opened_without_following_a_link(self):
        link=os.path.join(self.folder.name,'link.sock');os.symlink(self.box.path,link)
        plain=os.path.join(self.folder.name,'plain');Path(plain).write_text('Alice: hello')
        dead=os.path.join(self.folder.name,'dead.sock');stale=socket.socket(socket.AF_UNIX);stale.bind(dead);stale.close()
        for path,reason in ((link,'refused'),(plain,'refused'),(dead,'unreachable'),(self.folder.name+'/none','unavailable')):
            with self.subTest(path=path),self.assertRaisesRegex(EnvironmentConnectionError,reason):job_box.connect(path)
        job_box.connect(self.box.path).close()

    def test_a_dead_box_fails_closed(self):
        self.box.stop();os.unlink(self.box.path)
        with self.assertRaises(EnvironmentConnectionError):self.env.execute('echo Alice')
        with self.assertRaises(EnvironmentConnectionError):job_box.Environment(self.box.path,cwd='/',timeout=5)

    def test_a_cancel_wakes_the_command_and_the_box_kills_it(self):
        process=self.env._run_bash('sleep 30 & echo $!; wait',timeout=60)
        pid=int(process.stdout.readline())
        started=time.monotonic();process.kill()
        self.assertEqual(process.wait(2),255);self.assertLess(time.monotonic()-started,1)
        self.assertTrue(gone(pid));process.stdout.close()
        self.assertFalse(hasattr(process,'pid'))

    def test_results_folder_commands_send_nothing_and_hermes_keeps_its_preview(self):
        sent=[];real=job_box.connect
        class Spy:
            def __init__(self,sock):self.sock=sock
            def sendall(self,data):sent.append(data);return self.sock.sendall(data)
            def __getattr__(self,name):return getattr(self.sock,name)
        with patch.object(job_box,'connect',lambda path:Spy(real(path))):
            result=self.env.execute('umask 077 && mkdir -p /tmp/hermes-results && cat > /tmp/hermes-results/call_1.txt',stdin_data='Alice: secret')
            self.assertNotEqual(result['returncode'],0);self.assertEqual(sent,[])
            from tools.tool_result_storage import maybe_persist_tool_result
            preview=maybe_persist_tool_result(content='Alice: hello\n'*12000,tool_name='terminal',tool_use_id='call_2',env=self.env)
        self.assertIn('Full output could not be saved to sandbox',preview)
        self.assertFalse(any(b'Alice: hello' in data or b'hermes-results' in data or b'spillover' in data for data in sent))

    def test_a_box_that_answers_yes_to_everything_never_gets_a_turn_side_path(self):
        fake=Fake(self.folder.name)
        try:
            env=job_box.Environment(fake.path,cwd=self.folder.name,timeout=20)
            from tools.tool_result_storage import maybe_persist_tool_result
            preview=maybe_persist_tool_result(content='Alice: hello\n'*30000,tool_name='terminal',tool_use_id='call_1',env=env,threshold=1000)
            self.assertNotIn('Full output saved to',preview);self.assertIn('Full output could not be saved to sandbox',preview)
            self.assertFalse(any('spillover' in item['script'] or 'hermes-results' in item['script'] for item in fake.requests))
            # Hermes's home and its spill folders are this turn's; a command that names them is not sent.
            sent=len(fake.requests)
            with patch.dict(os.environ,{'HERMES_HOME':'/profile'}):
                for command in ('test -r /profile/cache/spillover/call_1.txt',"cat '/profile/config.yaml'",'cd /profile','ls cache/spillover',
                                'tail ~/.hermes/cache/terminal-output/out-1.log','mkdir -p /tmp/hermes-results'):
                    with self.subTest(command=command):
                        result=env.execute(command)
                        self.assertNotEqual(result['returncode'],0);self.assertIn("Hermes's own folders",result['output'])
                self.assertEqual(len(fake.requests),sent)
                for command in ('cat /work/profile/data.csv','ls /profiles','echo /profile.txt'):
                    with self.subTest(command=command):self.assertEqual(env.execute(command)['returncode'],0)
                self.assertEqual(len(fake.requests),sent+3)
        finally:fake.stop()

    def test_every_command_ends_before_the_step_does(self):
        fake=Fake(self.folder.name)
        try:
            env=job_box.Environment(fake.path,cwd=self.folder.name,timeout=20);env.execute('true')
            job_box._DEADLINE=time.time()+100.5;env.execute('sleep 1',timeout=500);env.execute('sleep 1')
            job_box._DEADLINE=time.time()+100.5;process=env._run_bash('sleep 1',timeout=500);process.wait(5);process.stdout.close()
            self.assertEqual([item['timeout'] for item in fake.requests[-3:]],[70,20,95])
            # Hermes's own last commands, such as a kill, still reach the box until the deadline itself.
            for deadline,timeout in ((39.5,9),(3.5,1)):
                job_box._DEADLINE=time.time()+deadline
                with self.subTest(deadline=deadline):
                    self.assertEqual(env.execute('kill 1234',timeout=15)['returncode'],0);self.assertEqual(fake.requests[-1]['timeout'],timeout)
            # Once it has passed, nothing starts and the model is told why.
            for deadline in (time.time()-1,None):
                job_box._DEADLINE=deadline;sent=len(fake.requests)
                with self.subTest(deadline=deadline):
                    result=env.execute('echo "Alice: hello"')
                    self.assertNotEqual(result['returncode'],0);self.assertIn(job_box.TIME_UP,result['output'])
                    self.assertEqual(len(fake.requests),sent)
        finally:fake.stop()

    def test_hermes_stops_waiting_for_a_command_when_the_box_does(self):
        fake,hung=Fake(self.folder.name),Fake(self.folder.name,hang=True)
        try:
            env=job_box.Environment(fake.path,cwd=self.folder.name,timeout=20);env.execute('true');env._path=hung.path
            job_box._DEADLINE=time.time()+job_box.MARGIN+2.5;outcome=[]
            worker=threading.Thread(target=lambda:outcome.append(env.execute('sleep 300',timeout=500)),daemon=True);started=time.monotonic()
            worker.start();worker.join(15)
            self.assertEqual(hung.requests[-1]['timeout'],2);self.assertEqual(outcome[0]['returncode'],124);self.assertLess(time.monotonic()-started,10)
        finally:fake.stop();hung.stop()

    def test_a_long_output_keeps_no_copy_the_box_cannot_open(self):
        from hermes_constants import get_hermes_home
        spill=get_hermes_home()/'cache'/'terminal-output'
        with patch('tools.tool_output_limits.get_max_bytes',return_value=1000):
            result=self.env.execute("head -c 20000 /dev/zero | tr '\\0' a",bounded_capture=True)
        self.assertIn('OUTPUT TRUNCATED',result['output'])
        self.assertNotIn('full_output_path',result);self.assertNotIn('output_total_chars',result)
        self.assertEqual(list(spill.glob('out-*.log')) if spill.exists() else [],[])


class ToolGateTests(unittest.TestCase):
    def setUp(self):
        from agent.terminal_env_registry import register_provider
        self.folder=tempfile.TemporaryDirectory();self.box=Box(self.folder.name)
        from tools import code_execution_tool
        self.provider=job_box.Provider();register_provider(self.provider);self.deadline=time.time()+300
        self.names=job_box.REQUIRED|{'mcp__nocheh__archive_page','todo_list'};self.spill=code_execution_tool._spill_full_stdout;self.load=code_execution_tool._load_config

    def tearDown(self):
        from agent.terminal_env_registry import restore_registration
        from tools.terminal_tool import _active_environments
        from tools.terminal_tool_lifecycle import _unregister_env
        from tools import code_execution_tool
        restore_registration(job_box.NAME,self.provider,None)
        for key,env in list(_active_environments.items()):
            if key=='job_box_test' or isinstance(env,job_box.Environment):_unregister_env(key)
        code_execution_tool._spill_full_stdout=self.spill;code_execution_tool._load_config=self.load
        job_box._STEP=job_box._DEADLINE=None;self.box.stop();self.folder.cleanup()

    def blocked(self,name):
        return (job_box.tool_gate(tool_name=name,args={},task_id='t') or {}).get('action')=='block'

    def test_box_tools_are_blocked_outside_a_sealed_box_step(self):
        for name in job_box.TOOLS:
            with self.subTest(name=name):self.assertTrue(self.blocked(name))
        self.assertFalse(self.blocked('mcp__nocheh__archive_page'));self.assertFalse(self.blocked('delegate_task'))
        with sealed_env(self.box.path):
            # The box is mounted but this step was never sealed.
            self.assertTrue(self.blocked('terminal'));self.assertTrue(self.blocked('delegate_task'))

    def test_a_sealed_step_runs_only_its_tools_and_only_on_the_box_backend(self):
        with sealed_env(self.box.path):
            job_box.seal(self.names,self.deadline)
            for name in self.names:
                with self.subTest(name=name):self.assertFalse(self.blocked(name))
            for name in ('delegate_task','mcp__nocheh__shell','memory','web_search'):
                with self.subTest(name=name):self.assertTrue(self.blocked(name))
            # Once the job's time is up, its box tools say so; its other tools still run.
            self.assertEqual(job_box.TIME_UP,"The job's time is up. Write the final report now.")
            self.assertEqual(job_box.tool_gate(tool_name='web_search',args={},task_id='t'),{'action':'block','message':'This tool is not available in this job.'})
            job_box._DEADLINE=time.time()+35
            for name in job_box.REQUIRED:
                with self.subTest(name=name):self.assertEqual(job_box.tool_gate(tool_name=name,args={},task_id='t'),{'action':'block','message':job_box.TIME_UP})
            self.assertFalse(self.blocked('mcp__nocheh__archive_page'))
            # Hermes's wait for a background command, and the terminal's default timeout, end with the step too.
            from tools.terminal_tool import _get_env_config
            job_box._DEADLINE=time.time()+100.5;self.assertFalse(self.blocked('terminal'))
            self.assertEqual((os.environ['TERMINAL_TIMEOUT'],_get_env_config()['timeout']),('70',70))
            job_box._DEADLINE=self.deadline
            with patch.dict(os.environ,{'TERMINAL_ENV':'local'}):self.assertTrue(self.blocked('execute_code'))
            with patch('tools.terminal_tool._get_env_config',side_effect=RuntimeError('broken')):self.assertTrue(self.blocked('read_file'))
            from tools.terminal_tool import _active_environments
            _active_environments['job_box_test']=object()
            self.assertTrue(self.blocked('terminal'))

    def test_a_step_is_sealed_once_with_all_box_tools_on_the_box_backend(self):
        with self.assertRaisesRegex(RuntimeError,'job_box_unavailable'):job_box.seal(self.names,self.deadline)
        with sealed_env(self.box.path):
            for names,deadline in ((self.names-{'execute_code'},self.deadline),(self.names|{'delegate_task'},self.deadline),
                                   (self.names,None),(self.names,True),(self.names,str(self.deadline)),(self.names,float('inf'))):
                with self.subTest(names=names,deadline=deadline),self.assertRaisesRegex(RuntimeError,'job_box_unavailable'):job_box.seal(names,deadline)
            for changes in ({'NOCHEH_ISOLATED_TURN':'0'},{'NOCHEH_MACHINE_RUN':'1'}):
                with self.subTest(changes=changes),patch.dict(os.environ,changes),self.assertRaisesRegex(RuntimeError,'job_box_unavailable'):job_box.seal(self.names,self.deadline)
            # A job run lasts up to its job's hard deadline, 55 minutes after it started at most.
            long=time.time()+3300
            job_box.seal(self.names,long);self.assertEqual(job_box._DEADLINE,long)
            self.assertAlmostEqual(job_box.left(),3300-job_box.MARGIN,delta=2)
            with self.assertRaisesRegex(RuntimeError,'job_box_unavailable'):job_box.seal(self.names,self.deadline)
            from tools import code_execution_tool
            self.assertIsNone(code_execution_tool._spill_full_stdout('Alice: hello'))
            # A code cell ends while the step can still stop it.
            for deadline,timeout in ((600.5,min(self.load().get('timeout',code_execution_tool.DEFAULT_TIMEOUT),560)),(100.5,60),(40.5,1)):
                job_box._DEADLINE=time.time()+deadline
                with self.subTest(deadline=deadline):self.assertEqual(code_execution_tool._load_config()['timeout'],timeout)

    def test_a_sealed_step_has_its_box_environment_before_any_box_command(self):
        # Without one, Hermes would save an oversized result in this turn and send the model there.
        from tools.terminal_tool import _env_lock,_get_env_config,_last_activity
        from tools.terminal_tool_lifecycle import _cleanup_inactive_envs,get_active_env
        from tools.tool_result_storage import maybe_persist_tool_result
        with sealed_env(self.box.path):
            self.assertIsNone(get_active_env('call_task'))
            job_box.seal(self.names,self.deadline)
            env=get_active_env('call_task');self.assertIsInstance(env,job_box.Environment)
            # The step's deadline was set before the environment was made: its snapshot keeps exports from command to command.
            self.assertTrue(env._snapshot_ready)
            preview=maybe_persist_tool_result(content='{"records":"'+'Alice: hello. '*20000+'"}',tool_name='mcp__nocheh__archive_page',
                                              tool_use_id='call_7',env=get_active_env('call_task'))
            self.assertIn('Full output could not be saved to sandbox',preview);self.assertNotIn('Full output saved to',preview)
            # Hermes's idle reaper keeps it for the whole step, however long the step goes without a box command.
            with _env_lock:
                for key in _last_activity:_last_activity[key]-=600
            _cleanup_inactive_envs(_get_env_config()['lifetime_seconds'])
            self.assertIs(get_active_env('call_task'),env)

    def test_a_code_cell_that_runs_out_of_time_at_the_end_is_killed_in_the_box(self):
        # The latest a cell can start: its poll, the wait for its tool calls and its kill still reach the box before the deadline.
        import re
        from tools import code_execution_tool
        from tools.code_kernel_remote import execute_in_remote_kernel
        from tools.terminal_tool_lifecycle import get_active_env
        scripts=[];run=box_server.run
        def recorded(conn,where,script,*rest):scripts.append(script);return run(conn,where,script,*rest)
        def runners(folder):
            found=[]
            for pid in filter(str.isdigit,os.listdir('/proc')):
                try:
                    if b'kernel_runner.py' in Path(f'/proc/{pid}/cmdline').read_bytes() and \
                            b'HERMES_KERNEL_DIR='+folder.encode()+b'\0' in Path(f'/proc/{pid}/environ').read_bytes():found.append(int(pid))
                except OSError:pass
            return found
        with sealed_env(self.box.path),patch.object(box_server,'run',recorded):
            job_box.seal(self.names,time.time()+job_box.MARGIN+job_box.FLOOR+.5)
            # seal() runs real box commands; a busy machine must not eat the half second this test keeps.
            job_box._DEADLINE=time.time()+job_box.MARGIN+job_box.FLOOR+.5
            self.assertFalse(self.blocked('execute_code'))
            timeout=code_execution_tool._load_config()['timeout'];self.assertEqual(timeout,1);env=get_active_env('call_task')
            result=execute_in_remote_kernel('import time\ntime.sleep(600)',env=env,env_type=job_box.NAME,task_env_id='call_task',
                                            sandbox_tools=frozenset(),timeout=timeout,max_tool_calls=1,reset=False,idle_exit=600)
        folder=code_execution_tool._env_temp_dir(env)+'/'+re.search(r'hermes_rkernel_[0-9a-f]{12}','\n'.join(scripts)).group(0)
        self.addCleanup(lambda:[os.kill(pid,9) for pid in runners(folder)])
        for _ in range(60):
            if not runners(folder):break
            time.sleep(.05)
        self.assertEqual(runners(folder),[],'no kernel is left running in the box')
        kills=[match.group(1) for script in scripts if (match:=re.search(r'pkill -TERM -P (\d+) 2>/dev/null; kill \1',script))]
        self.assertEqual(len(kills),1,'the kill reached the box');self.assertTrue(gone(int(kills[0])))
        self.assertEqual(result['status'],'timeout',result);self.assertLess(time.time(),job_box._DEADLINE)

    def test_a_step_whose_box_is_down_is_not_sealed(self):
        self.box.stop()
        with sealed_env(self.box.path):
            with self.assertRaisesRegex(RuntimeError,'job_box_unavailable'):job_box.seal(self.names,self.deadline)
            self.assertIsNone(job_box._STEP);self.assertTrue(self.blocked('terminal'))

    def test_the_plugin_adds_the_backend_only_where_the_box_socket_is(self):
        from services.hermes import register
        class Context:
            def __init__(self):self.calls=[]
            def __getattr__(self,name):return lambda *args,**kwargs:self.calls.append((name,args))
        for socket_path,backend in (('',False),(self.box.path,True)):
            with self.subTest(backend=backend),patch.dict(os.environ,{'NOCHEH_BOX_SOCKET':socket_path,'NOCHEH_CAPTURE_ENABLED':'0'}):
                context=Context();register(context)
                self.assertIn(('register_hook',('pre_tool_call',job_box.tool_gate)),context.calls)
                providers=[args[0] for name,args in context.calls if name=='register_terminal_environment_provider']
                self.assertEqual([type(item) for item in providers],[job_box.Provider] if backend else [])


class BoxStepTests(unittest.TestCase):
    def test_a_box_step_needs_the_isolated_turn_and_the_box_in_both_directions(self):
        from services.hermes.assistant_turn import box_step
        step=lambda box:{'channel':'background','background':{'max_iterations':20,'box':box}}
        sealed={'NOCHEH_ISOLATED_TURN':'1','NOCHEH_BOX_SOCKET':'/box/exec.sock','TERMINAL_ENV':'nocheh_box'}
        cases=[(step(True),sealed,True),(step(False),{},False),({'channel':'telegram'},{},False),
               (step(True),{**sealed,'NOCHEH_ISOLATED_TURN':'0'},None),(step(True),{**sealed,'NOCHEH_BOX_SOCKET':''},None),
               (step(True),{**sealed,'TERMINAL_ENV':'local'},None),(step(True),{},None),
               (step(False),sealed,None),(step(False),{'TERMINAL_ENV':'nocheh_box'},None),({'channel':'telegram'},{'NOCHEH_BOX_SOCKET':'/box/exec.sock'},None),
               ({'channel':'background','review':True,'background':{'box':True}},sealed,None)]
        for body,environment,expected in cases:
            with self.subTest(body=body,environment=environment),patch.dict(os.environ,{'NOCHEH_ISOLATED_TURN':'','NOCHEH_BOX_SOCKET':'','TERMINAL_ENV':'',**environment}):
                if expected is None:
                    with self.assertRaisesRegex(ValueError,'job_box_unavailable'):box_step(body)
                else:self.assertIs(box_step(body),expected)
        with self.assertRaisesRegex(ValueError,'invalid_background_run'):box_step(step('true'))

    def test_box_toolsets_offer_exactly_the_box_tools(self):
        from hermes_constants import set_hermes_home_override,reset_hermes_home_override
        from hermes_cli.plugins import discover_plugins
        from model_tools import get_tool_definitions
        from services.hermes.assistant_turn import BACKGROUND_TOOLS,BOX_TOOLS,BOX_TOOLSETS,turn_tools,verify_profile_tools
        from services.hermes.test_scopes import JOB_BOX_TOOLS
        from services.hermes.profile_config import atomic_yaml,resolved
        self.assertNotIn('memory',BOX_TOOLSETS);self.assertEqual(BOX_TOOLS-BACKGROUND_TOOLS,job_box.TOOLS)
        self.assertEqual(BACKGROUND_TOOLS-BOX_TOOLS,{'memory','mcp__nocheh__shell','mcp__nocheh__browser'});self.assertIn('mcp__nocheh__mcp',BOX_TOOLS)
        with tempfile.TemporaryDirectory() as folder,sealed_env('/box/exec.sock'):
            profile=Path(folder);atomic_yaml(profile/'config.yaml',resolved({},'synthetic'))
            (profile/'plugins').mkdir();(profile/'plugins'/'nocheh').symlink_to(Path(job_box.__file__).parent,target_is_directory=True)
            token=set_hermes_home_override(str(profile))
            try:
                discover_plugins()
                from services.hermes import mcp_fixture
                with mcp_fixture.connected():
                    names={item['function']['name'] for item in get_tool_definitions(enabled_toolsets=BOX_TOOLSETS,quiet_mode=True)}
                removed,allowed=turn_tools(True,True)
                self.assertEqual(names-removed,JOB_BOX_TOOLS);self.assertEqual(allowed,JOB_BOX_TOOLS);self.assertEqual(BOX_TOOLS,JOB_BOX_TOOLS)
                verify_profile_tools(names-removed,allowed)
            finally:reset_hermes_home_override(token)



# One box step through assistant_turn.run, in its own process as in production: the real in-box
# server on a temporary socket, Nocheh's data tools at a made-up MCP endpoint whose page is oversized,
# and the step's model outside.
TURN='''import json,os,sys,threading
from pathlib import Path
from unittest.mock import patch
from tools.runtime import box_server
body,folder=json.loads(sys.argv[1]),Path(sys.argv[2]);scripts=[];run=box_server.run
def recorded(conn,where,script,*rest):
    scripts.append(script);return run(conn,where,script,*rest)
box_server.run=recorded
server=box_server.listen(str(folder/'exec.sock'),os.getgid());threading.Thread(target=box_server.serve,args=(server,-1),daemon=True).start()
os.environ.update(NOCHEH_ISOLATED_TURN='1',TERMINAL_ENV='nocheh_box',NOCHEH_BOX_SOCKET=str(folder/'exec.sock'),TERMINAL_CWD=str(folder/'work'))
from services.hermes import archive_tools,assistant_turn,job_box,request_boundary,subscription
archive=lambda path,value=None:value if path=='/v1/context/prepare' else {'hits':[]}
install=request_boundary.install
with patch.object(request_boundary,'install',lambda:install(request_boundary.Boundary('on',transform=lambda url,payload:payload))),\\
     patch.object(subscription,'configured_urls',lambda:{body['base_url']}),patch.object(archive_tools,'request',archive):
    lines=[]
    try:result=assistant_turn.run(body,None,lines.append)
    except Exception as error:result={'raised':str(error)}
(folder/'result.json').write_text(json.dumps({'result':result,'scripts':scripts,'step':sorted(job_box._STEP or []),'deadline':job_box._DEADLINE,'lines':lines}))
'''


class BoxTurnTests(unittest.TestCase):
    def test_a_box_step_runs_exactly_the_box_tools_and_its_commands_in_the_box(self):
        import subprocess,sys
        from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
        from services.hermes import mcp_fixture
        from services.hermes.assistant_turn import BOX_TOOLS
        from services.hermes.profile_config import atomic_yaml,resolved
        sent=[]
        calls=[{'name':'mcp__nocheh__archive_page','arguments':'{}'},
               {'name':'terminal','arguments':json.dumps({'command':'echo "Alice: hello" > marker.txt; pwd; echo "home=$HERMES_HOME."'})}]
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
        page=lambda name,arguments:{'records':[{'text':'Alice: hello. '*20000}],'next':None} if name=='archive_page' else {}
        try:
            with tempfile.TemporaryDirectory() as folder,mcp_fixture.Endpoint(page) as endpoint:
                folder=Path(folder);profile=folder/'profile';(profile/'native-state').mkdir(parents=True);(profile/'memories').mkdir();(folder/'work').mkdir()
                atomic_yaml(profile/'config.yaml',resolved({},'synthetic'))
                (profile/'plugins').mkdir();(profile/'plugins'/'nocheh').symlink_to(Path(job_box.__file__).parent,target_is_directory=True)
                body={'session_id':'s','chat_id':'5','user_id':'5','owner':True,'text':'Count the lines.','channel':'background',
                      'background':{'max_iterations':5,'box':True,'soft_deadline':time.time()+100,'rates':{'input':2,'output':10,'cache_read':None,'cache_write':None,'request':None},
                                    'cost_limit_usd':5,'prior_cost_usd':0},
                      'model':'synthetic','api_key':'synthetic','base_url':'http://127.0.0.1:%d/v1'%server.server_address[1],'provider':'openai','api_mode':'chat_completions',
                      'archive_credential':'turn.synthetic','turn_deadline_epoch':time.time()+120,'model_context_length':128000}
                child=subprocess.run([sys.executable,'-c',TURN,json.dumps(body),str(folder)],cwd=Path(__file__).resolve().parents[2],
                                     env={**os.environ,'HERMES_HOME':str(profile),'ARCHIVE_URL':endpoint.url},capture_output=True,text=True,timeout=240)
                self.assertEqual(child.returncode,0,child.stderr[-2000:])
                outcome=json.loads((folder/'result.json').read_text());marker=(folder/'work'/'marker.txt').read_text()
        finally:server.shutdown();server.server_close()
        self.assertEqual((outcome['result'].get('state'),outcome['result'].get('text')),('done','Report: done'),outcome['result'])
        steps=[payload for payload in sent if payload.get('tools')]
        self.assertEqual([{tool['function']['name'] for tool in payload['tools']} for payload in steps],[set(BOX_TOOLS)]*3)
        self.assertNotIn('mcp__nocheh__background_job',BOX_TOOLS,'a box step has no job tool')
        self.assertEqual(outcome['step'],sorted(BOX_TOOLS))
        self.assertEqual(outcome['deadline'],body['turn_deadline_epoch'],'the box ends with this run, not later')
        # Each model call of the run went out as a progress line, with the run's totals so far.
        from services.hermes.job_progress import progress_line
        lines=outcome['lines'];self.assertGreaterEqual(len(lines),4)
        for line in lines:progress_line(line,len(json.dumps(line,ensure_ascii=False).encode())+1)
        self.assertGreaterEqual(lines[-1]['tokens']['calls'],3);self.assertEqual(lines[-1]['tokens']['input_tokens'],10*lines[-1]['tokens']['calls'])
        page,terminal=[json.dumps(message['content']) for message in steps[-1]['messages'] if message.get('role')=='tool']
        # An oversized result before any box command keeps its inline preview, with no path the box cannot open.
        self.assertIn('Full output could not be saved to sandbox',page);self.assertNotIn('Full output saved to',page)
        self.assertEqual(marker,'Alice: hello\n');self.assertIn(str(folder/'work'),terminal);self.assertIn('home=.',terminal)
        self.assertTrue(any('marker.txt' in script for script in outcome['scripts']))
        # The data tools came from Nocheh's endpoint with the run's own credential and deadline, and the page call went there.
        self.assertEqual({(request['authorization'],request['deadline']) for request in endpoint.requests},
                         {('Bearer turn.synthetic',str(int(body['turn_deadline_epoch'])))})
        self.assertEqual([request['params'] for request in endpoint.requests if request['method']=='tools/call'],[{'name':'archive_page','arguments':{}}])

    def test_a_step_without_its_box_reports_job_box_unavailable(self):
        # As the launcher runs a box step it could not make the box for: System › Background work shows this code.
        import subprocess,sys
        body={'session_id':'s','text':'Count the lines.','channel':'background','background':{'max_iterations':5,'box':True},'archive_credential':'turn.synthetic'}
        with tempfile.TemporaryDirectory() as folder:
            environment={**os.environ,'HERMES_HOME':folder,'NOCHEH_ISOLATED_TURN':'','NOCHEH_BOX_SOCKET':'','TERMINAL_ENV':''}
            child=subprocess.run([sys.executable,'-m','services.hermes.assistant_turn'],input=json.dumps(body),cwd=Path(__file__).resolve().parents[2],
                                 env=environment,capture_output=True,text=True,timeout=120)
        self.assertEqual(child.returncode,0,child.stderr[-2000:])
        result=json.loads(child.stdout.splitlines()[-1])
        self.assertEqual((result['state'],result['error_code'],result['error_stage']),('failed','job_box_unavailable','box_step'))

    def test_a_step_that_disagrees_with_its_environment_stops_before_the_agent_runs(self):
        from services.hermes import assistant_turn
        step=lambda box:{'session_id':'s','text':'Count the lines.','channel':'background','background':{'max_iterations':5,'box':box}}
        for box,environment in ((False,{'NOCHEH_ISOLATED_TURN':'1','NOCHEH_BOX_SOCKET':'/box/exec.sock','TERMINAL_ENV':'nocheh_box'}),(True,{'NOCHEH_ISOLATED_TURN':'1'})):
            with self.subTest(box=box),patch.dict(os.environ,{'NOCHEH_BOX_SOCKET':'','TERMINAL_ENV':'',**environment}),\
                 patch.object(assistant_turn,'sealed_dependencies',side_effect=AssertionError('the agent was started')):
                with self.assertRaisesRegex(ValueError,'job_box_unavailable'):assistant_turn.run(step(box))


if __name__=='__main__':unittest.main()
