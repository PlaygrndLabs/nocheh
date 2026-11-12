import io
import json
import re
import tarfile
import tempfile
import threading
import unittest
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from tools.operations.installation import offsite
from tools.operations.installation.operations import sha

PASSPHRASE = 'correct horse battery staple'
JOBS = ['%08d-1111-4111-8111-111111111111' % number for number in range(1, 6)]


def snapshot(root, created_at='2026-11-10T04:00:00+00:00', payload=b'synthetic dump'):
    root.mkdir(parents=True)
    raw = b'example file \xf0\x9f\x98\x83'
    (root / 'archive.dump').write_bytes(payload)
    original = root / 'original'; original.write_bytes(raw)
    with tarfile.open(root / 'state.tar.gz', 'w:gz') as tar:
        info = tarfile.TarInfo('state/files/example'); info.size = len(raw); tar.addfile(info, io.BytesIO(raw))
    original.unlink()
    manifest = {'version': 1, 'created_at': created_at, 'dump_sha256': sha(root / 'archive.dump'),
                'state_sha256': sha(root / 'state.tar.gz'), 'files': {'files/example': {'sha256': offsite.hashlib.sha256(raw).hexdigest(), 'size': len(raw)}}}
    (root / 'manifest.json').write_text(json.dumps(manifest))
    return manifest


