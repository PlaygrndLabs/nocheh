"""The authorized real-model fixture cannot reset limits or journal secrets."""
import json
import io
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from tools.acceptance.model_relay import Admission, create_app, request_limit


class ModelRelayAdmissionTests(unittest.TestCase):
    def test_additional_allowance_requires_explicit_authorization_and_stays_bounded(self):
        self.assertEqual(request_limit({}), 300)
        with self.assertRaisesRegex(ValueError, 'additional_request_authorization_required'):
            request_limit({'NOCHEH_FIXTURE_MODEL_REQUEST_LIMIT': '301'})
        authorized = {'NOCHEH_ADDITIONAL_MODEL_REQUESTS_AUTHORIZED': '1'}
        self.assertEqual(request_limit({**authorized, 'NOCHEH_FIXTURE_MODEL_REQUEST_LIMIT': '3000'}), 3000)
        for invalid in ('0', '-1', '10001', 'unlimited'):
            with self.assertRaises(ValueError):
                request_limit({**authorized, 'NOCHEH_FIXTURE_MODEL_REQUEST_LIMIT': invalid})

    def test_increased_allowance_preserves_all_previous_admissions(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'calls.jsonl'
            credentials = {'hermes': ('local', 'existing')}
            first = Admission(path, credentials, limit=1)
            payload = {'model': 'gpt-5.6-sol', 'messages': []}
            first.reserve('Bearer local', payload)
            previous = path.read_bytes()
            increased = Admission(path, credentials, limit=400)
            self.assertEqual(increased.summary()['requests'], 1)
            increased.reserve('Bearer local', payload)
            self.assertTrue(path.read_bytes().startswith(previous))
            self.assertEqual([json.loads(row)['number'] for row in path.read_text().splitlines()], [1, 2])

    def test_auth_model_and_restart_limit_fail_closed_without_sensitive_journal(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'calls.jsonl'
            credentials = {'hermes': ('synthetic-local-token', 'existing-provider-token')}
            admission = Admission(path, credentials, limit=1)
            payload = {'model': 'gpt-5.6-sol', 'messages': [{'role': 'user', 'content': 'synthetic-private-source'}]}
            with self.assertRaises(PermissionError):
                admission.reserve('Bearer wrong', payload)
            with self.assertRaises(ValueError):
                admission.reserve('Bearer synthetic-local-token', {**payload, 'model': 'another-model'})
            self.assertFalse(path.exists())
            self.assertEqual(admission.reserve('Bearer synthetic-local-token', payload), 'existing-provider-token')
            restarted = Admission(path, credentials, limit=1)
            with self.assertRaises(PermissionError):
                restarted.reserve('Bearer synthetic-local-token', payload)
            saved = path.read_text()
            for value in ('synthetic-local-token', 'existing-provider-token', 'synthetic-private-source'):
                self.assertNotIn(value, saved)
            self.assertEqual(json.loads(saved)['client'], 'hermes')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_concurrent_admission_never_exceeds_bound(self):
        with tempfile.TemporaryDirectory() as folder:
            admission = Admission(Path(folder) / 'calls.jsonl', {'hermes': ('local', 'existing')}, limit=3)
            def attempt(_):
                try:
                    admission.reserve('Bearer local', {'model': 'gpt-5.6-sol', 'messages': []})
                    return True
                except PermissionError:
                    return False
            with ThreadPoolExecutor(max_workers=10) as pool:
                self.assertEqual(sum(pool.map(attempt, range(20))), 3)
            self.assertEqual(admission.summary()['requests'], 3)


class ModelRelayTransportTests(unittest.TestCase):
    def test_scoped_key_stream_and_telegram_stay_on_separate_transports(self):
        from fastapi.testclient import TestClient
        calls = []
        class Opener:
            def open(self, request, timeout):
                calls.append(request)
                response = io.BytesIO(b'data: {"choices":[]}\n\ndata: [DONE]\n\n')
                response.status = 200
                response.headers = {'Content-Type': 'text/event-stream'}
                return response
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {'NOCHEH_INSTALLATION_FIXTURE': '1'}):
            folder = Path(folder)
            admission = Admission(folder / 'calls.jsonl', {'hermes': ('fixture-only', 'existing-provider-key')})
            app = create_app(admission, 'http://nocheh-cliproxy-api-1:8317/v1/chat/completions', folder / 'telegram.json', Opener(), lambda: True)
            with TestClient(app) as client:
                payload = {'model': 'gpt-5.6-sol', 'messages': [], 'stream': True}
                self.assertEqual(client.post('/v1/chat/completions', json=payload).status_code, 403)
                self.assertEqual(client.post('/v1/embeddings', json=payload).status_code, 404)
                self.assertEqual(client.post('/bot123456:synthetic/getMe', json={}).status_code, 200)
                self.assertEqual(len(calls), 0)
                reply = client.post('/v1/chat/completions', headers={'Authorization': 'Bearer fixture-only'}, json=payload)
                self.assertEqual(reply.status_code, 200)
                self.assertIn('data: [DONE]', reply.text)
                self.assertEqual(calls[0].get_header('Authorization'), 'Bearer existing-provider-key')
                self.assertEqual(json.loads(calls[0].data), payload)
                self.assertEqual(admission.summary()['requests'], 1)

    def test_upstream_errors_do_not_forward_provider_bodies_or_headers(self):
        import urllib.error
        from fastapi.testclient import TestClient
        class Opener:
            def open(self, request, timeout):
                raise urllib.error.HTTPError(request.full_url, 429, 'private upstream details',
                                            {'secret': 'existing-provider-key'}, io.BytesIO(b'private upstream body'))
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {'NOCHEH_INSTALLATION_FIXTURE': '1'}):
            folder = Path(folder)
            admission = Admission(folder / 'calls.jsonl', {'hermes': ('fixture-only', 'existing-provider-key')})
            app = create_app(admission, 'http://nocheh-cliproxy-api-1:8317/v1/chat/completions', folder / 'telegram.json', Opener(), lambda: True)
            with TestClient(app) as client:
                reply = client.post('/v1/chat/completions', headers={'Authorization': 'Bearer fixture-only'},
                                    json={'model': 'gpt-5.6-sol', 'messages': []})
                self.assertEqual(reply.status_code, 429)
                self.assertEqual(reply.json(), {'error': {'message': 'existing_provider_rejected', 'status': 429}})
                self.assertNotIn('private', reply.text)
                self.assertNotIn('secret', reply.headers)

    def test_missing_existing_provider_fails_health_and_does_not_spend_admission(self):
        from fastapi.testclient import TestClient
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {'NOCHEH_INSTALLATION_FIXTURE': '1'}):
            folder = Path(folder)
            admission = Admission(folder / 'calls.jsonl', {'hermes': ('fixture-only', 'existing-provider-key')})
            app = create_app(admission, 'http://nocheh-cliproxy-api-1:8317/v1/chat/completions',
                             folder / 'telegram.json', route_probe=lambda: False)
            with TestClient(app) as client:
                self.assertEqual(client.get('/healthz').status_code, 503)
                reply = client.post('/v1/chat/completions', headers={'Authorization': 'Bearer fixture-only'},
                                    json={'model': 'gpt-5.6-sol', 'messages': []})
                self.assertEqual(reply.status_code, 503)
                self.assertEqual(reply.json(), {'error': {'message': 'existing_provider_unavailable'}})
                self.assertEqual(admission.summary()['requests'], 0)
                self.assertFalse((folder / 'calls.jsonl').exists())


if __name__ == '__main__':
    unittest.main()
