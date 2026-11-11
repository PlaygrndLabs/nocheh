import base64
import hashlib
import http.client
import json
import os
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.runtime import machine_server as ms

TOKEN='m'*40
MACHINE='0123456789abcdef0123456789abcdef'
# A made-up ed25519 host key and its fingerprint, as ssh-keygen -l prints it.
BLOB=struct.pack('>I',11)+b'ssh-ed25519'+struct.pack('>I',32)+bytes(range(32))
HOST_KEY='SHA256:'+base64.b64encode(hashlib.sha256(BLOB).digest()).decode().rstrip('=')
OTHER='SHA256:'+'A'*43
TARGET={'id':MACHINE,'address':'192.0.2.10','port':2222,'login':'nocheh'}
# A stand-in ssh: it logs its arguments, plays the scenario the test wrote, and for 'run' runs the remote command
# here with the login's shell (sh, or the scenario's), so quoting, the marker, the wrapper and exit codes are the real
# ones. It never runs a cleanup script.
FAKE='''#!{python}
import json,os,sys,time
here=os.path.dirname(os.path.abspath(__file__))
args=sys.argv[1:]
with open(os.path.join(here,'calls.jsonl'),'a') as log:log.write(json.dumps(args)+'\\n')
with open(os.path.join(here,'environment.json'),'w') as file:json.dump(sorted(os.environ),file)
if '-O' in args or '-V' in args:
    if '-V' in args:sys.stderr.write('OpenSSH_10.0p2 fake\\n')
    sys.exit(0)
with open(os.path.join(here,'scenario.json')) as file:scenario=json.load(file)
options=dict(args[i+1].split('=',1) for i,a in enumerate(args) if a=='-o')
end=args.index('--');address,remote=args[end+1],args[end+2];port=args[args.index('-p')+1]
with open(os.path.join(here,'pid'),'w') as file:file.write(str(os.getpid()))
known=options['UserKnownHostsFile'];mode=scenario.get('mode','run')
sys.stderr.write(scenario.get('before',''));sys.stderr.flush()
if mode=='fail':sys.exit(255)
if mode=='hang':time.sleep(60);sys.exit(0)
if options['StrictHostKeyChecking']=='accept-new' and not os.path.exists(known):
    with open(known,'w') as file:file.write('[%s]:%s ssh-ed25519 %s\\n'%(address,port,scenario['host_key']))
    sys.stderr.write("Warning: Permanently added '[%s]:%s' (ED25519) to the list of known hosts.\\n"%(address,port))
elif not os.path.exists(known):
    sys.stderr.write('Host key verification failed.\\n');sys.exit(255)
sys.stdout.write(scenario.get('noise',''));sys.stdout.flush()
shell=scenario.get('shell','sh');env=dict(os.environ,**scenario.get('env',{{}}))
if 'ps -o pid=' in remote:
    os.execvpe(shell,[shell,'-c',remote.split(';',1)[0]+'; %s; exit %d'%(scenario.get('cleanup',':'),scenario.get('code',0))],env)
if mode=='killed':os.execvpe(shell,[shell,'-c',remote.split(';',1)[0]+'; echo ending; kill -9 $$'],env)
os.execvpe(shell,[shell,'-c',remote],env)
'''


def frames(data):
    found=[];at=0
    while at<len(data):
        size=struct.unpack('>I',data[at+1:at+5])[0];found.append((data[at:at+1],data[at+5:at+5+size]));at+=5+size
    return found


def result(data):
    found=frames(data)
    return b''.join(value for kind,value in found if kind==b'O'),struct.unpack('>i',found[-1][1])[0] if found and found[-1][0]==b'X' else None


def alive(pid):
    try:return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[0]!='Z'
    except (OSError,IndexError):return False


class MachineServerTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup);base=Path(folder.name)
        self.bin=base/'bin';self.bin.mkdir();self.root=base/'machines';self.root.mkdir(mode=0o700)
        (self.bin/'ssh').write_text(FAKE.format(python=sys.executable));(self.bin/'ssh').chmod(0o755)
        self.control=base/'control';self.control.mkdir()
        for name,value in (('CONTROL',self.control),('GRACE',1),('SHORT',5)):
            patcher=patch.object(ms,name,value);patcher.start();self.addCleanup(patcher.stop)
        patcher=patch.dict(os.environ,{'PATH':str(self.bin)+os.pathsep+os.environ.get('PATH','')});patcher.start();self.addCleanup(patcher.stop)
        self.scenario({})
        self.server=self.serve(TOKEN)

    def serve(self,token):
        server=ms.Server(('127.0.0.1',0),ms.Machines(self.root,token))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        return server

    def scenario(self,value):(self.bin/'scenario.json').write_text(json.dumps({'host_key':base64.b64encode(BLOB).decode(),**value}))

    def calls(self):
        path=self.bin/'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def machine(self,known=True):
        folder=self.root/MACHINE;folder.mkdir(mode=0o700,exist_ok=True)
        (folder/'key').write_text('made-up private key\n');(folder/'key').chmod(0o600)
        (folder/'key.pub').write_text('ssh-ed25519 AAAAmadeup nocheh build-vm\n')
        if known:(folder/'known_hosts').write_text('[192.0.2.10]:2222 ssh-ed25519 '+base64.b64encode(BLOB).decode()+'\n')
        return folder

    def post(self,path,body,token=TOKEN,server=None):
        connection=http.client.HTTPConnection('127.0.0.1',(server or self.server).server_address[1],timeout=30)
        headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+token} if token is not None else {})}
        connection.request('POST',path,json.dumps(body),headers);response=connection.getresponse()
        data=response.read();connection.close()
        return response.status,(json.loads(data) if response.getheader('Content-Type')=='application/json' else data)

    def run_script(self,script,stdin=None,timeout=30,login=False,**extra):
        return self.post('/exec',{**TARGET,'host_key':HOST_KEY,'script':script,'stdin':stdin,'timeout':timeout,'login_shell':login,**extra})

    def test_health_needs_no_token_and_every_other_route_needs_the_right_one(self):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_address[1],timeout=10)
        connection.request('GET','/health');response=connection.getresponse()
        self.assertEqual((response.status,json.loads(response.read())),(200,{'ok':True,'service':'machines','ssh':'OpenSSH_10.0p2 fake'}))
        self.machine()
        for token in (None,'','Bearer','m'*39,'n'*40):
            self.assertEqual(self.post('/forget',{'id':MACHINE},token=token),(401,{'error':'unauthorized'}))
        self.assertTrue((self.root/MACHINE/'known_hosts').exists(),'a refused request changes nothing')
        self.assertEqual(self.post('/forget',{'id':MACHINE}),(200,{'ok':True}))
        # Without a token of at least 32 characters every route refuses as unavailable, whatever the caller sends.
        for token in ('','t'*31):
            server=self.serve(token)
            for path,body in (('/keys',{'id':MACHINE,'comment':'nocheh build-vm'}),('/exec',{}),('/remove',{'id':MACHINE})):
                self.assertEqual(self.post(path,body,token=token,server=server),(503,{'error':'machine_unavailable'}))
        self.assertTrue((self.root/MACHINE).exists())
        self.assertEqual(self.calls(),[['-V']])

    def test_health_fails_when_ssh_cannot_run_as_this_uid(self):
        # Without a passwd entry for its uid ssh -V says so and exits 255: nothing could connect, so health says no.
        (self.bin/'ssh').write_text('#!/bin/sh\necho "No user exists for uid 4243" >&2\nexit 255\n')
        connection=http.client.HTTPConnection('127.0.0.1',self.serve(TOKEN).server_address[1],timeout=10)
        connection.request('GET','/health');response=connection.getresponse()
        self.assertEqual((response.status,json.loads(response.read())),(503,{'ok':False,'service':'machines','ssh':None}))

    def test_requests_are_checked_before_ssh_runs(self):
        self.machine()
        bad=[{**TARGET,'id':MACHINE.upper()},{**TARGET,'id':'../'+MACHINE[3:]},{**TARGET,'address':'-oProxyCommand=sh'},
             {**TARGET,'address':'build vm'},{**TARGET,'address':''},{**TARGET,'address':'a'*254},{**TARGET,'address':'user@192.0.2.10'},
             {**TARGET,'port':0},{**TARGET,'port':65536},{**TARGET,'port':True},{**TARGET,'port':'22'},
             {**TARGET,'login':'Root'},{**TARGET,'login':'-l'},{**TARGET,'login':'a'*33},{**TARGET,'login':None}]
        for target in bad:
            self.assertEqual(self.post('/test',{**target,'host_key':None}),(400,{'error':'invalid_machine_request'}),target)
            self.assertEqual(self.run_script('true',**target),(400,{'error':'invalid_machine_request'}),target)
        for extra in ({'host_key':'SHA256:short'},{'host_key':None},{'timeout':0},{'timeout':3601},{'timeout':1.5},{'login_shell':1},
                      {'script':'a\x00b'},{'script':None},{'stdin':5},{'stdin':'x'*(4<<20|1)}):
            self.assertEqual(self.post('/exec',{**TARGET,'host_key':HOST_KEY,'script':'true','stdin':None,'timeout':5,'login_shell':False,**extra}),
                             (400,{'error':'invalid_machine_request'}),extra)
        self.assertEqual(self.post('/test',{**TARGET,'host_key':None,'extra':1}),(400,{'error':'invalid_machine_request'}))
        self.assertEqual(self.post('/test',TARGET),(400,{'error':'invalid_machine_request'}))
        self.assertEqual(self.post('/keys',{'id':MACHINE,'comment':'-x'}),(400,{'error':'invalid_machine_request'}))
        self.assertEqual(self.post('/forget',{'id':'x'}),(400,{'error':'invalid_machine_request'}))
        self.assertEqual(self.post('/nothing',{}),(404,{'error':'not_found'}))
        # The script is one remote argument: too long, also once quoted or with the wrapper, is refused before ssh runs.
        self.assertEqual(self.run_script('x'*(96*1024+1)),(409,{'error':'machine_script_too_long'}))
        self.assertEqual(self.run_script("'"*(40*1024)),(409,{'error':'machine_script_too_long'}))
        self.assertGreater(len(ms.WRAP),300)
        self.assertEqual(self.run_script("'"*((ms.MAX_REMOTE-200)//4)),(409,{'error':'machine_script_too_long'}))
        self.assertEqual(self.calls(),[])

    def test_exec_streams_what_follows_the_marker_and_ends_with_the_exit_code(self):
        self.machine();self.scenario({'noise':'Welcome to build-vm\nlast login: never\n','before':'Warning: something about the network\n'})
        with patch.dict(os.environ,{'NOCHEH_MACHINE_TOKEN':TOKEN,'SSH_AUTH_SOCK':'/tmp/made-up-agent','SERVICE_TOKEN':'s'*40}):
            status,data=self.run_script("printf 'it'\"'\"'s here\\n'; printf 'err\\n' >&2; exit 3")
        self.assertEqual((status,result(data)),(200,(b"it's here\nerr\n",3)))
        # ssh, and so the machine, gets no token, agent or other setting of this service.
        extra=set(json.loads((self.bin/'environment.json').read_text()))-{'PATH','HOME','LANG','LC_CTYPE'}
        self.assertTrue(not extra,f'ssh got {len(extra)} more environment variables')
        self.assertEqual([kind for kind,_ in frames(data)][-1:],[b'X']);self.assertEqual({kind for kind,_ in frames(data)},{b'O',b'X'})
        argv=self.calls()[-1];end=argv.index('--')
        self.assertEqual(argv[:2],['-F','/dev/null']);self.assertEqual(argv[end+1],'192.0.2.10')
        self.assertEqual(argv[argv.index('-p')+1:argv.index('-p')+4],['2222','-l','nocheh'])
        options=[argv[i+1] for i,value in enumerate(argv) if value=='-o']
        for option in ('IdentitiesOnly=yes','BatchMode=yes','StrictHostKeyChecking=yes','GlobalKnownHostsFile=/dev/null','ConnectTimeout=10',
                       'UserKnownHostsFile='+str(self.root/MACHINE/'known_hosts'),'ControlMaster=auto','ControlPersist=60',
                       f'ControlPath={self.control}/cm-{MACHINE}-%C'):
            self.assertIn(option,options)
        self.assertEqual(argv[argv.index('-i')+1],str(self.root/MACHINE/'key'));self.assertIn('-n',argv[:end])
        # The login's shell gets the marker, then the fixed wrapper with the time limit, the login flag and the script.
        self.assertRegex(argv[end+2],r"^printf '%s' '\x1enocheh-[0-9a-f]{16}\x1e'; exec bash --norc -c '")
        self.assertTrue(argv[end+2].endswith(" nocheh 30 '' "+ms.quote(b"printf 'it'\"'\"'s here\\n'; printf 'err\\n' >&2; exit 3").decode()))
        self.assertIn(ms.quote(ms.WRAP).decode(),argv[end+2])
        # stdin goes to the command; a remote 255 stays 255; -l asks for a login shell.
        status,data=self.run_script('cat; exit 255',stdin='from stdin ✓')
        self.assertEqual((status,result(data)),(200,('from stdin ✓'.encode(),255)))
        self.assertNotIn('-n',self.calls()[-1])
        status,data=self.run_script('shopt -q login_shell && echo login',login=True)
        self.assertIn(b'login\n',result(data)[0]);self.assertIn(" nocheh 30 -l '",self.calls()[-1][-1])
        status,data=self.run_script('shopt -q login_shell && echo login')
        self.assertEqual(result(data),(b'',1))
        # A script killed by a signal ends with 128 and its number, as bash says it; so does an ssh ended by one, never
        # with a negative code.
        status,data=self.run_script('echo ending; kill -9 $$')
        self.assertEqual((status,result(data)),(200,(b'ending\n',137)))
        self.scenario({'mode':'killed'})
        status,data=self.run_script('echo never')
        self.assertEqual((status,result(data)),(200,(b'ending\n',137)))

    def started(self,output):
        """The PID a script printed first, ended when the test ends."""
        pid=int(output.split()[0])
        def end():
            try:os.kill(pid,9)
            except OSError:pass
        self.addCleanup(end)
        return pid

    def test_a_program_left_running_does_not_hold_the_reply(self):
        self.machine();started=time.monotonic()
        status,data=self.run_script('sleep 30 & echo $!; echo started')
        output,code=result(data);pid=self.started(output)
        self.assertEqual((status,output.split()[1:],code),(200,[b'started'],0))
        self.assertLess(time.monotonic()-started,3);self.assertTrue(alive(pid),'the program keeps running')
        # Hermes's own background start on a remote backend (tools/process_registry.py spawn_via_env), as it sends it.
        with tempfile.TemporaryDirectory() as folder:
            log,pid_path,exit_path=(f'{folder}/hermes_bg_x.{ext}' for ext in ('log','pid','exit'))
            command=(f"mkdir -p {folder} && ( nohup bash -lc 'sleep 1; echo done' > {log} 2>&1; rc=$?; printf '%s\\n' \"$rc\" > {exit_path} ) & "
                     f"echo $! > {pid_path} && cat {pid_path}")
            started=time.monotonic();status,data=self.run_script(command)
            output,code=result(data);pid=self.started(output)
            self.assertEqual((status,code),(200,0));self.assertLess(time.monotonic()-started,3);self.assertTrue(alive(pid))
            deadline=time.monotonic()+10
            while not Path(exit_path).exists() and time.monotonic()<deadline:time.sleep(.05)
            self.assertEqual((Path(exit_path).read_text(),Path(log).read_text().splitlines()[-1]),('0\n','done'))
        # Output written just before the script ends arrives in full, also while a program it started still runs.
        status,data=self.run_script('sleep 30 & echo $!; head -c 300000 /dev/zero | tr "\\0" a; echo; echo end; exit 6')
        output,code=result(data);self.started(output)
        self.assertEqual((status,output.split(b'\n',1)[1],code),(200,b'a'*300000+b'\nend\n',6))
        # stdin reaches the script, also with a program left running.
        status,data=self.run_script('sleep 30 & echo $!; cat',stdin='from stdin\n')
        output,code=result(data);self.started(output)
        self.assertEqual((status,output.split(b'\n',1)[1],code),(200,b'from stdin\n',0))

    def test_the_wrapper_keeps_the_script_as_it_is(self):
        self.machine()
        # A script that closes its own output, or execs another program.
        self.assertEqual(result(self.run_script('exec >&- 2>&-; sleep 1; exit 5')[1]),(b'',5))
        self.assertEqual(result(self.run_script("exec sh -c 'echo from exec; exit 6'")[1]),(b'from exec\n',6))
        self.assertEqual(result(self.run_script('ls /proc/$$/fd; exit 0')[1]),(b'0\n1\n2\n',0),'only stdin, stdout and stderr')
        # set -e and set -u from an exported SHELLOPTS hold for the script, and the wrapper still ends the reply.
        self.scenario({'env':{'SHELLOPTS':'errexit:nounset'}})
        self.assertEqual(result(self.run_script('false; echo never')[1]),(b'',1))
        started=time.monotonic();output,code=result(self.run_script('sleep 30 & echo $!; echo $unset_name')[1]);self.started(output)
        self.assertEqual((code,output.split(b'\n',1)[1]),(1,b'bash: line 1: unset_name: unbound variable\n'))
        self.assertLess(time.monotonic()-started,3)
        # A bash login shell that prints from ~/.bashrc, as one sshd starts does: the noise comes before the marker only.
        with tempfile.TemporaryDirectory() as home:
            (Path(home)/'.bashrc').write_text('echo bashrc noise\n');(Path(home)/'.profile').write_text('echo profile noise\n')
            self.scenario({'shell':'bash','env':{'HOME':home,'SSH_CLIENT':'192.0.2.1 50000 22'}})
            self.assertEqual(result(self.run_script('echo clean; exit 2')[1]),(b'clean\n',2))
            # A login shell for the script reads ~/.profile, whose output is then part of the command's.
            self.assertEqual(result(self.run_script('echo clean',login=True)[1]),(b'profile noise\nclean\n',0))
        # The script's output goes through the FIFO; without mkfifo on the machine it runs as before, straight on ssh's
        # channel, where a program left running would hold the reply.
        self.scenario({})
        self.assertRegex(result(self.run_script('readlink /proc/$$/fd/1; exit 0')[1])[0],rb'^/.*/nocheh\.[A-Za-z0-9]{10}/o \(deleted\)\n$')
        (self.bin/'mkfifo').write_text('#!/bin/sh\nexit 1\n');(self.bin/'mkfifo').chmod(0o755)
        self.assertEqual(result(self.run_script('cat; exit 4',stdin='plain')[1]),(b'plain',4))
        self.assertRegex(result(self.run_script('readlink /proc/$$/fd/1; exit 0')[1])[0],rb'^pipe:')

    def test_long_output_is_framed_and_capped(self):
        self.machine()
        status,data=self.run_script('head -c 3000000 /dev/zero | tr "\\0" a; echo; echo done')
        found=frames(data);output=b''.join(value for kind,value in found if kind==b'O')
        self.assertEqual((status,output,found[-1]),(200,b'a'*3000000+b'\ndone\n',(b'X',struct.pack('>i',0))))
        # stdout and stderr arrive complete and in the order the script wrote them.
        status,data=self.run_script('for i in $(seq 1 30000); do printf "%070d\\n" $i; [ $((i%1000)) = 0 ] && echo e$i >&2; done; true')
        expected=b''.join(b'%070d\n'%i+(b'e%d\n'%i if i%1000==0 else b'') for i in range(1,30001))
        self.assertEqual((status,result(data)),(200,(expected,0)))
        self.assertTrue(all(len(value)<=1<<20 for _,value in found))
        # The output frames, each with its 5-byte head, stay within the cap, also when the output comes a line at a time:
        # the relay counts the heads too.
        for script,line in (('head -c 50000 /dev/zero | tr "\\0" b; exit 4',b'b'*50000),
                            ('for i in $(seq 100 400); do echo "Alice: $i"; sleep .002; done; exit 4',b''.join(b'Alice: %d\n'%i for i in range(100,401)))):
            with self.subTest(script=script),patch.object(ms,'MAX_OUTPUT',1000):
                status,data=self.run_script(script);found=frames(data);output=b''.join(value for kind,value in found[:-2])
                self.assertEqual(found[-2:],[(b'O',b'\n[machine: output capped at 8 MiB]\n'),(b'X',struct.pack('>i',4))])
                framed=sum(5+len(value) for _,value in found[:-2]);self.assertTrue(line.startswith(output));self.assertTrue(995<=framed<=1000,framed)
        self.assertGreater(len(found),20,'one frame a line')

    def test_a_failure_before_the_marker_is_named_and_answers_502(self):
        self.machine()
        for text,code in (('nocheh@192.0.2.10: Permission denied (publickey).\r\n','machine_auth_failed'),
                          ('@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n','machine_host_key_changed'),
                          ('ssh: connect to host 192.0.2.10 port 2222: Connection refused\n','machine_unreachable'),
                          ('ssh: connect to host 192.0.2.10 port 2222: No route to host\n','machine_unreachable'),
                          ('ssh: Could not resolve hostname build-vm: Name or service not known\n','machine_unreachable'),
                          ('ssh: connect to host 192.0.2.10 port 2222: Connection timed out\n','machine_unreachable'),
                          ('No user exists for uid 4243\n','machine_unreachable')):
            self.scenario({'mode':'fail','before':text})
            self.assertEqual(self.run_script('echo never'),(502,{'error':code}),text)
            self.assertEqual(self.post('/test',{**TARGET,'host_key':HOST_KEY})[1]['error'],code)
            self.assertEqual(self.post('/cleanup',{**TARGET,'host_key':HOST_KEY}),(200,{'ok':False,'error':code}))
        detail=self.post('/test',{**TARGET,'host_key':HOST_KEY})[1]['detail']
        self.assertEqual(detail,'No user exists for uid 4243')
        # A shell that prints and prints but never reaches the marker is ended too.
        self.scenario({'noise':'x'*(70*1024)})
        with patch.object(ms,'GRACE',30):self.assertEqual(self.run_script('echo never',timeout=1),(502,{'error':'machine_unreachable'}))

    def test_the_time_limit_ends_the_command_on_the_machine_with_124(self):
        # The machine itself ends the script and the programs it started at the time limit, before nocheh-machines would.
        self.machine();started=time.monotonic()
        with patch.object(ms,'GRACE',30):status,data=self.run_script('sleep 30 & echo $!; echo started; sleep 30',timeout=1)
        output,code=result(data);pid=int(output.split()[0])
        self.assertEqual((status,output.split()[1:],code),(200,[b'started'],124))
        self.assertLess(time.monotonic()-started,10);self.assertFalse(alive(int((self.bin/'pid').read_text())))
        deadline=time.monotonic()+5
        while alive(pid) and time.monotonic()<deadline:time.sleep(.05)
        self.assertFalse(alive(pid),'the program the script started ended too')
        # Without coreutils' timeout on the machine, nocheh-machines ends ssh after its grace.
        (self.bin/'timeout').write_text('#!/bin/sh\necho "timeout: unrecognized option" >&2\nexit 1\n');(self.bin/'timeout').chmod(0o755)
        status,data=self.run_script('echo started; sleep 30',timeout=1)
        self.assertEqual((status,result(data)),(200,(b'started\n',124)))
        self.assertLess(time.monotonic()-started,15);self.assertFalse(alive(int((self.bin/'pid').read_text())))
        # Before the marker the time limit answers 502.
        self.scenario({'mode':'hang'})
        self.assertEqual(self.run_script('echo never',timeout=1),(502,{'error':'machine_timeout'}))
        self.assertFalse(alive(int((self.bin/'pid').read_text())))

    def test_a_client_that_goes_away_ends_ssh(self):
        self.machine();folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup);script=Path(folder.name)/'script'
        body=json.dumps({**TARGET,'host_key':HOST_KEY,'script':f'echo $$ >{script}; echo started; sleep 30','stdin':None,'timeout':60,
                         'login_shell':False}).encode()
        def end():
            # Here the "machine" is this one: end the script, which on a machine keeps running until the time limit.
            try:os.killpg(os.getpgid(int(script.read_text())),9)
            except (OSError,ValueError):pass
        for wait_for_output in (True,False):
            self.addCleanup(end)
            client=socket.create_connection(('127.0.0.1',self.server.server_address[1]),timeout=10)
            client.sendall(b'POST /exec HTTP/1.1\r\nHost: machines\r\nAuthorization: Bearer '+TOKEN.encode()+
                           b'\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n'%len(body)+body)
            if wait_for_output:
                seen=b''
                while b'started' not in seen:
                    chunk=client.recv(4096);self.assertTrue(chunk);seen+=chunk
                self.assertTrue(seen.startswith(b'HTTP/1.1 200'))
            else:
                deadline=time.monotonic()+5
                while not (self.bin/'pid').exists() and time.monotonic()<deadline:time.sleep(.05)
            pid=int((self.bin/'pid').read_text());self.assertTrue(alive(pid))
            client.close();deadline=time.monotonic()+5
            while alive(pid) and time.monotonic()<deadline:time.sleep(.05)
            self.assertFalse(alive(pid));(self.bin/'pid').unlink();end()

    def test_cleanup_runs_the_fixed_script_and_reports_how_it_ended(self):
        self.machine()
        self.assertEqual(self.post('/cleanup',{**TARGET,'host_key':HOST_KEY}),(200,{'ok':True}))
        remote=self.calls()[-1][-1]
        self.assertRegex(remote,r"^printf '%s' '\x1enocheh-[0-9a-f]{16}\x1e'; exec sh -c '")
        self.assertIn(ms.CLEANUP,remote.replace("'\\''","'"));self.assertIn('StrictHostKeyChecking=yes',self.calls()[-1])
        self.scenario({'code':3})
        self.assertEqual(self.post('/cleanup',{**TARGET,'host_key':HOST_KEY}),(200,{'ok':False,'error':'machine_cleanup_failed'}))
        self.assertEqual(self.post('/cleanup',{**TARGET,'host_key':OTHER}),(200,{'ok':False,'error':'machine_host_key_changed'}))
        self.assertEqual(self.post('/cleanup',{**TARGET,'host_key':None}),(400,{'error':'invalid_machine_request'}))
        # The script itself, run here as the child of a stand-in sshd session: it ends the login's other programs and
        # spares itself and that session. ps is swapped for a list of the made-up session's own processes only.
        self.assertEqual(ms.CLEANUP.count('ps -o pid= -u "$(id -u)"'),1)
        with tempfile.TemporaryDirectory() as folder:
            here=Path(folder);(here/'session.sh').write_text('sleep 30 & echo $! > "$1/sleeper"\nwhile [ ! -s "$1/pids" ]; do sleep .05; done\n'
                                                            'sh -c "$2"; echo $? > "$1/code.tmp"; mv "$1/code.tmp" "$1/code"; sleep 30\n')
            session=subprocess.Popen(['sh',str(here/'session.sh'),folder,ms.CLEANUP.replace('ps -o pid= -u "$(id -u)"','cat "$LIST"')],
                                     env={**os.environ,'LIST':str(here/'pids')},start_new_session=True)
            try:
                deadline=time.monotonic()+10
                while not (here/'sleeper').exists() and time.monotonic()<deadline:time.sleep(.05)
                sleeper=int((here/'sleeper').read_text());self.assertTrue(alive(sleeper))
                (here/'pids.tmp').write_text(f'{sleeper}\n{session.pid}\n');(here/'pids.tmp').rename(here/'pids')
                while not (here/'code').exists() and time.monotonic()<deadline:time.sleep(.05)
                self.assertEqual((here/'code').read_text().strip(),'0')
                deadline=time.monotonic()+5
                while alive(sleeper) and time.monotonic()<deadline:time.sleep(.05)
                self.assertFalse(alive(sleeper));self.assertIsNone(session.poll())
            finally:
                os.killpg(session.pid,9);session.wait()

    def test_cleanups_of_one_machine_run_one_at_a_time(self):
        # Each ends every program of the login but its own: two at once on one machine would end each other's shells.
        other='f'*32;self.machine();shutil.copytree(self.root/MACHINE,self.root/other);log=self.bin/'cleanups'
        self.scenario({'cleanup':f'echo start >>{log}; sleep .5; echo end >>{log}'})
        for machines,expected in (((MACHINE,MACHINE),['start','end','start','end']),((MACHINE,other),['start','start','end','end'])):
            log.unlink(missing_ok=True);answers=[]
            threads=[threading.Thread(target=lambda ident=ident:answers.append(self.post('/cleanup',{**TARGET,'id':ident,'host_key':HOST_KEY})))
                     for ident in machines]
            for thread in threads:thread.start()
            for thread in threads:thread.join(30)
            with self.subTest(machines=machines):
                self.assertEqual(answers,[(200,{'ok':True})]*2);self.assertEqual(log.read_text().split(),expected)

    def test_host_keys_are_trusted_only_on_a_first_test_and_must_match_after(self):
        folder=self.machine(known=False)
        self.assertEqual(self.post('/test',{**TARGET,'host_key':HOST_KEY})[1]['error'],'machine_host_key_unknown')
        self.assertEqual(self.run_script('echo never'),(502,{'error':'machine_host_key_unknown'}))
        self.assertEqual(self.calls(),[])
        # A first test trusts what the machine sends, into a fresh known_hosts: a stale one is dropped first.
        (folder/'known_hosts').write_text('[192.0.2.10]:2222 ssh-ed25519 '+base64.b64encode(b'stale').decode()+'\n')
        here=os.uname()
        self.assertEqual(self.post('/test',{**TARGET,'host_key':None}),(200,{'ok':True,'host_key':HOST_KEY,'system':f'{here.sysname} {here.release} {here.machine}'}))
        argv=self.calls()[-1]
        self.assertIn('StrictHostKeyChecking=accept-new',argv);self.assertIn('ControlPath=none',argv)
        self.assertTrue(argv[-1].endswith('; exec uname -srm'))
        self.assertEqual(ms.fingerprints(folder/'known_hosts'),{HOST_KEY})
        # After that only StrictHostKeyChecking=yes, and only when the stored key is the trusted one.
        status,answer=self.post('/test',{**TARGET,'host_key':HOST_KEY})
        self.assertEqual((status,answer['ok'],answer['host_key']),(200,True,HOST_KEY))
        self.assertIn('StrictHostKeyChecking=yes',self.calls()[-1])
        count=len(self.calls())
        self.assertEqual(self.post('/test',{**TARGET,'host_key':OTHER})[1],
                         {'ok':False,'error':'machine_host_key_changed','detail':'The stored host key is not the trusted one.'})
        self.assertEqual(self.run_script('echo never',host_key=OTHER),(502,{'error':'machine_host_key_changed'}))
        self.assertEqual(len(self.calls()),count,'a mismatched host key never connects')
        self.assertFalse(any('accept-new' in ' '.join(call) for call in self.calls() if '--' in call and 'exec bash' in call[-1]))
        # Forget drops the trusted key and the machine's shared connections; remove drops its folder.
        (self.control/f'cm-{MACHINE}-abc').write_text('');(self.control/'cm-ffffffffffffffffffffffffffffffff-abc').write_text('')
        self.assertEqual(self.post('/forget',{'id':MACHINE}),(200,{'ok':True}))
        self.assertFalse((folder/'known_hosts').exists());self.assertTrue((folder/'key').exists())
        self.assertIn(['-F','/dev/null','-o',f'ControlPath={self.control}/cm-{MACHINE}-abc','-O','exit','nocheh-machine'],self.calls())
        self.assertEqual(sorted(path.name for path in self.control.iterdir()),['cm-ffffffffffffffffffffffffffffffff-abc'])
        self.assertEqual(self.post('/remove',{'id':MACHINE}),(200,{'ok':True}));self.assertFalse(folder.exists())
        self.assertEqual(self.post('/remove',{'id':MACHINE}),(200,{'ok':True}))
        self.assertEqual(self.post('/test',{**TARGET,'host_key':None})[1]['error'],'machine_key_missing')

    def test_a_machine_without_its_key_says_so_and_never_connects(self):
        # Keys are not in backups: after a restore the store still knows the machine and its host key, but its folder or
        # key file here is gone.
        for setup in ('no folder','no key file'):
            if setup=='no key file':(self.machine()/'key').unlink()
            for host_key in (HOST_KEY,None):
                self.assertEqual(self.post('/test',{**TARGET,'host_key':host_key}),
                                 (200,{'ok':False,'error':'machine_key_missing','detail':'Nocheh has no key for this machine. Keys are not in backups.'}))
            self.assertEqual(self.run_script('echo never'),(502,{'error':'machine_key_missing'}))
            self.assertEqual(self.post('/cleanup',{**TARGET,'host_key':HOST_KEY}),(200,{'ok':False,'error':'machine_key_missing'}))
        self.assertEqual(self.calls(),[])

    def test_fingerprints_match_ssh_keygen(self):
        if not shutil.which('ssh-keygen'):self.skipTest('ssh-keygen is not installed here')
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'known_hosts';path.write_text('[192.0.2.10]:2222 ssh-ed25519 '+base64.b64encode(BLOB).decode()+'\n')
            shown=subprocess.run(['ssh-keygen','-l','-E','sha256','-f',str(path)],capture_output=True,text=True,check=True).stdout
            self.assertEqual(re.search(r'SHA256:\S+',shown).group(),HOST_KEY)

    def test_keys_are_made_once_and_only_the_public_key_leaves(self):
        if not shutil.which('ssh-keygen'):self.skipTest('ssh-keygen is not installed here')
        status,made=self.post('/keys',{'id':MACHINE,'comment':'nocheh build-vm'})
        self.assertEqual(status,200);self.assertRegex(made['public_key'],r'^ssh-ed25519 [A-Za-z0-9+/]+=* nocheh build-vm$')
        folder=self.root/MACHINE
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode),0o700);self.assertEqual(stat.S_IMODE((folder/'key').stat().st_mode),0o600)
        self.assertNotIn('PRIVATE',json.dumps(made))
        self.assertEqual(self.post('/keys',{'id':MACHINE,'comment':'nocheh renamed'}),(200,made),'an existing key is kept')
        (folder/'key.pub').unlink()
        status,again=self.post('/keys',{'id':MACHINE,'comment':'nocheh build-vm'})
        self.assertEqual(status,200);self.assertNotEqual(again,made,'a half-made key is made again')


