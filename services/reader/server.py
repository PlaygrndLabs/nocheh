"""nocheh-reader: reads the files people send, away from every key (ADR-0285).

Documents, pictures and recordings come from anyone in a group Nocheh reads, so the code that parses them (Hermes's
document reader, Pillow, ffmpeg) parses bytes an attacker chooses. Hermes asks this service over a Unix socket in a
volume only the two share; the service has no network, no key, no token and no state, and its root file system is
read-only. Each file is read by services/reader/child.py in a process of its own, under one of a few logins of its own
(NOCHEH_READER_UIDS), so a file can reach neither this server, which runs as root with only the rights to switch login
and end those processes, nor a file read at the same time under another login. After each file every process of that
login is ended and everything it wrote in /tmp and /dev/shm is removed, so nothing a file leaves can read a later file.

Request: one JSON line {kind, hint, size}, then size bytes. Answer: one JSON line (the child's, with `size`), then that
many bytes; or {state: 'failed', reason}: `timed_out` when the file took too long, `busy` when no login was free in time,
`unavailable` when its process could not start, `invalid_request` for a request it cannot take.
Started as ``python -m services.reader.server`` in the Hermes image (deploy/hermes.Dockerfile).
"""
import json
import os
import queue
import resource
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

SOCKET = os.environ.get('NOCHEH_READER_SOCKET', '/run/reader/reader.sock')
UIDS = tuple(int(value) for value in os.environ.get('NOCHEH_READER_UIDS', '61001,61002').split(',') if value.strip())
LIMIT = 50 * 1024 * 1024
HEAD = 64 * 1024
# The most a child may hand back after its head line.
MADE = 40 * 1024 * 1024
# How long a file may take, by kind, and how long a request waits for a free login; a request that finds none in time
# is answered `busy`, and Nocheh's preparation tries the file again later.
SECONDS = {'document': 120, 'image': 60, 'audio': 150}
WAIT = 20
MEMORY = 2 * 1024 * 1024 * 1024
FILE_SIZE = 512 * 1024 * 1024
PROCESSES = 64
# Where a child may write: its home, and anything else it can (both tmpfs), all removed after each file.
SCRATCH = ('/tmp', '/dev/shm')
KINDS = tuple(SECONDS)
COMMAND = (sys.executable, '-m', 'services.reader.child')


def isolated():
    """Whether each file gets a login of its own: only a server started as root can switch to one."""
    return os.geteuid() == 0


def processes_of(uid):
    """The live processes whose real user is uid, other than this server. An ended process waiting to be reaped
    (by the container's init) runs nothing and is left out."""
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            status = dict(line.split(':', 1) for line in (entry / 'status').read_text().splitlines() if ':' in line)
        except OSError:
            continue
        if int(status.get('Uid', '-1').split()[0]) == uid and not status.get('State', '').strip().startswith(('Z', 'X')):
            found.append(int(entry.name))
    return found


def sweep(uid, child=None):
    """Ends every process of the child's login; without a login of its own (not root), its session."""
    if not isolated():
        if child is not None:
            try:
                os.killpg(child, signal.SIGKILL)
            except OSError:
                pass
        return
    for _ in range(50):
        left = processes_of(uid)
        if not left:
            return
        for pid in left:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        time.sleep(0.02)


