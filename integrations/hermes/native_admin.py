"""Pinned Hermes administration over real state, without a second agent or gateway.

A separate process keeps native profile-local caches out of the running supervisor.
Only verified read routes and revision-checked owner operations reach native code.
"""
import asyncio
import contextlib
import hmac
import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlencode
from .scopes import Scopes, Scope
from .profile_config import (read, revision, resolved, inherited_config, inspect_profile,
                             configure_profile, atomic_yaml, PREFERENCES, profile_revision, policy_root)

NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}')


def audience_revision(token,space):
    from urllib.request import Request,urlopen
    request=Request(os.environ.get('ARCHIVE_URL','http://archive:8780')+'/v1/memory/spaces?'+urlencode({'id':space}),headers={'Authorization':'Bearer '+token})
    with urlopen(request,timeout=5) as response:value=json.load(response)['revision']
    if type(value) is not int or value<1:raise ValueError('invalid_audience_revision')
    return value


class Administration:
    def __init__(self, app, root, model, policy, token, browser_enabled=False, revision_reader=None):
        self.app, self.root, self.model = app, Path(root).resolve(), model
        self.policy, self.token = policy, token
        self.lock = asyncio.Lock()
        self.browser_enabled = browser_enabled
        self.revision_reader = revision_reader

    def binding(self,name):
        if not self.policy.owner:raise ValueError('owner_profile_unavailable')
        if not name or name in ('default','current'):name=Scopes.profile(self.policy.owner)
        path=self.root/'profiles'/name
        if name==Scopes.profile(self.policy.owner):return Scope(self.policy.owner,self.policy.owner,True,name,self.policy.owner)
        if (path/'nocheh-owner-profile.json').is_file():return Scope(self.policy.owner,self.policy.owner,True,name,self.policy.owner)
        current_revision=self.revision_reader(self.policy.owner) if self.revision_reader else 0
        for chat in self.policy.groups:
            revision=current_revision
            current=Scopes.profile(chat+':policy:'+str(revision)) if revision else Scopes.profile(chat)
            if name in (Scopes.profile(chat),current):return Scope(chat,self.policy.owner,False,current,chat,revision)
        marker=path/'space.json'
        if marker.is_file() and not marker.is_symlink():
            value=json.loads(marker.read_text());space=value.get('space','');chat=space.split('/topic/')[0];revision=value.get('revision')
            if chat in self.policy.groups and value.get('owner') is False and type(revision) is int and revision>0 and name==Scopes.profile(space+':policy:'+str(revision)):
                if self.revision_reader and revision!=current_revision:raise ValueError('profile_policy_changed')
                return Scope(chat,self.policy.owner,False,name,space,revision)
        if (path/'nocheh-owner-profile.json').is_file():return Scope(self.policy.owner,self.policy.owner,True,name,self.policy.owner)
        raise ValueError('profile_scope_denied')

    def preference_home(self,name,home):
        bound=self.binding(name)
        return self.root/'profiles'/Scopes.profile(bound.space) if bound.revision else home

    def profile(self, name):
        if not name or name in ('default', 'current'):
            if not self.policy.owner: raise ValueError('owner_profile_unavailable')
            name = Scopes.profile(self.policy.owner)
        if not NAME.fullmatch(name): raise ValueError('profile_scope_denied')
        path = self.root / 'profiles' / name
        if path.is_symlink() or not path.resolve().is_relative_to(self.root / 'profiles'):
            raise ValueError('profile_path_denied')
        binding=self.binding(name);name=binding.profile;path=self.root/'profiles'/name
        if path.is_symlink():raise ValueError('profile_path_denied')
        return name, path

    def profiles(self):
        names = [Scopes.profile(chat) for chat in [self.policy.owner, *self.policy.groups] if chat]
        parent = self.root / 'profiles'
        if parent.exists():
            names += [p.name for p in parent.iterdir() if not p.is_symlink() and (p / 'nocheh-owner-profile.json').is_file() and p.name not in names]
        result = []
        for name in names:
            name, path = self.profile(name)
            managed = name.startswith('nocheh-')
            owner = name == (Scopes.profile(self.policy.owner) if self.policy.owner else '') or not managed
            result.append({'name': name, 'path': str(path), 'is_default': name == (Scopes.profile(self.policy.owner) if self.policy.owner else ''),
                           'model': self.model, 'provider': 'openai-codex', 'has_env': False,
                           'skill_count': 0, 'gateway_running': False, 'has_alias': False,
                           'description': 'Owner private' if owner else 'Managed Telegram group',
                           'scope': 'owner' if owner else 'group', 'managed': managed, 'exists': path.exists()})
        return {'profiles': result}

    def config(self, path):
        from hermes_cli.config import DEFAULT_CONFIG, _deep_merge
        from hermes_cli.web_server_config import _normalize_config_for_web
        from .policy_config import document
        policy = document(policy_root(path))
        original = read(path / 'config.yaml')
        effective, _ = inherited_config(path, original, policy=policy)
        native = _normalize_config_for_web(_deep_merge(DEFAULT_CONFIG, resolved(effective, self.model)))
        def redact(value):
            if isinstance(value, dict):
                return {k: ('[managed secret]' if re.search(r'api.?key|token|password|credential|secret', k, re.I) and v else redact(v))
                        for k, v in value.items() if not k.startswith('_') and k != 'nocheh'}
            if isinstance(value, list): return [redact(v) for v in value]
            return value
        return {**redact(native), "_nocheh_revision": profile_revision(original, policy)}, profile_revision(original, policy)

    async def metadata_socket(self, scope, receive, send):
        """Native sidebar connection metadata only; never a second agent session."""
        from starlette.websockets import WebSocket,WebSocketDisconnect
        ws=WebSocket(scope,receive,send);await ws.accept();session=None
        await ws.send_json({'jsonrpc':'2.0','method':'event','params':{'type':'gateway.ready','payload':{'heartbeat':True}}})
        try:
            while True:
                raw=await ws.receive_text()
                if len(raw)>16384: await ws.close(code=1008);return
                request=json.loads(raw);method=request.get('method');params=request.get('params') or {};result=None
                if method=='session.create' and params.get('source')=='tool':
                    name,_=self.profile(params.get('profile'));session='metadata-'+uuid.uuid4().hex
                    info={'model':self.model,'provider':'openai-codex','profile_name':name,'lazy':True,'read_only':True}
                    result={'session_id':session,'info':info}
                    await ws.send_json({'jsonrpc':'2.0','method':'event','params':{'type':'session.info','session_id':session,'payload':info}})
                elif method=='ping': result={'pong':True}
                elif method=='session.close' and params.get('session_id')==session: result={'closed':True}
                if result is None:
                    await ws.send_json({'jsonrpc':'2.0','id':request.get('id'),'error':{'code':4032,'message':'managed_metadata_only'}})
                else: await ws.send_json({'jsonrpc':'2.0','id':request.get('id'),'result':result})
        except WebSocketDisconnect: pass
        except (ValueError,TypeError,AttributeError): await ws.close(code=1008)

    async def __call__(self, scope, receive, send):
        from starlette.requests import Request
        from starlette.responses import JSONResponse
        if scope['type'] == 'lifespan': return await self.app(scope, receive, send)
        if scope['type'] == 'websocket':
            query=parse_qs(scope.get('query_string',b'').decode(),keep_blank_values=True)
            supplied=query.get('token',[''])[0]
            if not self.browser_enabled or scope['path'] not in ('/api/pty','/api/ws','/api/pub','/api/events') or not self.token or not hmac.compare_digest(supplied,self.token):
                await send({'type':'websocket.close','code':1008});return
            try:
                if any(len(values)!=1 for values in query.values()): raise ValueError('ambiguous_query')
                name,home=self.profile(query.get('profile',[''])[0])
                if resume:=query.get('resume',[''])[0]:
                    from hermes_state import SessionDB
                    from .isolated_profile import database_path
                    if not database_path(home).is_file(): raise ValueError('session_not_in_profile')
                    db=SessionDB(database_path(home),read_only=True)
                    try:
                        if not db.get_session(resume): raise ValueError('session_not_in_profile')
                    finally: db.close()
                query['profile']=[name]
                if scope['path']!='/api/pub' and (channel:=query.get('channel',[''])[0]):
                    query['channel']=['nocheh-'+hashlib.sha256((name+':'+channel).encode()).hexdigest()[:32]]
            except ValueError:
                await send({'type':'websocket.close','code':1008});return
            # This authenticated internal connection was verified by Nocheh's
            # loopback browser boundary; the Docker transport is a proxy peer.
            forwarded={**scope,'client':('127.0.0.1',0),'query_string':urlencode(query,doseq=True).encode()}
            if scope['path']=='/api/ws': return await self.metadata_socket(forwarded,receive,send)
            return await self.app(forwarded,receive,send)
        if scope['type'] != 'http': return
        headers = dict(scope['headers'])
        supplied = headers.get(b'x-hermes-session-token', b'').decode()
        if not self.token or not hmac.compare_digest(supplied, self.token):
            return await JSONResponse({'error': 'unauthorized'}, 401)(scope, receive, send)
        async with self.lock:
            try:
                query = parse_qs(scope.get('query_string', b'').decode(), keep_blank_values=True)
                if any(len(values) != 1 for values in query.values()): raise ValueError('ambiguous_query')
                path, method = scope['path'], scope['method']
                selected=query.get('profile', [''])[0]
                name, home = self.profile('' if selected=='all' and path.startswith('/api/cron/') else selected)
                if path.startswith('/api/files') and (method, path) in {
                    ('GET','/api/files'), ('GET','/api/files/read'), ('GET','/api/files/download'),
                    ('GET','/api/files/stream'), ('HEAD','/api/files/stream'), ('POST','/api/files/upload'),
                    ('POST','/api/files/upload-stream'), ('POST','/api/files/mkdir'), ('DELETE','/api/files')}:
                    workspace = home / 'workspace'
                    if workspace.is_symlink() or not workspace.resolve().is_relative_to(home.resolve()):
                        raise ValueError('workspace_path_denied')
                    if not workspace.exists() and method == 'GET':
                        if path == '/api/files' and query.get('path', [''])[0] in ('', '.', '/'):
                            return await JSONResponse({'path': str(workspace), 'parent': None, 'entries': [],
                                'root': str(workspace), 'can_change_path': False})(scope, receive, send)
                        return await JSONResponse({'error':'file_not_found'},404)(scope, receive, send)
                    if method not in ('GET','HEAD'): workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
                    previous = os.environ.get('HERMES_DASHBOARD_FILES_ROOT')
                    os.environ['HERMES_DASHBOARD_FILES_ROOT'] = str(workspace)
                    try: return await self.app(scope, receive, send)
                    finally:
                        if previous is None: os.environ.pop('HERMES_DASHBOARD_FILES_ROOT', None)
                        else: os.environ['HERMES_DASHBOARD_FILES_ROOT'] = previous
                req = Request(scope, receive)
                body = {}
                if method not in ('GET', 'HEAD'):
                    raw = bytearray()
                    async for chunk in req.stream():
                        raw.extend(chunk)
                        if len(raw) > (36 if path=='/api/chat/image-upload' else 1) * 1024 * 1024: raise ValueError('body_size_limit')
                    body = json.loads(raw or b'{}')
                    if not isinstance(body, dict): raise ValueError('expected_object')
                    if body.get('profile'):
                        body_name, _ = self.profile(body['profile'])
                        if query.get('profile') and body_name != name: raise ValueError('profile_scope_mismatch')
                        name, home = self.profile(body_name)
                result, status, extra = None, 200, {}
                if path in ('/api/config','/api/nocheh/preferences','/api/nocheh/policy'):
                    home=self.preference_home(name,home)
                if path.startswith('/api/cron/'):
                    from .native_cron import manage
                    result=manage(self,path,method,query,body,headers)
                elif path == '/api/chat/image-upload' and method == 'POST' and self.browser_enabled:
                    images=home/'images'
                    if images.is_symlink() or not images.resolve().is_relative_to(home.resolve()): raise ValueError('attachment_scope_denied')
                    from hermes_cli.web_routers.files import upload_chat_image
                    from hermes_cli.web_models import ChatImageUpload
                    result=await upload_chat_image(ChatImageUpload(**body),name)
                elif path == '/api/profiles' and method == 'GET': result = self.profiles()
                elif path == '/api/profiles/active' and method == 'GET':
                    result = {'active': self.profile('')[0], 'current': self.profile('')[0]}
                elif path == '/api/profiles' and method == 'POST':
                    new = body.get('name', '')
                    if not isinstance(new, str) or not NAME.fullmatch(new) or new.startswith('nocheh-') or new in ('default', 'current'):
                        raise ValueError('invalid_profile_name')
                    if any(body.get(k) for k in ('clone_from', 'clone_all', 'clone_from_default', 'mcp_servers', 'hub_skills')):
                        raise ValueError('profile_import_requires_managed_bootstrap')
                    if body.get('provider') not in (None, '', 'openai-codex') or body.get('model') not in (None, '', self.model):
                        raise ValueError('subscription_model_managed_by_nocheh')
                    (self.root / 'profiles').mkdir(exist_ok=True, mode=0o700)
                    dest = self.root / 'profiles' / new
                    dest.mkdir(mode=0o700, parents=False, exist_ok=False)
                    atomic_yaml(dest / 'config.yaml', {})
                    (dest / 'nocheh-owner-profile.json').write_text('{"scope":"owner"}')
                    (dest / 'workspace').mkdir(mode=0o700)
                    result = {'status': 'created', 'name': new, 'profile': next(p for p in self.profiles()['profiles'] if p['name'] == new)}
                elif re.fullmatch(r'/api/profiles/[^/]+', path) and method in ('PATCH','DELETE'):
                    import time
                    selected, source = self.profile(path.rsplit('/',1)[1])
                    if selected.startswith('nocheh-'): raise ValueError('managed_profile_binding_immutable')
                    if method == 'DELETE':
                        retired = self.root / 'retired-profiles'; retired.mkdir(exist_ok=True, mode=0o700)
                        source.rename(retired / (selected + '-' + str(time.time_ns())))
                        result = {'ok':True, 'retained':'retired-profiles'}
                    else:
                        new = body.get('new_name', '')
                        if not isinstance(new,str) or not NAME.fullmatch(new) or new.startswith('nocheh-') or new in ('default','current'):
                            raise ValueError('invalid_profile_name')
                        target = self.root / 'profiles' / new
                        if target.exists(): raise FileExistsError()
                        source.rename(target)
                        result = {'ok':True, 'name':new, 'path':str(target)}
                elif re.fullmatch(r'/api/profiles/[^/]+/soul', path) and method == 'GET':
                    _, selected = self.profile(path.split('/')[-2])
                    soul = selected / 'SOUL.md'
                    if soul.is_symlink(): raise ValueError('profile_path_denied')
                    result = {'content': soul.read_text()[:100000] if soul.exists() else '', 'exists':soul.exists(),
                              'read_only':True, 'runtime_status':'Context-file execution is gated until the managed browser phase.'}
                elif ((method == 'PATCH' and re.fullmatch(r'/api/sessions/[^/]+',path)) or
                      (method == 'DELETE' and re.fullmatch(r'/api/sessions/[^/]+',path)) or
                      (method == 'POST' and path == '/api/sessions/bulk-delete')):
                    query['profile'] = [name]
                    if method in ('PATCH','POST'): body['profile'] = name
                    encoded = json.dumps(body).encode()
                    forwarded = {**scope, 'query_string':urlencode(query,doseq=True).encode(),
                                 'headers':[(k,v) for k,v in scope['headers'] if k != b'content-length'] + [(b'content-length',str(len(encoded)).encode())]}
                    async def replay(): return {'type':'http.request', 'body':encoded, 'more_body':False}
                    return await self.app(forwarded, replay, send)
                elif path == '/api/config/schema' and method == 'GET':
                    from hermes_cli.web_routers.config_env import get_schema
                    result = await get_schema(name)
                    result['fields'] = {key:value for key,value in result['fields'].items() if key in PREFERENCES}
                    for key, spec in PREFERENCES.items():
                        result['fields'].setdefault(key, {'type':'select' if 'choices' in spec else 'number',
                            'options':spec.get('choices',[]), 'default':spec['default'],
                            'min':spec.get('min'), 'max':spec.get('max'), 'category':key.split('.')[0],
                            'description':'Managed native preference; takes effect on the next turn.'})
                    result['category_order'] = ['agent','memory']
                    result['managed_by'] = 'Nocheh; additional controls become available with their managed runtime phase'
                elif path == '/api/config/defaults' and method == 'GET':
                    from hermes_cli.config import DEFAULT_CONFIG, _deep_merge
                    from hermes_cli.web_server_config import _normalize_config_for_web
                    result = _normalize_config_for_web(_deep_merge(DEFAULT_CONFIG, resolved({}, self.model)))
                elif path == '/api/config/raw' and method == 'GET':
                    import yaml
                    config, version = self.config(home)
                    result = {'yaml': yaml.safe_dump(config, allow_unicode=True, sort_keys=False), 'path': str(home / 'config.yaml'),
                              'revision': version, 'read_only': True}
                elif path == '/api/config' and method == 'GET':
                    result, version = self.config(home); extra['etag'] = '"' + version + '"'
                elif path == '/api/config' and method == 'PUT':
                    current, version = self.config(home)
                    expected = headers.get(b'if-match', b'').decode().strip('"')
                    if expected != version: raise ValueError('configuration_conflict')
                    incoming = body.get('config')
                    if not isinstance(incoming, dict): raise ValueError('invalid_config')
                    # Compare the native normalized form. Unedited defaulted/managed
                    # fields are preserved; unsupported changes cannot appear to save.
                    changes = {}
                    def diff(old, new, prefix=''):
                        for key, value in new.items():
                            if key == '_nocheh_revision': continue
                            dotted = prefix + key
                            if isinstance(value, dict) and isinstance(old.get(key), dict): diff(old[key], value, dotted + '.')
                            elif old.get(key) != value: changes[dotted] = value
                    diff(current, incoming)
                    if set(changes) - PREFERENCES.keys(): raise ValueError('setting_managed_by_nocheh')
                    saved = configure_profile(home, self.model, changes, expected)
                    extra['etag'] = '"' + saved['revision'] + '"'
                    result = {'ok': True, 'revision': saved['revision']}
                elif path == '/api/nocheh/policy' and method in ('GET', 'PUT'):
                    from .policy_config import view, save
                    job = query.get('job', [None])[0]
                    result = (save(self.root, body.get('changes'), body.get('revision'), job) if method == 'PUT'
                              else view(self.root, read(home / 'config.yaml') if query.get('profile') else {}, job))
                elif path == '/api/nocheh/preferences' and method in ('GET', 'PUT'):
                    result = (configure_profile(home, self.model, body.get('changes'), body.get('revision')) if method == 'PUT'
                              else inspect_profile(home, self.model))
                elif path == '/api/model/options' and method == 'GET':
                    result = {'model': self.model, 'provider': 'openai-codex', 'providers': [
                        {'name':'ChatGPT subscription', 'slug':'openai-codex', 'models':[self.model],
                         'total_models':1, 'is_current':True, 'source':'Nocheh settings',
                         'warning':'Change the production model in Nocheh Settings and Apply.'}]}
                elif path == '/api/model/info' and method == 'GET':
                    result = {'model':self.model, 'provider':'openai-codex', 'auto_context_length':0,
                              'config_context_length':0, 'effective_context_length':0, 'capabilities':{}}
                elif path == '/api/model/auxiliary' and method == 'GET':
                    result = {'main':{'provider':'openai-codex', 'model':self.model},
                              'tasks':[{'task':'session_search', 'provider':'openai-codex', 'model':self.model,
                                        'base_url':'https://chatgpt.com/backend-api/codex'}]}
                elif path == '/api/env' and method == 'GET': result = {}
                elif path in ('/api/status', '/api/gateway/status') and method == 'GET':
                    import urllib.request
                    with urllib.request.urlopen('http://127.0.0.1:8781/health', timeout=3) as response: live = json.load(response)
                    running = live.get('telegram') == 'connected'
                    result = {'version': '0.21.0', 'release_date': '', 'active_sessions': 0,
                              'config_version': 1, 'latest_config_version': 1, 'config_path': str(home / 'config.yaml'),
                              'env_path': 'Managed by Nocheh', 'hermes_home': str(home),
                              'gateway_running': running, 'gateway_state': 'running' if running else 'stopped',
                              'gateway_pid': None, 'gateway_platforms': {}, 'gateway_exit_reason': None,
                              'gateway_health_url': None, 'gateway_updated_at': None, 'can_update_hermes': False,
                              'nocheh_runtime': live}
                elif method == 'GET' and (path in ('/api/config/schema', '/api/config/defaults') or
                      re.fullmatch(r'/api/sessions(?:/[^/]+(?:/(?:messages|export|latest-descendant))?)?', path)):
                    from .isolated_profile import database_path
                    if path.startswith('/api/sessions') and not database_path(home).exists():
                        if path == '/api/sessions':
                            return await JSONResponse({'sessions':[], 'total':0, 'limit':20, 'offset':0})(scope, receive, send)
                        return await JSONResponse({'error':'session_not_found'},404)(scope, receive, send)
                    # Force even an omitted native query to the owner profile.
                    query['profile'] = [name]
                    forwarded = {**scope, 'query_string': urlencode(query, doseq=True).encode()}
                    return await self.app(forwarded, receive, send)
                else:
                    result, status = {'error': 'managed_operation_unavailable', 'detail': 'This operation awaits its managed runtime phase.'}, 409
                await JSONResponse(result, status, headers=extra)(scope, receive, send)
            except FileExistsError:
                await JSONResponse({'error': 'profile_exists'}, 409)(scope, receive, send)
            except ValueError as error:
                code = str(error) if re.fullmatch(r'[a-z_]+', str(error)) else 'invalid_request'
                await JSONResponse({'error': code, 'detail': code}, 409 if code == 'configuration_conflict' else 400)(scope, receive, send)
            except Exception:
                await JSONResponse({'error': 'native_administration_unavailable'}, 503)(scope, receive, send)