class MachineWiringTests(unittest.TestCase):
    def compose(self,name='docker-compose.yml'):
        import yaml
        from tools.operations.installation.configuration import ROOT
        class Loader(yaml.SafeLoader):pass
        Loader.add_constructor('!reset',lambda loader,node:None)
        return yaml.load((ROOT/name).read_text(),Loader)

    def test_only_the_app_and_the_machine_service_hold_the_token_and_only_the_service_holds_the_keys(self):
        compose=self.compose();services=compose['services']
        def environment(service):
            value=service.get('environment') or {}
            return set(value) if isinstance(value,dict) else {str(item).split('=',1)[0] for item in value}
        for name,value in compose.items():
            if name.startswith('x-') and isinstance(value,dict):self.assertNotIn('NOCHEH_MACHINE_TOKEN',environment(value),name)
        self.assertEqual({name for name,service in services.items() if 'NOCHEH_MACHINE_TOKEN' in environment(service)},{'nocheh-app','nocheh-machines'})
        self.assertEqual({services[name]['environment']['NOCHEH_MACHINE_TOKEN'] for name in ('nocheh-app','nocheh-machines')},{'${NOCHEH_MACHINE_TOKEN:-}'})
        self.assertEqual(services['nocheh-app']['environment']['NOCHEH_MACHINES_URL'],'http://nocheh-machines:8789')
        mounting={name for name,service in services.items() if any(str(v).split(':')[-1]=='/machines' or '/machines:' in str(v) for v in service.get('volumes') or [])}
        self.assertEqual(mounting,{'nocheh-machines'})
        machines=services['nocheh-machines']
        self.assertEqual(machines['volumes'],['${NOCHEH_STATE_DIR:-./data/local}/machines:/machines'])
        self.assertEqual(environment(machines),{'NOCHEH_MACHINE_TOKEN'},'no service token, database password or other key')
        self.assertEqual((machines['image'],machines['build']['target'],machines['command']),('nocheh-management:local','management',['machines']))
        self.assertEqual(machines['build'],compose['x-management']['build'])
        self.assertEqual(compose['x-management']['build']['args'],{'LOCAL_UID':'${NOCHEH_UID:-1000}','LOCAL_GID':'${NOCHEH_GID:-1000}'})
        self.assertEqual((machines['user'],machines['read_only'],machines['tmpfs'],machines['cap_drop'],machines['security_opt'],machines['networks']),
                         ('${NOCHEH_UID:-1000}:${NOCHEH_GID:-1000}',True,['/tmp'],['ALL'],['no-new-privileges:true'],['default']))
        self.assertEqual(machines['extra_hosts'],['host.docker.internal:host-gateway'])
        self.assertNotIn('group_add',machines);self.assertNotIn('ports',machines)
        self.assertIn('8789/health',' '.join(machines['healthcheck']['test']))
        self.assertEqual(machines['restart'],services['nocheh-app']['restart'])
        # Nocheh keeps working when machine control is unused: nothing waits for the machine service.
        self.assertFalse([name for name,service in services.items() if 'nocheh-machines' in (service.get('depends_on') or {})])
        for name,service in services.items():
            if name!='nocheh-machines':self.assertNotIn('extra_hosts',service,name)
        development=self.compose('docker-compose.dev.yml')['services']['nocheh-machines']
        self.assertEqual(development['command'][-4:],['python3','-m','tools.runtime.container_service','machines'])
        self.assertNotIn('environment',development);self.assertNotIn('NOCHEH_MACHINE_TOKEN',json.dumps(self.compose('docker-compose.dev.yml')))

    def test_the_management_image_has_ssh_and_a_user_for_any_uid(self):
        from tools.operations.installation.configuration import ROOT
        text=(ROOT/'Dockerfile').read_text();base=text.split('AS management-base\n',1)[1].split('\nFROM ',1)[0]
        install=re.search(r'apt-get install -y --no-install-recommends ([^&]+)&&',base).group(1).split()
        self.assertIn('openssh-client',install)
        self.assertIn('ARG LOCAL_UID=1000',base);self.assertIn('getent passwd ${LOCAL_UID}',base);self.assertIn('useradd --no-log-init --uid ${LOCAL_UID}',base)
        self.assertLess(base.index('apt-get install'),base.index('ARG LOCAL_UID'),'a uid change keeps the cached packages')

    def test_the_machine_service_starts_without_the_state_folder(self):
        from tools.runtime import container_service
        with patch.dict(os.environ,{},clear=False) as env,patch('tools.runtime.machine_server.main',return_value=7) as main:
            env.pop('NOCHEH_STATE_DIR',None)
            self.assertEqual(container_service.main(['machines']),7);main.assert_called_once_with()

    def test_init_and_make_dev_make_the_token_and_the_keys_folder(self):
        from tools.operations.installation.configuration import initialize,validate,read_env,write_env,env_path,DEFAULTS
        from tools.operations.installation.settings import EDITABLE
        from tools.operations.provider.monitoring import internal_keys
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);write_env(env_path(state),{'NOCHEH_CONFIG_VERSION':'1','NOCHEH_HONCHO_ENABLED':'false'})
            values=initialize(state);token=values['NOCHEH_MACHINE_TOKEN']
            self.assertRegex(token,r'^[0-9a-f]{64}$');self.assertNotIn(token,(values['SERVICE_TOKEN'],values['NOCHEH_BOX_TOKEN']))
            self.assertEqual((initialize(state)['NOCHEH_MACHINE_TOKEN'],read_env(env_path(state))['NOCHEH_MACHINE_TOKEN']),(token,token))
            self.assertEqual(stat.S_IMODE((state/'machines').stat().st_mode),0o700)
            for bad in ('t'*31,values['SERVICE_TOKEN'],values['NOCHEH_BOX_TOKEN']):
                with self.assertRaises(ValueError):validate({**values,'NOCHEH_MACHINE_TOKEN':bad})
            validate({**values,'NOCHEH_MACHINE_TOKEN':''})
        self.assertNotIn('NOCHEH_MACHINE_TOKEN',DEFAULTS);self.assertNotIn('NOCHEH_MACHINE_TOKEN',EDITABLE)
        rows={row['name']:row for row in internal_keys({'NOCHEH_MACHINE_TOKEN':'t'*40})}
        self.assertTrue(rows['NOCHEH_MACHINE_TOKEN']['present']);self.assertNotIn('t'*40,json.dumps(rows))
        import tools.cli.main as cli
        from tools.operations.installation.configuration import generate
        before=generate({**DEFAULTS,'TELEGRAM_ENABLED':'true','TELEGRAM_OWNER_ID':'123456789','TELEGRAM_BOT_TOKEN':'made-up-bot-token',
                         'NOCHEH_HONCHO_DATABASE_VOLUME':'made-up_honcho_database','NOCHEH_HONCHO_REDIS_VOLUME':'made-up_honcho_redis'})
        del before['NOCHEH_MACHINE_TOKEN']
        with tempfile.TemporaryDirectory() as folder,patch('tools.development.live_dev.operating_root',return_value=Path(folder)/'main'):
            root=Path(folder)/'main';root.mkdir();path=root/'.env';write_env(path,before)
            cli.development_box_token();values=read_env(path);token=values.pop('NOCHEH_MACHINE_TOKEN')
            self.assertEqual(values,before);self.assertRegex(token,r'^[0-9a-f]{64}$')
            self.assertEqual(stat.S_IMODE((root/'data/local/machines').stat().st_mode),0o700)

    def test_keys_stay_out_of_backups_and_resets_erase_them(self):
        from tools.operations.installation.operations import backup,validate_snapshot,TABLES
        from tools.acceptance import reset_inventory
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);state=root/'state';state.mkdir();(state/'.env').write_text('TELEGRAM_ENABLED=false\n')
            for name in ('files','spool','hermes','machines/'+MACHINE):(state/name).mkdir(parents=True)
            (state/'machines'/MACHINE/'key').write_text('made-up private key\n');(state/'files/kept').write_text('kept\n')
            def run(command,**kwargs):
                if 'pg_dump' in command:kwargs['stdout'].write(b'synthetic database dump')
            with patch('tools.operations.installation.operations.compose',return_value=['fixture']),patch('tools.operations.installation.operations.environment',return_value={}),\
                 patch('tools.operations.installation.operations.subprocess.check_output',side_effect=['nocheh-app','fixture-revision']),\
                 patch('tools.operations.installation.operations.fingerprints',return_value={name:'hash' for name in TABLES}),\
                 patch('tools.operations.installation.operations.subprocess.run',side_effect=run),\
                 patch('tools.operations.workflows.workflow_worker.running',return_value=False):
                backup(state,root/'backup')
            files=validate_snapshot(root/'backup')['files']
            self.assertIn('files/kept',files);self.assertFalse([name for name in files if 'machines' in name])
            blockers=[];actions=reset_inventory.files(state,root/'honcho',state/'.env',blockers)
            self.assertEqual([(row['action'],row['reason']) for row in actions if Path(row['path'])==state/'machines'],[('erase','keys_of_erased_machines')])
            self.assertEqual(blockers,[])

if __name__=='__main__':unittest.main()
