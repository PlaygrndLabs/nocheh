"""Exec server inside a background job's sealed box: no network, no keys, a read-only root.

Run in the box as ``python3 -I box_server.py``; standard library only. One request per
connection on /run/box/exec.sock: an 8-byte big-endian length, then JSON
{"script","stdin","timeout","login"}. The script goes into a private file and runs as
``bash [-l] <file>`` in its own process group, never in argv. The reply is frames: b'O',
a 4-byte length and output bytes, then b'X', 4 and the exit code as a signed 4-byte int.
A byte or EOF from the client while the command runs is a cancel; it and a timeout kill
the process group. A command that ended is never killed, so the children it left, such
as Hermes's code kernel, keep running.
"""
import json
import os
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

SOCKET='/run/box/exec.sock'
MAX_REQUEST=64*1024*1024
MAX_OUTPUT=8*1024*1024
# Hermes stops a command at its own timeout first; the box stops it a little later.
GRACE=5
ENV={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/work','LANG':'C.UTF-8','TMPDIR':'/tmp'}


def frame(conn,kind,data):conn.sendall(kind+struct.pack('>I',len(data))+data)


def exact(conn,size):
    data=bytearray()
    while len(data)<size:
        chunk=conn.recv(min(size-len(data),1<<20))
        if not chunk:return None
        data+=chunk
    return bytes(data)


def request(conn):
    """The connection's one request as (script, stdin, timeout, login), or None."""
    head=exact(conn,8);size=struct.unpack('>Q',head)[0] if head else 0
    raw=exact(conn,size) if 0<size<=MAX_REQUEST else None
    body=json.loads(raw) if raw is not None else None
    if not isinstance(body,dict):return None
    script,stdin,timeout,login=body.get('script'),body.get('stdin'),body.get('timeout'),body.get('login',False)
    if (not isinstance(script,str) or stdin is not None and not isinstance(stdin,str) or type(login) is not bool
            or type(timeout) not in (int,float) or not 0<timeout<=86400):return None
    return script,stdin,float(timeout),login


def feed(pipe,text):
    try:pipe.write(text.encode('utf-8','surrogateescape'))
    except (OSError,UnicodeError):pass
    finally:
        try:pipe.close()
        except OSError:pass


def run(conn,scripts,script,stdin,timeout,login):
    descriptor,path=tempfile.mkstemp(dir=scripts,suffix='.sh');proc=None
    try:
        with os.fdopen(descriptor,'w',encoding='utf-8',errors='surrogateescape') as file:file.write(script)
        proc=subprocess.Popen(['bash','-l',path] if login else ['bash',path],cwd='/work' if os.path.isdir('/work') else '/',env=ENV,
            stdin=subprocess.DEVNULL if stdin is None else subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
            start_new_session=True,umask=0o022)
        if stdin is not None:threading.Thread(target=feed,args=(proc.stdin,stdin),daemon=True).start()
        output=proc.stdout.fileno();poller=select.poll()
        poller.register(output,select.POLLIN);poller.register(conn.fileno(),select.POLLIN)
        deadline=time.monotonic()+timeout+GRACE;sent=0;capped=False;open_=True;ended=None
        while True:
            for number,_ in poller.poll(100):
                # The client sends nothing after its request: anything else, or EOF, is a cancel.
                if number==conn.fileno():return
                chunk=os.read(output,65536)
                if not chunk:poller.unregister(output);open_=False
                elif not capped:
                    piece=chunk[:MAX_OUTPUT-sent];sent+=len(piece)
                    if piece:frame(conn,b'O',piece)
                    if len(piece)<len(chunk):capped=True;frame(conn,b'O',b'\n[box: output capped at 8 MiB]\n')
            if proc.poll() is not None:
                ended=ended or time.monotonic()
                # A child left running may keep the output open; the reply ends shortly after bash does.
                if not open_ or time.monotonic()-ended>.3:break
            elif time.monotonic()>deadline:
                os.killpg(proc.pid,signal.SIGKILL);proc.wait();frame(conn,b'X',struct.pack('>i',124));return
        frame(conn,b'X',struct.pack('>i',proc.returncode))
    finally:
        if proc is not None:
            if proc.poll() is None:
                try:os.killpg(proc.pid,signal.SIGKILL)
                except OSError:pass
                proc.wait()
            proc.stdout.close()
        os.unlink(path)


def handle(conn,scripts,refused):
    try:
        # Commands in the box run as the server's own uid; only the turn may ask for commands.
        uid=struct.unpack('3i',conn.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,struct.calcsize('3i')))[1]
        conn.settimeout(60)
        if uid!=refused and (body:=request(conn)) is not None:run(conn,scripts,*body)
    except Exception:pass  # one bad client never takes the server down
    finally:conn.close()


def listen(path,gid):
    try:os.unlink(path)
    except FileNotFoundError:pass
    server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(path)
    # The turn runs as another uid in the box's extra group.
    os.chown(path,-1,gid);os.chmod(path,0o660);server.listen(64)
    return server


def serve(server,refused=None):
    refused=os.getuid() if refused is None else refused
    scripts=tempfile.mkdtemp(prefix='box-')
    while server.fileno()!=-1:
        try:conn,_=server.accept()
        except OSError:time.sleep(.1);continue
        try:threading.Thread(target=handle,args=(conn,scripts,refused),daemon=True).start()
        except RuntimeError:conn.close()


def main(argv):
    os.umask(0o077)
    gid=os.environ.get('NOCHEH_BOX_GID','')
    if not gid.isdigit() or int(gid)<=0:raise SystemExit('NOCHEH_BOX_GID is required')
    serve(listen(argv[1] if len(argv)>1 else SOCKET,int(gid)))


if __name__=='__main__':main(sys.argv)
