import json
import os
import signal
import socket
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from tools.runtime import box_server


def exact(sock,size):
    data=b''
    while len(data)<size:
        chunk=sock.recv(size-len(data))
        if not chunk:return None
        data+=chunk
    return data


def send(sock,body):
    raw=body if isinstance(body,bytes) else json.dumps(body).encode()
    sock.sendall(struct.pack('>Q',len(raw))+raw)


def reply(sock):
    """Output and exit code; the code is None when the box closed without one."""
    output=b'';code=None
    try:
        while (head:=exact(sock,5)) is not None:
            data=exact(sock,struct.unpack('>I',head[1:])[0])
            if head[:1]==b'X':code=struct.unpack('>i',data)[0];break
            output+=data
    except ConnectionResetError:pass  # closed before reading the request
    sock.close();return output.decode(),code


def alive(pid):
    try:return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[0] not in ('Z','X')
    except OSError:return False


def gone(pid,seconds=3):
    deadline=time.monotonic()+seconds
    while alive(pid) and time.monotonic()<deadline:time.sleep(.05)
    return not alive(pid)


class BoxServerTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.path=os.path.join(self.folder.name,'exec.sock')
        self.server=box_server.listen(self.path,os.getgid())
        # The test runs as one uid; the real box refuses its own uid (see the refusal test).
        threading.Thread(target=box_server.serve,args=(self.server,-1),daemon=True).start()

    def tearDown(self):
        self.server.shutdown(socket.SHUT_RDWR);self.server.close();self.folder.cleanup()

    def ask(self,script,stdin=None,timeout=10,login=False):
        sock=socket.socket(socket.AF_UNIX);sock.connect(self.path)
        send(sock,{'script':script,'stdin':stdin,'timeout':timeout,'login':login});return sock

    def test_a_command_gets_its_stdin_and_returns_output_and_exit_code(self):
        self.assertEqual(reply(self.ask("printf 'Alice: hello\\n'; cat; exit 3",stdin='Bob: hi')),('Alice: hello\nBob: hi',3))
        self.assertEqual(reply(self.ask('cat')),('',0))

    def test_the_script_runs_from_a_private_file_never_from_argv(self):
        output,code=reply(self.ask("tr '\\0' ' ' </proc/$$/cmdline; echo; stat -c %a \"$0\""))
        argv,mode=output.split('\n')[:2]
        self.assertEqual(code,0);self.assertRegex(argv,r'^bash \S+\.sh $');self.assertEqual(mode,'600')
        # Far over the 128 KiB argument limit.
        self.assertEqual(reply(self.ask('x='+'a'*204800+'\necho ${#x}')),('204800\n',0))

    def test_commands_get_a_minimal_environment(self):
        with patch.dict(os.environ,{'NOCHEH_FAKE_TOKEN':'made-up'}):
            output,_=reply(self.ask('env'))
        names={line.split('=',1)[0] for line in output.splitlines()}
        self.assertEqual(names-{'PWD','SHLVL','_'},{'PATH','HOME','LANG','TMPDIR'})

    def test_a_timeout_kills_the_process_group(self):
        with patch.object(box_server,'GRACE',0):
            sock=self.ask('sleep 30 & echo $!; wait',timeout=1)
            started=time.monotonic();output,code=reply(sock)
        self.assertEqual(code,124);self.assertLess(time.monotonic()-started,5);self.assertTrue(gone(int(output)))

    def test_a_cancel_kills_the_running_command(self):
        sock=self.ask('sleep 30 & echo $!; wait')
        head=exact(sock,5);pid=int(exact(sock,struct.unpack('>I',head[1:])[0]))
        self.assertTrue(alive(pid))
        sock.close()
        self.assertTrue(gone(pid))

    def test_a_finished_command_leaves_its_children_running(self):
        # The shape Hermes's remote code kernel is started with.
        output,code=reply(self.ask('{ nohup sleep 30 >/dev/null 2>&1 & echo $!; }'))
        pid=int(output)
        try:
            self.assertEqual(code,0);time.sleep(.3);self.assertTrue(alive(pid))
        finally:os.kill(pid,signal.SIGKILL)

    def test_output_is_capped(self):
        with patch.object(box_server,'MAX_OUTPUT',1000):
            output,code=reply(self.ask("head -c 50000 /dev/zero | tr '\\0' a"))
        self.assertEqual(code,0);self.assertEqual(output,'a'*1000+'\n[box: output capped at 8 MiB]\n')

    def test_malformed_requests_get_no_reply_and_the_server_keeps_serving(self):
        for body in (b'not json',b'[]',{'script':1,'timeout':5},{'script':'true','timeout':True},{'script':'true','timeout':0},
                     {'script':'true','timeout':5,'login':'yes'},{'script':'true','timeout':5,'stdin':3}):
            with self.subTest(body=body):
                sock=socket.socket(socket.AF_UNIX);sock.connect(self.path);send(sock,body)
                self.assertEqual(reply(sock),('',None))
        sock=socket.socket(socket.AF_UNIX);sock.connect(self.path);sock.sendall(struct.pack('>Q',2**40))
        self.assertEqual(reply(sock),('',None))
        self.assertEqual(reply(self.ask('echo ok')),('ok\n',0))

    def test_the_socket_is_for_the_box_group_only(self):
        info=os.stat(self.path)
        self.assertEqual((oct(info.st_mode&0o777),info.st_gid),('0o660',os.getgid()))
        with patch.dict(os.environ,{'NOCHEH_BOX_GID':''}),self.assertRaises(SystemExit):box_server.main(['box_server.py',self.path])

    def test_a_peer_with_the_box_uid_is_refused(self):
        path=os.path.join(self.folder.name,'own.sock');server=box_server.listen(path,os.getgid())
        threading.Thread(target=box_server.serve,args=(server,),daemon=True).start()
        try:
            sock=socket.socket(socket.AF_UNIX);sock.connect(path)
            send(sock,{'script':'touch '+self.folder.name+'/ran','timeout':5})
            self.assertEqual(reply(sock),('',None))
            self.assertFalse(os.path.exists(self.folder.name+'/ran'))
        finally:server.shutdown(socket.SHUT_RDWR);server.close()


if __name__=='__main__':unittest.main()
