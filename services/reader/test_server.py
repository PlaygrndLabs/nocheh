"""nocheh-reader (ADR-0285): files read in a process of their own, answers Hermes can trust, and nothing left behind.

The tests that switch logins run only as root, as the service does in its container."""
import io
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from services.hermes import reader_client
from services.reader import server

ROOT = os.geteuid() == 0
UIDS = (61001, 61002)


def picture(width, height, orientation=None, format='JPEG'):
    from PIL import Image
    made = io.BytesIO()
    image = Image.new('RGB', (width, height), (200, 30, 30))
    if orientation:
        exif = Image.Exif()
        exif[0x0112] = orientation
        image.save(made, format, exif=exif)
    else:
        image.save(made, format)
    return made.getvalue()


def recording(seconds):
    with tempfile.TemporaryDirectory() as work:
        path = Path(work, 'tone.wav')
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', f'sine=frequency=440:duration={seconds}',
                        '-metadata', 'title=Made-up title', str(path)], check=True)
        return path.read_bytes()


class Running:
    """A reader on a socket of its own, for one test."""
    def __init__(self, uids=UIDS):
        self.folder = tempfile.mkdtemp(prefix='reader-test-')
        os.chmod(self.folder, 0o755)
        self.path = os.path.join(self.folder, 'reader.sock')
        self.server = server.Server(self.path, server.Reader(uids))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def __enter__(self):
        self.environment = patch.dict(os.environ, {reader_client.SOCKET: self.path})
        self.environment.start()
        return self

    def __exit__(self, *_):
        self.environment.stop()
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.folder, ignore_errors=True)


class ReaderTests(unittest.TestCase):
    def test_picture_is_made_again_as_a_turned_png(self):
        with Running():
            head, made = reader_client.read('image', picture(3000, 1000, orientation=6), {'name': 'a.jpg'})
        self.assertEqual(head['state'], 'done')
        self.assertTrue(made.startswith(reader_client.MAGIC['png']))
        # Turned the way its EXIF says, then shrunk to at most 2048 a side.
        self.assertEqual((head['width'], head['height']), (683, 2048))
        from PIL import Image
        with Image.open(io.BytesIO(made)) as found:
            self.assertEqual((found.format, found.size), ('PNG', (683, 2048)))
            self.assertNotIn('exif', found.info)

    def test_broken_and_oversized_pictures(self):
        with Running():
            self.assertEqual(reader_client.read('image', b'not a picture', {}), ({'state': 'unreadable', 'size': 0}, b''))
            self.assertEqual(reader_client.read('image', picture(9000, 8000, format='PNG'), {})[0]['state'], 'too_large')

    def test_recording_is_made_again_without_its_metadata(self):
        with Running():
            head, made = reader_client.read('audio', recording(3), {'name': 'note.wav', 'mime_type': 'audio/wav'})
        self.assertEqual(head['state'], 'done')
        self.assertAlmostEqual(head['seconds'], 3, delta=0.1)
        self.assertTrue(made.startswith(b'OggS'))
        self.assertNotIn(b'Made-up title', made)
        with tempfile.NamedTemporaryFile(suffix='.ogg') as file:
            file.write(made)
            file.flush()
            probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,channels,sample_rate', '-of', 'json',
                                    file.name], capture_output=True, text=True, check=True)
        stream = json.loads(probe.stdout)['streams'][0]
        self.assertEqual((stream['codec_name'], stream['channels']), ('opus', 1))

    def test_recording_without_a_known_format(self):
        with Running():
            self.assertEqual(reader_client.read('audio', b'abc', {'name': 'note.xyz'})[0]['state'], 'unsupported')

    def test_unknown_document(self):
        with Running():
            head, made = reader_client.read('document', b'\x00\x01 not a document', {'name': 'a.bin'})
        self.assertEqual((head['state'], made), ('unsupported', b''))

    def test_a_file_that_takes_too_long_is_ended(self):
        with Running(), patch.dict(server.SECONDS, {'audio': 0.01}):
            started = time.monotonic()
            head, made = reader_client.read('audio', recording(1), {'name': 'note.wav'})
        self.assertEqual((head, made), ({'state': 'failed', 'reason': 'timed_out', 'size': 0}, b''))
        self.assertLess(time.monotonic() - started, 10)

    def test_a_child_that_writes_too_much_is_ended(self):
        flood = 'import sys\nwhile True: sys.stdout.buffer.write(b"x" * 1048576)'
        with Running(), patch.object(server, 'COMMAND', (server.sys.executable, '-c', flood)):
            started = time.monotonic()
            self.assertEqual(reader_client.read('document', b'x', {})[0]['state'], 'unreadable')
        self.assertLess(time.monotonic() - started, 30)

    def test_busy_and_unreachable_readers_are_tried_later(self):
        with Running(uids=UIDS[:1]) as running, patch.object(server, 'WAIT', 0.2):
            uid = running.server.reader.free.get()
            with self.assertRaises(reader_client.ReaderUnavailable):
                reader_client.read('image', picture(10, 10), {})
            running.server.reader.free.put(uid)
        with patch.dict(os.environ, {reader_client.SOCKET: '/nonexistent/reader.sock'}), self.assertRaises(reader_client.ReaderUnavailable):
            reader_client.read('image', picture(10, 10), {})

    def test_requests_it_cannot_take(self):
        with Running() as running:
            self.assertTrue(server.health(running.path))
            for request in (b'{"kind": "video", "hint": {}, "size": 3}\nabc', b'{"kind": "image", "hint": {}, "size": 9}\nabc'):
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.connect(running.path)
                    connection.sendall(request)
                    connection.shutdown(socket.SHUT_WR)
                    self.assertEqual(json.loads(connection.makefile('rb').readline()),
                                     {'state': 'failed', 'reason': 'invalid_request', 'size': 0})

    def test_made_file_must_be_what_it_says(self):
        def answer(head, made):
            return patch.object(server.Reader, 'read', return_value=(head, made))
        with Running():
            with answer({'state': 'done', 'format': 'png'}, b'GIF89a fake'):
                self.assertEqual(reader_client.read('image', b'x', {}), ({'state': 'unreadable'}, b''))
            with answer({'state': 'done', 'format': 'png'}, b''):
                self.assertEqual(reader_client.read('image', b'x', {}), ({'state': 'unreadable'}, b''))
            with answer({'state': 'done', 'format': 'exe'}, b'MZ'):
                self.assertEqual(reader_client.read('image', b'x', {}), ({'state': 'unreadable'}, b''))


