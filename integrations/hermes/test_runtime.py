import json
import os
import tempfile
import threading
import unittest
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


class RuntimeConcurrencyTests(unittest.TestCase):
    def test_file_and_detector_requests_progress_while_chat_is_waiting(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'HERMES_HOME':folder,'SERVICE_TOKEN':'synthetic-service-token-123456789'}):
            from . import runtime
            entered=threading.Event();release=threading.Event()
            class Fixture(runtime.Handler):
                def dispatch(self,body):
                    if self.path=='/internal/chat':
                        entered.set()
                        if not release.wait(5):raise RuntimeError('fixture_timeout')
                    return {'route':self.path}
            server=ThreadingHTTPServer(('127.0.0.1',0),Fixture)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            def request(route):
                req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+route,data=b'{}',headers={'Authorization':'Bearer '+runtime.TOKEN})
                with urllib.request.urlopen(req,timeout=2) as response:return json.load(response)
            try:
                with ThreadPoolExecutor(max_workers=3) as workers:
                    chat=workers.submit(request,'/internal/chat')
                    try:
                        self.assertTrue(entered.wait(1))
                        self.assertEqual(request('/internal/file')['route'],'/internal/file')
                        self.assertEqual(request('/internal/detect')['route'],'/internal/detect')
                        self.assertFalse(chat.done())
                    finally:release.set()
                    self.assertEqual(chat.result()['route'],'/internal/chat')
            finally:release.set();server.shutdown();server.server_close();thread.join()

    def test_credential_resolution_shares_the_refresh_lock(self):
        from .subscription import AUTH_LOCK, resolve_credentials, CODEX_BASE_URL
        attempted=threading.Event();called=threading.Event()
        def native():
            called.set();return {'auth_mode':'chatgpt','api_key':'synthetic','base_url':CODEX_BASE_URL}
        def resolve():attempted.set();return resolve_credentials()
        with patch('hermes_cli.auth_codex.resolve_codex_runtime_credentials',side_effect=native), ThreadPoolExecutor(max_workers=1) as workers:
            with AUTH_LOCK:
                result=workers.submit(resolve)
                self.assertTrue(attempted.wait(1));self.assertFalse(called.is_set())
            self.assertEqual(result.result(timeout=1).access_token,'synthetic')

    def test_health_reads_login_presence_from_the_shared_speech_boundary(self):
        from . import runtime
        class Health(BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_GET(self):
                body=b'{"login_present":true}';self.send_response(200)
                self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        server=ThreadingHTTPServer(('127.0.0.1',0),Health)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with patch.dict(os.environ,{'NOCHEH_REASONING_ROUTE':'shared','SPEECH_URL':f'http://127.0.0.1:{server.server_port}'}):
                self.assertTrue(runtime.login_present())
            with tempfile.TemporaryDirectory() as folder,patch.object(runtime,'PROFILE_HOME',Path(folder)),patch.dict(os.environ,{'NOCHEH_REASONING_ROUTE':'native'}):
                self.assertFalse(runtime.login_present());(Path(folder)/'auth.json').touch();self.assertTrue(runtime.login_present())
        finally:server.shutdown();server.server_close();thread.join()
