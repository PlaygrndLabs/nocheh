import unittest
from types import SimpleNamespace
from integrations.honcho.boundary import WORKSPACE,WorkspaceMiddleware,bind_worker,install_transport

class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_and_worker_bindings_are_scoped_and_always_reset(self):
        async def app(scope,receive,send): self.assertEqual(WORKSPACE.get(),'current')
        await WorkspaceMiddleware(app)({'path':'/v3/workspaces/current/peers/user/chat'},None,None)
        self.assertIsNone(WORKSPACE.get())
        class Manager:
            async def process_work_unit(self,key): return WORKSPACE.get()
        bind_worker(Manager,lambda key:SimpleNamespace(workspace_name=key))
        self.assertEqual(await Manager().process_work_unit('guarded'), 'guarded')
        self.assertIsNone(WORKSPACE.get())

    async def test_real_httpx_attempts_require_and_forward_workspace(self):
        import httpx
        original=httpx.AsyncClient._send_single_request;requests=[]
        install_transport(httpx)
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:requests.append(req) or httpx.Response(200,json={}))) as client:
                with self.assertRaisesRegex(RuntimeError,'honcho_workspace_required'):
                    await client.post('http://meter:8790/v1/embeddings',json={})
                token=WORKSPACE.set('current')
                try: await client.post('http://meter:8790/v1/embeddings',json={})
                finally: WORKSPACE.reset(token)
            self.assertEqual(len(requests),1)
            self.assertEqual(requests[0].headers['X-Nocheh-Workspace'],'current')
        finally: httpx.AsyncClient._send_single_request=original
