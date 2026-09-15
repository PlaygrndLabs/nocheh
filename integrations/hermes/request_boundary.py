"""Mandatory compatibility shim for pinned Hermes/OpenAI clients (httpx 0.28.1)."""
from __future__ import annotations

from integrations.hermes.environment import secret as environment_secret

import asyncio
import contextlib
import contextvars
import inspect
import json
import os
import urllib.request
import urllib.error
from collections import deque, Counter
from pathlib import Path
from urllib.parse import urlsplit

DETECTOR_CALL = contextvars.ContextVar('nocheh_trusted_detector', default=None)
DEFAULT_TRUSTED = ['https://chatgpt.com/backend-api/codex', 'http://cliproxy-api:8317/v1']
MAX_BODY = 1024*1024
FAILURES = deque(maxlen=30)
COUNTS = Counter()


class GuardUnavailable(RuntimeError):
    pass


def trusted(destination, endpoints):
    target=urlsplit(destination)
    if target.username or target.password:
        raise GuardUnavailable('invalid_destination')
    def origin(url):
        return (url.scheme,url.hostname,url.port or (443 if url.scheme=='https' else 80))
    return any(origin(target)==origin(base) and (target.path==base.path.rstrip('/') or target.path.startswith(base.path.rstrip('/')+'/'))
               for base in map(urlsplit,endpoints))


def required(mode,destination,endpoints):
    if mode not in ('off','on'):
        raise GuardUnavailable('invalid_guard_mode')
    return mode=='on'


@contextlib.contextmanager
def trusted_detector(endpoint='https://chatgpt.com/backend-api/codex'):
    token=DETECTOR_CALL.set(endpoint)
    try:
        yield
    finally:
        DETECTOR_CALL.reset(token)


def operational_request(request):
    """Only known transport/auth operations bypass model-payload inspection."""
    url=urlsplit(str(request.url))
    if url.scheme!='https' or url.username or url.password or url.port not in (None,443):
        return False
    if url.hostname=='auth.openai.com' and url.path in ('/oauth/token','/api/accounts/deviceauth/usercode','/api/accounts/deviceauth/token'):
        return True
    if url.hostname=='api.telegram.org' and (url.path.startswith('/bot') or url.path.startswith('/file/bot')):
        # Native Bot API operations have one token path component plus method;
        # a provider configured at .../chat/completions does not match.
        parts=url.path.strip('/').split('/')
        return (len(parts)==2 and parts[0].startswith('bot') and ':' in parts[0] and '/' not in parts[1]) or url.path.startswith('/file/bot')
    return request.method=='GET' and not request.content and url.hostname=='chatgpt.com' and url.path=='/backend-api/codex/models'


def clear_reasoning_sidecars(payload):
    """Pinned Responses compatibility: replay clear history without opaque reasoning.

    Native memory/history remains untouched. Unknown opaque inputs still fail
    closed in the guard service; previous_response_id is never trusted as history.
    """
    if isinstance(payload,dict) and isinstance(payload.get('input'),list):
        payload={**payload,'input':[item for item in payload['input'] if not (
            isinstance(item,dict) and item.get('type')=='reasoning' and 'encrypted_content' in item)]}
    return payload


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise GuardUnavailable('guard_redirect_rejected')