def create_app(root, model, policy, token, browser_enabled=False, revision_reader=None):
    from hermes_cli import web_server as native
    from hermes_cli import web_server_sessions as sessions
    from hermes_cli.web_routers import sessions as router
    from hermes_state import SessionDB
    from hermes_cli import web_server_profiles, web_server_cron
    app = Administration(native.app, root, model, policy, token, browser_enabled, revision_reader)
    web_server_profiles._resolve_profile_dir = lambda name: app.profile(name)[1]
    web_server_cron._cron_profile_home = lambda profile: app.profile(profile)
    # Inspection must never create/migrate/auto-archive native state.
    router._maybe_auto_archive_for_profile = lambda *_: None
    from .isolated_profile import database_path
    sessions._open_session_db_for_profile = lambda profile, read_only: SessionDB(database_path(app.profile(profile)[1]), read_only=read_only)
    @contextlib.asynccontextmanager
    async def lifespan(_): yield
    native.app.router.lifespan_context = lifespan
    native._SESSION_TOKEN = token
    from hermes_cli import web_server_chat
    from .browser_launch import launch
    web_server_chat._resolve_chat_argv = lambda **kwargs: launch(app,**kwargs)
    native._DASHBOARD_EMBEDDED_CHAT_ENABLED = browser_enabled
    native.app.state.bound_port = 8785
    native.app.state.bound_host = '127.0.0.1'
    return app


def main():
    import logging
    logging.disable(logging.CRITICAL)
    root = Path(os.environ['HERMES_HOME'])
    os.environ['NOCHEH_RUNTIME_HOME'] = str(root)
    token = os.environ['SERVICE_TOKEN']
    os.environ['HERMES_DASHBOARD_SESSION_TOKEN'] = token
    import uvicorn
    uvicorn.run(create_app(root, os.environ.get('NOCHEH_MODEL', 'gpt-5.6-sol'), Scopes.load(None), token, os.environ.get('NOCHEH_BROWSER_CHAT')=='1',lambda space:audience_revision(token,space)),
                host='0.0.0.0', port=8785, access_log=False, log_level='critical')


if __name__ == '__main__': main()
