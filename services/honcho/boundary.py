"""Pinned Honcho context binding; the production gateway is the only inference egress."""
import contextvars
import functools
import re

WORKSPACE=contextvars.ContextVar('nocheh_honcho_workspace',default=None)

class WorkspaceMiddleware:
    def __init__(self,app): self.app=app
    async def __call__(self,scope,receive,send):
        match=re.match(r'^/v3/workspaces/([a-zA-Z0-9_-]+)(?:/|$)',scope.get('path',''))
        token=WORKSPACE.set(match[1] if match else None)
        try: await self.app(scope,receive,send)
        finally: WORKSPACE.reset(token)

def bind_worker(manager,parse):
    original=manager.process_work_unit
    @functools.wraps(original)
    async def run(self,key,*args,**kwargs):
        # A malformed key binds no workspace; Honcho's own handler marks its items errored and frees the worker slot.
        try: workspace=parse(key).workspace_name
        except ValueError: workspace=None
        token=WORKSPACE.set(workspace)
        try: return await original(self,key,*args,**kwargs)
        finally: WORKSPACE.reset(token)
    manager.process_work_unit=run

# The gateway's bounds on one embeddings request (meter.validate): inputs, and their UTF-8 bytes.
EMBEDDING_INPUTS,EMBEDDING_BYTES=100,131072

def reconciler_parts(rows):
    # A message's rows stay together and in order; each part fits one embeddings request the gateway accepts.
    # A message too large on its own goes alone, and the gateway decides.
    messages={}
    for row in rows: messages.setdefault(getattr(row,'message_id',None) or id(row),[]).append(row)
    part,count,size=[],0,0
    for group in messages.values():
        length=sum(len((getattr(row,'content',None) or '').encode()) for row in group)
        if part and (count+len(group)>EMBEDDING_INPUTS or size+length>EMBEDDING_BYTES):
            yield part;part,count,size=[],0,0
        part+=group;count+=len(group);size+=length
    if part: yield part

def bind_reconciler(module):
    # The vector reconciler's work unit names no workspace: one batch holds pending rows of any workspace, up to 50
    # messages in one embeddings request. Each workspace's rows are synced on their own with that workspace bound, so
    # the gateway prepares them for it as it did their first embedding, in parts the gateway accepts. A row without a
    # workspace stays unbound and fails closed.
    def per_workspace(original):
        @functools.wraps(original)
        async def run(db,rows,*args,**kwargs):
            groups={}
            for row in rows: groups.setdefault(getattr(row,'workspace_name',None) or None,[]).append(row)
            synced=failed=0
            for workspace,group in groups.items():
                token=WORKSPACE.set(workspace)
                try:
                    for part in reconciler_parts(group):
                        done,lost=await original(db,part,*args,**kwargs)
                        synced+=done;failed+=lost
                finally: WORKSPACE.reset(token)
            return synced,failed
        return run
    for name in ('_sync_message_embeddings','_sync_documents'): setattr(module,name,per_workspace(getattr(module,name)))

def install_transport(httpx,background=False):
    # Hook each physical attempt, including SDK retries and redirects. The SDK
    # has no direct Internet route; a call with no bound workspace fails closed.
    # The deriver's work is background learning: its secret checks yield to replies.
    original=httpx.AsyncClient._send_single_request
    async def send(self,request):
        if str(request.url).startswith('http://honcho-provider-gateway:8790/v1/'):
            workspace=WORKSPACE.get()
            if not workspace: raise RuntimeError('honcho_workspace_required')
            request.headers['X-Nocheh-Workspace']=workspace
            if background: request.headers['X-Nocheh-Priority']='background'
        return await original(self,request)
    httpx.AsyncClient._send_single_request=send
