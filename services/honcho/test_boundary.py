import unittest
from types import SimpleNamespace
from services.honcho.boundary import EMBEDDING_BYTES,EMBEDDING_INPUTS,PART_BYTES,WORKSPACE,WorkspaceMiddleware,bind_reconciler,bind_worker,install_transport,reconciler_parts

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

    async def test_malformed_work_unit_reaches_honcho_unbound_and_frees_the_slot(self):
        def parse(key):
            if key.count(':')!=3: raise ValueError('Invalid work_unit_key format')
            return SimpleNamespace(workspace_name=key.split(':')[1])
        class Manager:
            seen=[];released=[]
            async def process_work_unit(self,key,worker):
                try:
                    try: parse(key)
                    except ValueError: Manager.seen.append(('errored',WORKSPACE.get()));return
                    Manager.seen.append(('processed',WORKSPACE.get()))
                finally: Manager.released.append(worker)
        bind_worker(Manager,parse)
        await Manager().process_work_unit('representation:broken','worker-1')
        await Manager().process_work_unit('representation:current:conversation:owner','worker-2')
        self.assertEqual(Manager.seen,[('errored',None),('processed','current')])
        self.assertEqual(Manager.released,['worker-1','worker-2'])
        self.assertIsNone(WORKSPACE.get())

    async def test_real_httpx_attempts_require_and_forward_workspace(self):
        import httpx
        original=httpx.AsyncClient._send_single_request;requests=[]
        install_transport(httpx)
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:requests.append(req) or httpx.Response(200,json={}))) as client:
                with self.assertRaisesRegex(RuntimeError,'honcho_workspace_required'):
                    await client.post('http://honcho-provider-gateway:8790/v1/embeddings',json={})
                token=WORKSPACE.set('current')
                try: await client.post('http://honcho-provider-gateway:8790/v1/embeddings',json={})
                finally: WORKSPACE.reset(token)
            self.assertEqual(len(requests),1)
            self.assertEqual(requests[0].headers['X-Nocheh-Workspace'],'current')
            self.assertNotIn('X-Nocheh-Priority',requests[0].headers)
        finally: httpx.AsyncClient._send_single_request=original

    async def test_deriver_requests_are_marked_background(self):
        import httpx
        original=httpx.AsyncClient._send_single_request;requests=[]
        install_transport(httpx,background=True)
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:requests.append(req) or httpx.Response(200,json={}))) as client:
                token=WORKSPACE.set('current')
                try: await client.post('http://honcho-provider-gateway:8790/v1/chat/completions',json={})
                finally: WORKSPACE.reset(token)
            self.assertEqual(requests[0].headers['X-Nocheh-Priority'],'background')
        finally: httpx.AsyncClient._send_single_request=original

    async def test_reconciler_syncs_each_workspace_bound_and_rows_without_one_fail_closed(self):
        import httpx
        original=httpx.AsyncClient._send_single_request;requests=[]
        install_transport(httpx,background=True)
        try:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req:requests.append(req) or httpx.Response(200,json={}))) as client:
                class Reconciler:
                    calls=[]
                    # Like Honcho's own batch sync: an embedding call that fails leaves its rows pending, counted as failed.
                    @staticmethod
                    async def _sync_message_embeddings(db,rows,store):
                        Reconciler.calls.append((db,store,WORKSPACE.get(),[row.id for row in rows]))
                        try: await client.post('http://honcho-provider-gateway:8790/v1/embeddings',json={})
                        except RuntimeError: return 0,len(rows)
                        return len(rows),0
                    @staticmethod
                    async def _sync_documents(db,rows,store):
                        if rows[0].id=='broken': raise ValueError('broken')
                        return len(rows),0
                bind_reconciler(Reconciler)
                row=lambda id,workspace:SimpleNamespace(id=id,workspace_name=workspace)
                rows=[row('a1','alpha'),row('b1','beta'),row('n1',None),row('a2','alpha'),row('e1','')]
                self.assertEqual(await Reconciler._sync_message_embeddings('db',rows,None),(3,2))
                self.assertEqual(Reconciler.calls,[('db',None,'alpha',['a1','a2']),('db',None,'beta',['b1']),('db',None,None,['n1','e1'])])
                self.assertEqual([(r.headers['X-Nocheh-Workspace'],r.headers['X-Nocheh-Priority']) for r in requests],[('alpha','background'),('beta','background')])
                self.assertEqual(await Reconciler._sync_message_embeddings('db',[],None),(0,0))
                self.assertEqual(await Reconciler._sync_documents('db',[row('d1','alpha')],'store'),(1,0))
                with self.assertRaises(ValueError): await Reconciler._sync_documents('db',[row('broken','alpha')],'store')
                self.assertIsNone(WORKSPACE.get())
        finally: httpx.AsyncClient._send_single_request=original

    def test_reconciler_parts_fit_the_gateway_and_keep_messages_whole(self):
        from services.honcho.meter import Rejected,validate
        chunk=lambda message,size:SimpleNamespace(message_id=message,content='ن'*(size//2))
        rows=[chunk('m1',60000),chunk('m2',40000),chunk('m1',60000),chunk('m3',40000),chunk('big',70000),chunk('big',70000)]
        rows+=[chunk(f's{i}',100) for i in range(150)]
        parts=list(reconciler_parts(rows))
        self.assertEqual([[row.message_id for row in part][:3] for part in parts],[['m1','m1'],['m2','m3'],['big','big'],['s0','s1','s2'],['s100','s101','s102']])
        self.assertEqual([len(part) for part in parts],[2,2,2,100,50])
        self.assertEqual([row for part in parts for row in part],sorted(rows,key=lambda row:[r.message_id for r in rows].index(row.message_id)))
        payload=lambda part:{'model':'text-embedding-3-small','input':[row.content for row in part]}
        for part in parts[:2]+parts[3:]:
            self.assertLessEqual(sum(len(row.content.encode()) for row in part),PART_BYTES)
            validate('/v1/embeddings',payload(part))
        # Several messages fill a part only up to the room left for preparation.
        near=[chunk(f'n{i}',40000) for i in range(4)]
        self.assertEqual([len(part) for part in reconciler_parts(near)],[3,1])
        # One message larger than a request goes alone; the gateway refuses it and only its rows fail.
        with self.assertRaisesRegex(Rejected,'embedding_bound_exceeded'): validate('/v1/embeddings',payload(parts[2]))
        # The bounds are the gateway's own.
        validate('/v1/embeddings',{'model':'text-embedding-3-small','input':['a']*EMBEDDING_INPUTS})
        validate('/v1/embeddings',{'model':'text-embedding-3-small','input':['a'*EMBEDDING_BYTES]})
        with self.assertRaises(Rejected): validate('/v1/embeddings',{'model':'text-embedding-3-small','input':['a']*(EMBEDDING_INPUTS+1)})
        with self.assertRaises(Rejected): validate('/v1/embeddings',{'model':'text-embedding-3-small','input':['a'*(EMBEDDING_BYTES+1)]})
        self.assertEqual(list(reconciler_parts([])),[])