class Bucket(BaseHTTPRequestHandler):
    """A small in-memory S3 stand-in: put, multipart, get, list v2 and delete."""
    objects, uploads, requests = {}, {}, []

    def log_message(self, *args):
        pass

    def _send(self, code, body=b'', headers=None):
        self.send_response(code)
        for key, value in (headers or {}).items(): self.send_header(key, value)
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    def _parts(self):
        parsed = urllib.parse.urlsplit(self.path); bucket, _, key = parsed.path.lstrip('/').partition('/')
        Bucket.requests.append((self.command, self.headers.get('Authorization', ''), self.headers.get('x-amz-content-sha256')))
        return urllib.parse.unquote(key), dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))

    def _body(self):
        return self.rfile.read(int(self.headers.get('Content-Length') or 0))

    def do_PUT(self):
        key, query = self._parts(); body = self._body()
        assert self.headers['x-amz-content-sha256'] == offsite.hashlib.sha256(body).hexdigest()
        if 'uploadId' in query:
            Bucket.uploads[query['uploadId']][int(query['partNumber'])] = body
            return self._send(200, headers={'ETag': f'"etag-{query["partNumber"]}"'})
        Bucket.objects[key] = body; self._send(200, headers={'ETag': '"x"'})

    def do_POST(self):
        key, query = self._parts(); body = self._body()
        if 'uploads' in query:
            Bucket.uploads['u1'] = {}
            return self._send(200, b'<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><UploadId>u1</UploadId></InitiateMultipartUploadResult>')
        parts = Bucket.uploads.pop(query['uploadId']); numbers = [int(n) for n in re.findall(rb'<PartNumber>(\d+)</PartNumber>', body)]
        Bucket.objects[key] = b''.join(parts[n] for n in numbers); self._send(200, b'<CompleteMultipartUploadResult/>')

    def do_GET(self):
        key, query = self._parts()
        if query.get('list-type') == '2':
            items = ''.join(f'<Contents><Key>{k}</Key><Size>{len(v)}</Size></Contents>' for k, v in sorted(Bucket.objects.items())
                            if k.startswith(query.get('prefix', '')))
            return self._send(200, f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>{items}</ListBucketResult>'.encode())
        if key not in Bucket.objects: return self._send(404, b'<Error><Code>NoSuchKey</Code></Error>')
        self._send(200, Bucket.objects[key])

    def do_DELETE(self):
        key, query = self._parts()
        if 'uploadId' in query: Bucket.uploads.pop(query['uploadId'], None)
        else: Bucket.objects.pop(key, None)
        self._send(204)


class EncryptionTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.root = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_round_trip_restores_an_identical_checked_backup(self):
        manifest = snapshot(self.root / 'backup', payload=b'x' * (offsite.CHUNK * 2 + 17))
        offsite.encrypt_backup(self.root / 'backup', self.root / 'copy', PASSPHRASE)
        self.assertNotIn(b'xxxxxxxx', (self.root / 'copy').read_bytes())
        self.assertEqual(offsite.decrypt_backup(self.root / 'copy', self.root / 'out', PASSPHRASE), manifest)
        for name in ('archive.dump', 'state.tar.gz', 'manifest.json'):
            self.assertEqual((self.root / 'out' / name).read_bytes(), (self.root / 'backup' / name).read_bytes())

    def test_wrong_passphrase_change_and_cut_off_are_refused(self):
        snapshot(self.root / 'backup')
        offsite.encrypt_backup(self.root / 'backup', self.root / 'copy', PASSPHRASE)
        data = (self.root / 'copy').read_bytes()
        with self.assertRaisesRegex(offsite.OffsiteError, 'wrong_passphrase'):
            offsite.decrypt_backup(self.root / 'copy', self.root / 'a', 'a different passphrase here')
        changed = bytearray(data); changed[-20] ^= 1; (self.root / 'changed').write_bytes(changed)
        with self.assertRaisesRegex(offsite.OffsiteError, 'wrong_passphrase_or_damaged'):
            offsite.decrypt_backup(self.root / 'changed', self.root / 'b', PASSPHRASE)
        (self.root / 'cut').write_bytes(data[:-10])
        with self.assertRaisesRegex(offsite.OffsiteError, 'truncated'):
            offsite.decrypt_backup(self.root / 'cut', self.root / 'c', PASSPHRASE)
        (self.root / 'longer').write_bytes(data + b'\0')
        with self.assertRaisesRegex(offsite.OffsiteError, 'damaged'):
            offsite.decrypt_backup(self.root / 'longer', self.root / 'd', PASSPHRASE)
        self.assertFalse(any((self.root / name).exists() for name in 'abcd'))

    def test_a_backup_that_fails_its_checksums_is_not_restored(self):
        snapshot(self.root / 'backup'); (self.root / 'backup/archive.dump').write_bytes(b'changed after the backup')
        offsite.encrypt_backup(self.root / 'backup', self.root / 'copy', PASSPHRASE)
        with self.assertRaisesRegex(offsite.OffsiteError, 'backup_invalid'):
            offsite.decrypt_backup(self.root / 'copy', self.root / 'out', PASSPHRASE)
        self.assertFalse((self.root / 'out').exists())

    def test_short_passphrase_is_refused(self):
        snapshot(self.root / 'backup')
        with self.assertRaisesRegex(offsite.OffsiteError, 'too_short'):
            offsite.encrypt_backup(self.root / 'backup', self.root / 'copy', 'short')


class SignatureTests(unittest.TestCase):
    def test_matches_the_aws_signature_version_4_example(self):
        # GET Object example from the Amazon S3 Signature Version 4 documentation.
        headers = offsite.signed_headers('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', {'Range': 'bytes=0-9'},
                                         offsite.EMPTY_SHA256, 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
                                         'us-east-1', datetime(2013, 5, 24, tzinfo=timezone.utc))
        self.assertEqual(headers['authorization'],
                         'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
                         'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
                         'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')


class SettingsTests(unittest.TestCase):
    def test_validation(self):
        offsite.validate({})
        full = {'NOCHEH_OFFSITE': 's3', 'NOCHEH_OFFSITE_ENDPOINT': 'https://account.r2.cloudflarestorage.com', 'NOCHEH_OFFSITE_BUCKET': 'nocheh-backups',
                'NOCHEH_OFFSITE_ACCESS_KEY_ID': 'id', 'NOCHEH_OFFSITE_SECRET_ACCESS_KEY': 'secret', 'NOCHEH_OFFSITE_PASSPHRASE': PASSPHRASE}
        offsite.validate(full)
        for change, message in (({'NOCHEH_OFFSITE_ENDPOINT': 'http://account.r2.cloudflarestorage.com'}, 'https'),
                                ({'NOCHEH_OFFSITE_ENDPOINT': 'https://user:pw@host'}, 'https'),
                                ({'NOCHEH_OFFSITE_BUCKET': 'Bad_Bucket'}, 'bucket'),
                                ({'NOCHEH_OFFSITE_PASSPHRASE': 'short'}, '16'),
                                ({'NOCHEH_OFFSITE_KEEP': '0'}, '1-365'),
                                ({'NOCHEH_OFFSITE_SECRET_ACCESS_KEY': ''}, 'need'),
                                ({'NOCHEH_OFFSITE': 'ftp'}, 'off or s3'),
                                ({'NOCHEH_OFFSITE_PROVIDER': 'ftp'}, 'cloudflare, backblaze or other')):
            with self.assertRaisesRegex(ValueError, message): offsite.validate({**full, **change})


class SendAndCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Bucket)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        Bucket.objects.clear(); Bucket.uploads.clear(); Bucket.requests.clear()
        self.folder = tempfile.TemporaryDirectory(); self.state = Path(self.folder.name)
        self.values = {'NOCHEH_OFFSITE': 's3', 'NOCHEH_OFFSITE_ENDPOINT': f'http://127.0.0.1:{self.server.server_port}',
                       'NOCHEH_OFFSITE_BUCKET': 'nocheh-backups', 'NOCHEH_OFFSITE_ACCESS_KEY_ID': 'id',
                       'NOCHEH_OFFSITE_SECRET_ACCESS_KEY': 'secret', 'NOCHEH_OFFSITE_PASSPHRASE': PASSPHRASE, 'NOCHEH_OFFSITE_KEEP': '2'}
        self.proxy = patch.dict('os.environ', {'NO_PROXY': '127.0.0.1', 'no_proxy': '127.0.0.1'}); self.proxy.start()

    def tearDown(self):
        self.proxy.stop(); self.folder.cleanup()

    def backup(self, job, day, payload=b'dump'):
        return snapshot(self.state / 'admin/backups' / job, f'2026-11-{day:02d}T04:00:00+00:00', payload)

    def test_off_means_nothing_is_due(self):
        self.backup(JOBS[0], 1)
        self.assertEqual(offsite.due(self.state, {**self.values, 'NOCHEH_OFFSITE': 'off'}), {'due': False})

    def test_each_backup_is_sent_once_and_old_copies_are_pruned(self):
        for number, job in enumerate(JOBS[:3], 1):
            self.backup(job, number)
            self.assertTrue(offsite.due(self.state, self.values)['due'])
            result = offsite.send(self.state, self.values)
            self.assertEqual(result['backup'], job)
            self.assertFalse(offsite.due(self.state, self.values)['due'])
        self.assertEqual(sorted(Bucket.objects), [offsite.object_key(JOBS[1], '2026-11-02T04:00:00'), offsite.object_key(JOBS[2], '2026-11-03T04:00:00')])
        self.assertTrue(all(auth.startswith('AWS4-HMAC-SHA256 Credential=id/') for _, auth, _ in Bucket.requests))
        self.assertFalse(any((self.state / 'admin/offsite-work').iterdir()))
        status = offsite.status(self.state, self.values)
        self.assertEqual(status['last']['state'], 'sent'); self.assertEqual(len(status['sent']), 2)
        self.assertNotIn(PASSPHRASE, (self.state / offsite.RECORD).read_text())

    def test_workspaces_sharing_a_bucket_keep_and_prune_only_their_own_copies(self):
        # Each workspace sends to its own folder (ADR-0245), so one never prunes, lists or fetches another's copies.
        acme_state = Path(self.folder.name) / 'acme'
        acme = {**self.values, 'NOCHEH_WORKSPACE': 'acme'}
        for number, job in enumerate(JOBS[:3], 1):
            self.backup(job, number); offsite.send(self.state, self.values)
        for number, job in enumerate(JOBS[3:], 4):
            snapshot(acme_state / 'admin/backups' / job, f'2026-11-{number:02d}T04:00:00+00:00')
            offsite.send(acme_state, {**acme, 'NOCHEH_OFFSITE_KEEP': '1'})
        self.assertEqual(sorted(Bucket.objects), sorted([
            offsite.object_key(JOBS[4], '2026-11-05T04:00:00', 'nocheh-backups/acme/'),
            offsite.object_key(JOBS[1], '2026-11-02T04:00:00'), offsite.object_key(JOBS[2], '2026-11-03T04:00:00')]))
        # personal keeps the bucket's top folder and never lists acme's copies below it.
        self.assertEqual(offsite.object_key(JOBS[1], '2026-11-02T04:00:00').rsplit('/', 1)[0], 'nocheh-backups')
        self.assertEqual([item['key'] for item in offsite.Storage(offsite.settings(self.values)).list()],
                         [offsite.object_key(JOBS[1], '2026-11-02T04:00:00'), offsite.object_key(JOBS[2], '2026-11-03T04:00:00')])
        self.assertEqual([item['key'] for item in offsite.Storage(offsite.settings(acme)).list()],
                         [offsite.object_key(JOBS[4], '2026-11-05T04:00:00', 'nocheh-backups/acme/')])
        self.assertEqual(offsite.check(acme_state, acme)['key'], offsite.object_key(JOBS[4], '2026-11-05T04:00:00', 'nocheh-backups/acme/'))

    def test_copies_the_storage_still_locks_are_kept_without_an_error(self):
        locked = {offsite.object_key(JOBS[0], '2026-11-01T04:00:00')}
        original = Bucket.do_DELETE
        def lock(handler):
            if urllib.parse.unquote(urllib.parse.urlsplit(handler.path).path).split('/', 2)[2] in locked:
                handler._parts(); return handler._send(409, b'<Error><Code>ObjectLockedByBucketPolicy</Code></Error>')
            return original(handler)
        with patch.object(Bucket, 'do_DELETE', lock):
            for number, job in enumerate(JOBS[:3], 1):
                self.backup(job, number); result = offsite.send(self.state, self.values)
        self.assertEqual((result['removed'], result['locked']), (0, 1)); self.assertNotIn('prune_error', result)
        self.assertEqual(sorted(Bucket.objects), [offsite.object_key(job, f'2026-11-0{n}T04:00:00') for n, job in enumerate(JOBS[:3], 1)])
        # Once the lock ends, the next copy removes it.
        locked.clear(); self.backup(JOBS[3], 4)
        self.assertEqual(offsite.send(self.state, self.values)['removed'], 2)
        self.assertEqual(offsite.status(self.state, self.values)['provider'], 'cloudflare')

    def test_sending_a_backup_again_while_its_copy_is_locked_keeps_that_copy(self):
        self.backup(JOBS[0], 1); first = offsite.send(self.state, self.values)
        stored = dict(Bucket.objects)
        original = Bucket.do_PUT
        def lock(handler):
            if urllib.parse.unquote(urllib.parse.urlsplit(handler.path).path).split('/', 2)[2] in stored:
                handler._parts(); handler._body(); return handler._send(409, b'<Error><Code>ObjectLockedByBucketPolicy</Code></Error>')
            return original(handler)
        with patch.object(Bucket, 'do_PUT', lock): again = offsite.send(self.state, self.values)
        self.assertEqual((again['status'], again['key'], again['bytes']), ('offsite_sent', first['key'], first['bytes']))
        self.assertEqual(Bucket.objects, stored)
        self.assertEqual(offsite.status(self.state, self.values)['last']['state'], 'sent')
        # A lock on a key that is not there is still a failure.
        Bucket.objects.clear()
        with patch.object(Bucket, 'do_PUT', lambda handler: (handler._parts(), handler._body(),
                                                             handler._send(409, b'<Error><Code>ObjectLockedByBucketPolicy</Code></Error>'))):
            with self.assertRaisesRegex(offsite.OffsiteError, 'ObjectLockedByBucketPolicy'): offsite.send(self.state, self.values)

    def test_large_copies_use_multipart_and_the_restore_test_passes(self):
        self.backup(JOBS[0], 1, payload=bytes(range(256)) * 20000)
        with patch.object(offsite, 'PART', 1024 * 1024): offsite.send(self.state, self.values)
        self.assertGreater(sum(1 for method, _, _ in Bucket.requests if method == 'PUT'), 3)
        result = offsite.check(self.state, self.values)
        self.assertEqual(result['status'], 'offsite_checked'); self.assertEqual(result['created_at'], '2026-11-01T04:00:00+00:00')
        self.assertEqual(offsite.status(self.state, self.values)['check']['state'], 'passed')
        self.assertFalse(any((self.state / 'admin/offsite-work').iterdir()))

    def test_failures_are_recorded_and_not_retried_by_the_schedule(self):
        self.backup(JOBS[0], 1)
        broken = {**self.values, 'NOCHEH_OFFSITE_BUCKET': 'missing'}
        with patch.object(Bucket, 'do_PUT', lambda handler: (handler._parts(), handler._body(), handler._send(403, b'<Error><Code>AccessDenied</Code></Error>'))):
            with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_storage_AccessDenied'): offsite.send(self.state, broken)
        self.assertEqual(offsite.status(self.state, self.values)['last']['error'], 'offsite_storage_AccessDenied')
        self.assertFalse(offsite.due(self.state, self.values)['due'])
        offsite.send(self.state, self.values)
        self.assertEqual(offsite.status(self.state, self.values)['last']['state'], 'sent')

    def test_the_newest_backup_is_the_latest_made_not_the_highest_folder_name(self):
        # Folder names are random job ids: here the older backup has the higher name.
        older, newer = 'f' + JOBS[0][1:], '0' + JOBS[1][1:]
        self.backup(older, 1); offsite.send(self.state, self.values)
        self.backup(newer, 2)
        self.assertTrue(offsite.due(self.state, self.values)['due'])
        self.assertEqual(offsite.send(self.state, self.values)['backup'], newer)

    def test_a_copy_waits_while_the_disk_is_nearly_full(self):
        self.backup(JOBS[0], 1)
        full = offsite.shutil.disk_usage(self.state)._replace(free=10)
        with patch.object(offsite.shutil, 'disk_usage', return_value=full):
            self.assertEqual(offsite.due(self.state, self.values), {'due': False, 'skipped': 'low_disk'})
            with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_low_disk'): offsite.send(self.state, self.values)
        self.assertNotIn(JOBS[0], offsite.read_record(self.state).get('attempted', []))

    def test_a_refused_completion_inside_a_success_answer_fails_the_copy(self):
        self.backup(JOBS[0], 1, payload=bytes(range(256)) * 20000)
        original = Bucket.do_POST
        def refuse(handler):
            if 'uploadId=' in handler.path: return (handler._parts(), handler._body(), handler._send(200, b'<Error><Code>InternalError</Code></Error>'))
            return original(handler)
        with patch.object(Bucket, 'do_POST', refuse), patch.object(offsite, 'PART', 1024 * 1024):
            with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_storage_InternalError'): offsite.send(self.state, self.values)
        self.assertEqual(Bucket.objects, {}); self.assertEqual(Bucket.uploads, {})
        status = offsite.status(self.state, self.values)
        self.assertEqual(status['last']['state'], 'failed'); self.assertIsNone(status['last_sent'])

    def test_a_copy_cannot_ask_for_a_costlier_key_derivation(self):
        with self.assertRaisesRegex(offsite.OffsiteError, 'offsite_unsupported_format'):
            offsite._key(PASSPHRASE, {**offsite.KDF, 'n': 2 ** 20, 'salt': offsite.base64.b64encode(bytes(16)).decode()})

    def test_wrong_passphrase_fails_the_restore_test(self):
        self.backup(JOBS[0], 1); offsite.send(self.state, self.values)
        with self.assertRaisesRegex(offsite.OffsiteError, 'wrong_passphrase'):
            offsite.check(self.state, {**self.values, 'NOCHEH_OFFSITE_PASSPHRASE': 'another long passphrase'})
        self.assertEqual(offsite.status(self.state, self.values)['check']['error'], 'offsite_wrong_passphrase_or_damaged')


if __name__ == '__main__':
    unittest.main()
