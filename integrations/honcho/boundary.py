"""Pinned Honcho context binding; the isolated meter is the only inference egress."""
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
        token=WORKSPACE.set(parse(key).workspace_name)
        try: return await original(self,key,*args,**kwargs)
        finally: WORKSPACE.reset(token)
    manager.process_work_unit=run

def install_transport(httpx):
    # Hook each physical attempt, including SDK retries and redirects. The SDK
    # has no direct Internet route; unbound global reconciliation fails closed.
    original=httpx.AsyncClient._send_single_request
    async def send(self,request):
        if str(request.url).startswith('http://meter:8790/v1/'):
            workspace=WORKSPACE.get()
            if not workspace: raise RuntimeError('honcho_workspace_required')
            request.headers['X-Nocheh-Workspace']=workspace
        return await original(self,request)
    httpx.AsyncClient._send_single_request=send