def guard_rpc(destination,payload):
    from .archive_tools import _PROCESS_CREDENTIAL, ARCHIVE_CREDENTIAL
    token=_PROCESS_CREDENTIAL or ARCHIVE_CREDENTIAL.get() or environment_secret('SERVICE_TOKEN')
    req=urllib.request.Request(os.environ.get('GUARD_URL','http://nocheh-security:8786')+'/v1/guard',
        data=json.dumps({'destination':destination,'payload':payload},ensure_ascii=False).encode(),
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open(req,timeout=120) as response:
            raw=response.read(MAX_BODY+1)
            if len(raw)>MAX_BODY:
                raise GuardUnavailable('guard_response_too_large')
            result=json.loads(raw)
            if result.get('guarded') is not True or 'payload' not in result:
                raise GuardUnavailable('guard_not_enforced')
            return result['payload']
    except urllib.error.HTTPError as error:
        try:
            code=json.loads(error.read(2048)).get('error')
        except Exception:
            code=None
        allowed={'guard_context_changed','detector_contract_rejected','uninspectable_model_context','detector_input_too_large','guard_request_too_large','guarded_key_collision','service_unavailable','hermes_unavailable','quota_paused'}
        raise GuardUnavailable(code if code in allowed else 'required_guard_unavailable') from None
    except Exception:
        # Do not include an upstream body, URL credentials, or original request.
        raise GuardUnavailable('required_guard_unavailable') from None


class Boundary:
    def __init__(self,mode='on',endpoints=None,transform=guard_rpc):
        if mode not in ('off','on'): raise GuardUnavailable('invalid_guard_mode')
        self.mode,self.endpoints,self.transform=mode,list(DEFAULT_TRUSTED if endpoints is None else endpoints),transform

    def needs_guard(self,request):
        destination=str(request.url)
        if detector_endpoint := DETECTOR_CALL.get():
            # The exemption can never survive a provider change/redirect.
            if not trusted(destination,[detector_endpoint]): raise GuardUnavailable('detector_destination_rejected')
            return False
        if operational_request(request): return False
        from .archive_tools import _PROCESS_CREDENTIAL, ARCHIVE_CREDENTIAL
        if _PROCESS_CREDENTIAL or ARCHIVE_CREDENTIAL.get(): return True
        return required(self.mode,destination,self.endpoints)

    def prepare(self,request):
        import httpx
        if not self.needs_guard(request): return request
        content=request.content
        if request.url.query:
            raise GuardUnavailable('uninspectable_model_query')
        if len(content)>MAX_BODY or 'application/json' not in request.headers.get('content-type',''):
            raise GuardUnavailable('uninspectable_model_request')
        try:
            payload=json.loads(content)
        except (ValueError,UnicodeError):
            raise GuardUnavailable('uninspectable_model_request') from None
        if not isinstance(payload,dict): raise GuardUnavailable('invalid_model_request')
        from .memory_evidence import inject
        from .timing import measure
        with measure('model_guard'):guarded=self.transform(str(request.url),inject(clear_reasoning_sidecars(payload)))
        if not isinstance(guarded,dict): raise GuardUnavailable('invalid_guard_response')
        headers=dict(request.headers)
        headers.pop('content-length',None);headers.pop('transfer-encoding',None)
        return httpx.Request(request.method,request.url,headers=headers,extensions=dict(request.extensions),
                             content=json.dumps(guarded,ensure_ascii=False,separators=(',',':')).encode())


def install(boundary=None):
    import httpx
    if getattr(httpx.Client._send_single_request,'_nocheh_boundary',False):
        raise GuardUnavailable('boundary_already_installed')
    if httpx.__version__!='0.28.1': raise GuardUnavailable('untested_httpx_revision')
    original_sync=httpx.Client._send_single_request
    original_async=httpx.AsyncClient._send_single_request
    for method in (original_sync,original_async):
        if list(inspect.signature(method).parameters)!=['self','request']:
            raise GuardUnavailable('unsupported_httpx_boundary')
    boundary=boundary or Boundary('on' if os.environ.get('GUARD_MODE','on')=='auto' else os.environ.get('GUARD_MODE','on'),json.loads(os.environ.get('GUARD_TRUSTED_ENDPOINTS',json.dumps(DEFAULT_TRUSTED))))
    def sync_send(client,request):
        COUNTS['attempts']+=1
        try:
            if boundary.needs_guard(request):
                COUNTS['required']+=1
                if int(request.headers.get('content-length',0))>MAX_BODY: raise GuardUnavailable('guard_request_too_large')
                request.read()
            prepared=boundary.prepare(request)
        except GuardUnavailable as error:
            FAILURES.append(str(error));raise
        COUNTS['sent']+=1
        return original_sync(client,prepared)
    async def async_send(client,request):
        COUNTS['attempts']+=1
        try:
            if boundary.needs_guard(request):
                COUNTS['required']+=1
                if int(request.headers.get('content-length',0))>MAX_BODY: raise GuardUnavailable('guard_request_too_large')
                await request.aread()
            guarded=await asyncio.to_thread(boundary.prepare,request)
        except GuardUnavailable as error:
            FAILURES.append(str(error));raise
        COUNTS['sent']+=1
        return await original_async(client,guarded)
    sync_send._nocheh_boundary=True
    async_send._nocheh_boundary=True
    httpx.Client._send_single_request=sync_send
    httpx.AsyncClient._send_single_request=async_send
    def restore():
        httpx.Client._send_single_request=original_sync
        httpx.AsyncClient._send_single_request=original_async
    return restore