def scrub(uid, home):
    """Removes what the child's login wrote where it can write, as that login."""
    if not isolated():
        subprocess.run(['rm', '-rf', '--', home], check=False, timeout=60)
        return
    # A folder the child closed to itself is opened again first, so its contents can be found and removed.
    for command in (['find', *SCRATCH, '-xdev', '-mindepth', '1', '-user', str(uid), '-type', 'd', '-exec', 'chmod', 'u+rwx', '{}', ';'],
                    ['find', *SCRATCH, '-xdev', '-mindepth', '1', '-user', str(uid), '-delete']):
        subprocess.run(command, check=False, timeout=60, user=uid, group=uid, extra_groups=[], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin'})


def limits(home):
    def apply():
        os.makedirs(home, mode=0o700, exist_ok=True)
        os.chdir(home)
        for name, value in ((resource.RLIMIT_AS, MEMORY), (resource.RLIMIT_FSIZE, FILE_SIZE), (resource.RLIMIT_NOFILE, 256),
                            (resource.RLIMIT_CORE, 0)):
            resource.setrlimit(name, (value, value))
        if isolated():
            resource.setrlimit(resource.RLIMIT_NPROC, (PROCESSES, PROCESSES))
    return apply


def exchange(child, data, seconds):
    """Gives the child its file and keeps what it writes, at most HEAD + MADE and one byte more: a child that writes
    more is ended. None when it did not end in time."""
    output = bytearray()

    def feed():
        try:
            child.stdin.write(data)
            child.stdin.close()
        except OSError:
            pass

    def drain():
        while len(output) <= HEAD + MADE:
            chunk = child.stdout.read1(1024 * 1024)
            if not chunk:
                return
            output.extend(chunk)
        child.kill()
    threads = [threading.Thread(target=feed, daemon=True), threading.Thread(target=drain, daemon=True)]
    for thread in threads:
        thread.start()
    try:
        child.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        return None
    # A process the child left behind may hold its output open; it is ended after this file, with the rest of its login.
    threads[1].join(timeout=5)
    return output if not threads[1].is_alive() else None


class Reader:
    def __init__(self, uids=UIDS):
        self.free = queue.Queue()
        for uid in (uids if isolated() else (os.getuid(),) * max(1, len(uids))):
            self.free.put(uid)
        self.count = 0
        self.lock = threading.Lock()

    def read(self, kind, hint, data):
        try:
            uid = self.free.get(timeout=WAIT)
        except queue.Empty:
            return {'state': 'failed', 'reason': 'busy'}, b''
        with self.lock:
            self.count += 1
            home = f'/tmp/nocheh-reader-{uid}-{self.count}'
        child = None
        try:
            environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'PYTHONPATH': os.environ.get('PYTHONPATH', ''),
                           'HOME': home, 'TMPDIR': home, 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}
            switch = {'user': uid, 'group': uid, 'extra_groups': []} if isolated() else {}
            try:
                child = subprocess.Popen([*COMMAND, kind, json.dumps(hint)], stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=environment, start_new_session=True,
                                         preexec_fn=limits(home), close_fds=True, **switch)
            except (OSError, subprocess.SubprocessError):
                # Its folder could not be made, such as with /tmp full: everything that login wrote is removed below.
                return {'state': 'failed', 'reason': 'unavailable'}, b''
            output = exchange(child, data, SECONDS[kind])
            if output is None:
                return {'state': 'failed', 'reason': 'timed_out'}, b''
            if len(output) > HEAD + MADE:
                return {'state': 'unreadable'}, b''
            line, _, rest = bytes(output).partition(b'\n')
            try:
                head = json.loads(line)
            except ValueError:
                return {'state': 'unreadable'}, b''
            if not isinstance(head, dict) or type(head.get('size')) is not int or head['size'] != len(rest):
                return {'state': 'unreadable'}, b''
            return head, rest
        finally:
            sweep(uid, child.pid if child else None)
            if child is not None:
                try:
                    child.kill()
                except OSError:
                    pass
                child.wait()
            scrub(uid, home)
            self.free.put(uid)


def receive(stream, size):
    data = stream.read(size)
    if len(data) != size:
        raise ValueError('short')
    return data


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            head = json.loads(self.rfile.readline(HEAD))
            if (not isinstance(head, dict) or head.get('kind') not in KINDS or not isinstance(head.get('hint'), dict)
                    or type(head.get('size')) is not int or not 0 < head['size'] <= LIMIT):
                raise ValueError('invalid')
            hint = {key: value for key, value in head['hint'].items() if key in ('name', 'mime_type', 'kind') and isinstance(value, str)}
            data = receive(self.rfile, head['size'])
        except (ValueError, OSError):
            return self.answer({'state': 'failed', 'reason': 'invalid_request'}, b'')
        result, made = self.server.reader.read(head['kind'], hint, data)
        self.answer(result, made)

    def answer(self, head, made):
        try:
            self.wfile.write(json.dumps({**head, 'size': len(made)}, ensure_ascii=False).encode() + b'\n' + made)
        except OSError:
            pass


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, path, reader):
        Path(path).unlink(missing_ok=True)
        super().__init__(path, Handler)
        # Hermes runs as another user: it may connect; only root may replace the socket, in a folder that is root's.
        os.chmod(path, 0o666)
        self.reader = reader


def health(path=SOCKET):
    """Whether the socket answers: a request with nothing in it gets its refusal back."""
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(4)
        connection.connect(path)
        connection.sendall(b'{}\n')
        return connection.makefile('rb').readline(HEAD).startswith(b'{')


def main():
    if not isolated():
        print('nocheh-reader is not running as root: every file is read under this login, without a login of its own.',
              file=sys.stderr, flush=True)
    folder = Path(SOCKET).parent
    if isolated() and stat.S_IMODE(folder.stat().st_mode) & 0o022:
        os.chmod(folder, 0o755)
    server = Server(SOCKET, Reader())
    server.serve_forever()


if __name__ == '__main__':
    if sys.argv[1:] == ['health']:
        sys.exit(0 if health() else 1)
    main()