@unittest.skipUnless(ROOT, 'switching logins needs root, as in the container')
class IsolationTests(unittest.TestCase):
    def as_login(self, uid, script):
        return subprocess.Popen(['/bin/sh', '-c', script], user=uid, group=uid, extra_groups=[], start_new_session=True,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def test_a_hostile_child_leaves_nothing_behind(self):
        # A child that runs whatever its file makes it run: it reports its login, leaves a process and files behind.
        hostile = ('import json, os, subprocess, sys; sys.stdin.buffer.read(); '
                   'os.makedirs("/tmp/hostile/closed"); open("/tmp/hostile/closed/note", "w").close(); os.chmod("/tmp/hostile/closed", 0); '
                   'open("/dev/shm/hostile-note", "w").close(); '
                   'subprocess.Popen(["sleep", "300"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL); '
                   'print(json.dumps({"state": "done", "text": str(os.getuid()) + " " + str(os.getgroups()), "size": 0}))')
        with Running(), patch.object(server, 'COMMAND', (server.sys.executable, '-c', hostile)):
            head, _ = reader_client.read('document', b'x', {})
        uid = int(head['text'].split()[0])
        self.assertIn(uid, UIDS)
        self.assertEqual(head['text'].split(' ', 1)[1], '[]')
        self.assertEqual(server.processes_of(uid), [])
        self.assertFalse(os.path.exists('/tmp/hostile'))
        self.assertFalse(os.path.exists('/dev/shm/hostile-note'))

    def test_sweep_and_scrub_leave_nothing_of_a_login(self):
        uid = UIDS[1]
        left = self.as_login(uid, 'mkdir -p /tmp/left/closed && touch /tmp/left/closed/note /dev/shm/left-note && chmod 000 /tmp/left/closed'
                                  ' && sleep 300 & sleep 300')
        time.sleep(0.3)
        self.assertTrue(server.processes_of(uid))
        server.sweep(uid)
        left.wait(timeout=5)
        self.assertEqual(server.processes_of(uid), [])
        server.scrub(uid, '/tmp/unused')
        self.assertFalse(os.path.exists('/tmp/left'))
        self.assertFalse(os.path.exists('/dev/shm/left-note'))

    def test_another_login_cannot_read_a_childs_home(self):
        home = f'/tmp/nocheh-reader-{UIDS[0]}-test'
        try:
            subprocess.run(['/bin/sh', '-c', f'mkdir -m 700 {home} && echo made-up > {home}/secret'], user=UIDS[0], group=UIDS[0],
                           extra_groups=[], check=True)
            peek = subprocess.run(['cat', f'{home}/secret'], user=UIDS[1], group=UIDS[1], extra_groups=[], capture_output=True)
            self.assertNotEqual(peek.returncode, 0)
        finally:
            server.scrub(UIDS[0], home)
        self.assertFalse(os.path.exists(home))

if __name__ == '__main__':
    unittest.main()
