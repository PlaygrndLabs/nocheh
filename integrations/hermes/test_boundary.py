import asyncio
import json
import unittest
from types import SimpleNamespace
import httpx
from openai import OpenAI, AsyncOpenAI
from .request_boundary import Boundary, GuardUnavailable, install, trusted_detector


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.restores=[]

    def tearDown(self):
        for restore in reversed(self.restores): restore()

    def setup_boundary(self,transform,mode='on'):
        self.restores.append(install(Boundary(mode,transform=transform)))

    def test_real_sdk_retries_and_changed_destinations_see_only_guarded_content(self):
        seen=[];guarded=[]
        def transform(url,payload):
            guarded.append(url)
            return json.loads(json.dumps(payload).replace('planted-SECRET','***'))
        def sink(request):
            seen.append(json.loads(request.content))
            if len(seen)==1:return httpx.Response(503,json={'error':{'message':'retry'}})
            return httpx.Response(200,json={'id':'synthetic','choices':[{'message':{'role':'assistant','content':'ok'}}]})
        self.setup_boundary(transform)
        with OpenAI(api_key='synthetic',base_url='https://untrusted.example/v1',http_client=httpx.Client(transport=httpx.MockTransport(sink)),max_retries=1) as client:
            client.chat.completions.create(model='gpt-trusted-name',messages=[{'role':'user','content':'Aws planted-SECRET'},{'role':'tool','tool_call_id':'fixture','content':'planted-SECRET memory'}])
            client.base_url='https://other.example/v1/'
            client.chat.completions.create(model='gpt-trusted-name',messages=[{'role':'user','content':'planted-SECRET'}])
        self.assertEqual(len(seen),3);self.assertEqual(len(guarded),3)
        self.assertNotIn('planted-SECRET',json.dumps(seen));self.assertIn('Aws',json.dumps(seen))

    async def test_sync_and_async_guard_failure_produce_zero_protected_requests(self):
        requests=[]
        def fail(*args): raise GuardUnavailable('detector_quota')
        self.setup_boundary(fail)
        transport=httpx.MockTransport(lambda request: requests.append(request) or httpx.Response(200,json={}))
        with OpenAI(api_key='synthetic',base_url='https://untrusted.example/v1',http_client=httpx.Client(transport=transport),max_retries=0) as client:
            with self.assertRaises(Exception):client.chat.completions.create(model='fixture',messages=[{'role':'user','content':'planted-SECRET'}])
        async with AsyncOpenAI(api_key='synthetic',base_url='https://untrusted.example/v1',http_client=httpx.AsyncClient(transport=transport),max_retries=0) as client:
            with self.assertRaises(Exception):await client.chat.completions.create(model='fixture',messages=[{'role':'user','content':'planted-SECRET'}])
        self.assertEqual(requests,[])

    async def test_async_sdk_success_uses_guarded_payload(self):
        seen=[]
        def sink(request):
            seen.append(json.loads(request.content))
            return httpx.Response(200,json={'id':'synthetic','choices':[{'message':{'role':'assistant','content':'ok'}}]})
        self.setup_boundary(lambda url,payload:json.loads(json.dumps(payload).replace('planted-SECRET','***')))
        async with AsyncOpenAI(api_key='synthetic',base_url='https://untrusted.example/v1',http_client=httpx.AsyncClient(transport=httpx.MockTransport(sink)),max_retries=0) as client:
            await client.chat.completions.create(model='fixture',messages=[{'role':'user','content':'planted-SECRET'}])
        self.assertNotIn('planted-SECRET',json.dumps(seen));self.assertEqual(len(seen),1)

    def test_pinned_native_gate_refuses_non_httpx_routes_before_starting_them(self):
        from .compatibility_patch import install as install_native
        from agent import chat_completion_helpers as calls, auxiliary_client as aux
        from agent.transports.codex_app_server_session import CodexAppServerSession
        restore=install_native()
        try:
            for call in (calls.direct_api_call,calls.interruptible_api_call,calls.interruptible_streaming_api_call):
                with self.assertRaises(GuardUnavailable):call(SimpleNamespace(api_mode='bedrock_converse',provider='bedrock'),{})
            with self.assertRaises(GuardUnavailable):aux.resolve_provider_client('bedrock',model='synthetic')
            with self.assertRaises(GuardUnavailable):CodexAppServerSession()
        finally:restore()

    def test_trusted_redirect_is_rechecked_before_untrusted_destination(self):
        destinations=[]
        def sink(request):
            destinations.append(str(request.url))
            return httpx.Response(307,headers={'Location':'https://untrusted.example/responses'})
        def fail(*args): raise GuardUnavailable('guard_down')
        self.setup_boundary(fail)
        with httpx.Client(transport=httpx.MockTransport(sink),follow_redirects=True) as client:
            with self.assertRaises(GuardUnavailable):client.post('https://chatgpt.com/backend-api/codex/responses',json={'input':'planted-SECRET'})
        self.assertEqual(destinations,[])

    def test_detector_exemption_is_confined_to_trusted_endpoint_and_reset(self):
        seen=[]
        def fail(*args):raise GuardUnavailable('guard_down')
        self.setup_boundary(fail,mode='on')
        with httpx.Client(transport=httpx.MockTransport(lambda req:seen.append(req) or httpx.Response(200,json={}))) as client:
            with trusted_detector():
                client.post('https://chatgpt.com/backend-api/codex/responses',json={'input':'planted-SECRET'})
                with self.assertRaises(GuardUnavailable):client.post('https://untrusted.example/responses',json={'input':'planted-SECRET'})
            with self.assertRaises(GuardUnavailable):client.post('https://chatgpt.com/backend-api/codex/responses',json={'input':'planted-SECRET'})
        self.assertEqual(len(seen),1)

    def test_detector_exemption_can_be_bound_to_only_the_shared_provider(self):
        seen=[]
        self.setup_boundary(lambda *_: (_ for _ in ()).throw(GuardUnavailable('guard_down')))
        with httpx.Client(transport=httpx.MockTransport(lambda req:seen.append(req) or httpx.Response(200,json={}))) as client:
            with trusted_detector('http://cliproxy:8317/v1'):
                client.post('http://cliproxy:8317/v1/chat/completions',json={'messages':[]})
                with self.assertRaises(GuardUnavailable):
                    client.post('https://chatgpt.com/backend-api/codex/responses',json={'input':'secret'})
        self.assertEqual(len(seen),1)

    def test_required_guard_drops_only_opaque_reasoning_sidecars_and_preserves_original_request(self):
        payload={'instructions':'Aws original','input':[{'role':'user','content':'exact\r\n😃  '},{'type':'reasoning','encrypted_content':'opaque'}]}
        request=httpx.Request('POST','https://untrusted.example/responses',json=payload)
        original=request.content
        prepared=Boundary(transform=lambda u,p:p).prepare(request)
        self.assertEqual(json.loads(prepared.content)['input'],payload['input'][:1]);self.assertEqual(request.content,original)
        with self.assertRaises(GuardUnavailable):Boundary().prepare(httpx.Request('POST','https://untrusted.example/responses?prompt=raw',json=payload))
        with self.assertRaises(GuardUnavailable):Boundary().prepare(httpx.Request('POST','https://untrusted.example/responses',content=b'raw audio'))


if __name__=='__main__':unittest.main()
