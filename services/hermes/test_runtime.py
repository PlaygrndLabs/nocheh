import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


class RuntimeConcurrencyTests(unittest.TestCase):
    def test_native_review_route_hands_off_and_observation_does_not_resolve_credentials(self):
        from . import runtime
        handler=object.__new__(runtime.Handler);handler.path='/internal/memory/review'
        body={'id':'a'*64,'scope':'42'}
        with patch('services.hermes.review_worker.start',return_value={'state':'running'}) as start,\
             patch('services.hermes.review_worker.observe',return_value={'state':'done'}) as observe,\
             patch('services.hermes.scopes.Scopes.load',return_value='synthetic-policy'),\
             patch.object(runtime,'resolve_credentials',return_value='synthetic-credentials') as credentials:
            self.assertEqual(handler.dispatch(body),{'state':'running'})
            start.assert_called_once_with(runtime.PROFILE_HOME,'synthetic-policy',runtime.MODEL,'synthetic-credentials',body)
            credentials.assert_called_once();credentials.reset_mock()
            self.assertEqual(handler.dispatch({**body,'observe_only':True}),{'state':'done'})
            credentials.assert_not_called();observe.assert_called_once()

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

    def test_detector_requests_run_side_by_side_up_to_the_guard_check_setting(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'HERMES_HOME':folder,'SERVICE_TOKEN':'synthetic-service-token-123456789'}):
            from . import runtime
            lock=threading.Lock();state={'active':0,'peak':0};release=threading.Event()
            class Fixture(runtime.Handler):
                def dispatch(self,body):
                    with lock:state['active']+=1;state['peak']=max(state['peak'],state['active'])
                    try:release.wait(2)
                    finally:
                        with lock:state['active']-=1
                    return {'route':self.path}
            server=ThreadingHTTPServer(('127.0.0.1',0),Fixture)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            def request():
                req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/internal/detect',data=b'{}',headers={'Authorization':'Bearer '+runtime.TOKEN})
                with urllib.request.urlopen(req,timeout=5) as response:return json.load(response)
            try:
                with patch.object(runtime,'DETECTOR_SLOTS',runtime.DetectorSlots(2)),ThreadPoolExecutor(max_workers=3) as workers:
                    calls=[workers.submit(request) for _ in range(3)]
                    for _ in range(50):
                        with lock:
                            if state['active']==2:break
                        threading.Event().wait(.02)
                    threading.Event().wait(.2)
                    with lock:self.assertEqual(state['active'],2,'two checks run at once and the third waits')
                    release.set()
                    self.assertEqual([call.result()['route'] for call in calls],['/internal/detect']*3)
                self.assertEqual(state['peak'],2)
            finally:release.set();server.shutdown();server.server_close();thread.join()

    def test_reply_checks_go_before_background_learning_checks(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'HERMES_HOME':folder,'SERVICE_TOKEN':'synthetic-service-token-123456789'}):
            from . import runtime
            slots=runtime.DetectorSlots(2);order=[];held=threading.Event()
            def check(name,background):
                with slots.slot(background):
                    order.append(name);held.wait(2)
            def started(count):
                for _ in range(100):
                    with slots.changed:
                        if slots.used+slots.waiting>=count:return
                    threading.Event().wait(.01)
            first=threading.Thread(target=check,args=('learning-1',True));first.start();started(1)
            # Background learning leaves the second slot free for a reply.
            waiting=threading.Thread(target=check,args=('learning-2',True));waiting.start();threading.Event().wait(.1)
            self.assertEqual(order,['learning-1'])
            reply=threading.Thread(target=check,args=('reply-1',False));reply.start();started(2)
            for _ in range(100):
                if 'reply-1' in order:break
                threading.Event().wait(.01)
            self.assertEqual(order,['learning-1','reply-1'])
            # With both slots busy, a waiting reply takes the next free slot.
            late=threading.Thread(target=check,args=('reply-2',False));late.start()
            for _ in range(100):
                with slots.changed:
                    if slots.waiting:break
                threading.Event().wait(.01)
            held.set()
            for thread in (first,waiting,reply,late):thread.join(3)
            self.assertLess(order.index('reply-2'),order.index('learning-2'))
            self.assertEqual((slots.used,slots.background,slots.waiting),(0,0,0))

    def test_unconfigured_provider_answers_provider_not_configured(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'HERMES_HOME':folder,'SERVICE_TOKEN':'synthetic-service-token-123456789',
                                                                              'NOCHEH_REPLY_ROUTE_URL':'','NOCHEH_GUARD_ROUTE_URL':''}):
            from . import runtime
            server=ThreadingHTTPServer(('127.0.0.1',0),runtime.Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                for route in ('/internal/detect','/internal/security/transport'):
                    req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+route,data=b'{"text":"synthetic"}',
                                               headers={'Authorization':'Bearer '+runtime.TOKEN})
                    with self.subTest(route=route),self.assertRaises(urllib.error.HTTPError) as raised:
                        urllib.request.urlopen(req,timeout=5)
                    self.assertEqual((raised.exception.code,json.load(raised.exception)),(503,{'error':'provider_not_configured'}))
            finally:server.shutdown();server.server_close();thread.join()

    def test_chat_route_reaches_the_chat_function(self):
        # A local named chat elsewhere in dispatch() once shadowed the function.
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'HERMES_HOME':folder,'SERVICE_TOKEN':'synthetic-service-token-123456789'}):
            from . import runtime
            handler=object.__new__(runtime.Handler);handler.path='/internal/chat'
            with patch.object(runtime,'chat',return_value={'text':'synthetic reply'}) as called:
                self.assertEqual(handler.dispatch({'text':'synthetic'}),{'text':'synthetic reply'})
            called.assert_called_once_with('synthetic')

    def test_new_profile_never_transcribes_voice_notes(self):
        from . import runtime
        with tempfile.TemporaryDirectory() as folder,patch.object(runtime,'PROFILE_HOME',Path(folder)):
            runtime.configure()
            config=(Path(folder)/'config.yaml').read_text()
        self.assertIn('provider: openai\n',config);self.assertIn('stt:\n  enabled: false\n',config)
