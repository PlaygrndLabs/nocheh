"""Real pinned routes, temporary native state, no model or Telegram calls."""
import hashlib
import os
import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch
from .scopes import Scopes
from services.chats import Served
from .profile_config import configure_profile, inspect_profile, read, atomic_yaml
from .policy_config import save, view


class PolicyTests(unittest.TestCase):
    def test_inheritance_conflicts_and_existing_overrides(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); profile = root / 'profiles/owner'
            with patch.dict(os.environ, {'NOCHEH_RUNTIME_HOME': str(root)}):
                initial = configure_profile(profile, 'gpt-5.6-sol')
                self.assertEqual(initial['origins']['agent.max_iterations'], 'default')
                first = view(root)
                save(root, {'agent.max_iterations': 5}, first['revision'])
                with self.assertRaisesRegex(ValueError, 'configuration_conflict'):
                    configure_profile(profile, 'gpt-5.6-sol', {'agent.max_iterations': 9}, initial['revision'])
                with self.assertRaisesRegex(ValueError, 'configuration_conflict'):
                    save(root, {'agent.max_iterations': 6}, first['revision'])
                self.assertEqual(inspect_profile(profile, 'gpt-5.6-sol')['values']['agent.max_iterations'], 5)
                inherited = configure_profile(profile, 'gpt-5.6-sol')
                explicit = configure_profile(profile, 'gpt-5.6-sol', {'agent.max_iterations': 7}, inherited['revision'])
                self.assertEqual(explicit['origins']['agent.max_iterations'], 'profile')
                reset = configure_profile(profile, 'gpt-5.6-sol', {'agent.max_iterations': None}, explicit['revision'])
                self.assertEqual(reset['values']['agent.max_iterations'], 5)
                self.assertEqual(reset['origins']['agent.max_iterations'], 'global')
                job = save(root, {'agent.max_iterations': 3}, view(root)['revision'], 'job-1')
                self.assertEqual(job['values']['agent.max_iterations'], 3)
                self.assertEqual(job['origins']['agent.max_iterations'], 'job:job-1')
                self.assertEqual(inspect_profile(profile, 'gpt-5.6-sol')['values']['agent.max_iterations'], 5)

    def test_invalid_policy_and_legacy_values(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); profile = root / 'profiles/owner'; profile.mkdir(parents=True)
            atomic_yaml(profile / 'config.yaml', {'agent': {'max_iterations': 9}, 'custom': {'preserve': 'yes'}})
            with patch.dict(os.environ, {'NOCHEH_RUNTIME_HOME': str(root)}):
                save(root, {'agent.max_iterations': 4}, view(root)['revision'])
                result = configure_profile(profile, 'gpt-5.6-sol')
                self.assertEqual(result['values']['agent.max_iterations'], 9)
                self.assertEqual(read(profile / 'config.yaml')['custom'], {'preserve': 'yes'})
                for changes in ({'agent.max_iterations': True}, {'agent.max_iterations': 99}, {'guard': 'off'}):
                    with self.assertRaises(ValueError): save(root, changes, view(root)['revision'])


class NativeAdminTests(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient
        from .native_admin import create_app
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'NOCHEH_RUNTIME_HOME': str(self.root)})
        self.env.start()
        self.policy = Scopes({'enabled': True}, Served.of('42', groups=['-10']))
        self.owner = self.root / 'profiles' / Scopes.profile('42')
        self.group = self.root / 'profiles' / Scopes.profile('-10')
        configure_profile(self.owner, 'gpt-5.6-sol'); configure_profile(self.group, 'gpt-5.6-sol')
        self.token = 'admin-test-token-' * 3
        self.app = create_app(self.root, 'gpt-5.6-sol', self.policy, self.token)
        self.client = TestClient(self.app, base_url='http://127.0.0.1')
        self.headers = {'X-Hermes-Session-Token': self.token}

    def tearDown(self): self.env.stop(); self.temp.cleanup()

    def test_auth_scope_and_unverified_operations(self):
        self.assertEqual(self.client.get('/api/profiles').status_code, 401)
        schema = self.client.get('/api/config/schema', headers=self.headers)
        self.assertEqual(schema.status_code,200,schema.text)
        self.assertEqual(len(schema.json()['fields']),6)
        self.assertEqual(schema.json()['category_order'][0],'agent')
        profiles = self.client.get('/api/profiles', headers=self.headers).json()['profiles']
        self.assertEqual(len(profiles), 2)
        self.assertEqual(self.client.get('/api/config?profile=../../secrets', headers=self.headers).status_code, 400)
        for method, path in [('POST','/api/gateway/start'), ('GET','/api/env/reveal'), ('GET','/api/fs/read-text'),
                             ('POST','/api/mcp/test')]:
            self.assertEqual(self.client.request(method, path, headers=self.headers).status_code, 409)

    def test_chat_page_routes_are_refused(self):
        # The dashboard chat page is off until Nocheh has its own chat page (Telegram only): its delivery receipts,
        # recovery reads and picture uploads never reach Nocheh or write the profile, even with the session token.
        receipt={'receipt':'a'*64,'sha256':'b'*64}
        with patch('urllib.request.urlopen',side_effect=AssertionError('no call to Nocheh')):
            for method,path,body in (('POST','/api/nocheh/browser-delivered',receipt),('GET','/api/nocheh/browser-undelivered?after='+'a'*64,None),
                                     ('POST','/api/chat/image-upload',{'data_url':'data:image/png;base64,AAAA','filename':'a.png'})):
                self.assertEqual(self.client.request(method,path,json=body).status_code,401)
                response=self.client.request(method,path,headers=self.headers,json=body)
                self.assertEqual((response.status_code,response.json()['error']),(409,'managed_operation_unavailable'),path)
            large=self.client.post('/api/chat/image-upload',headers=self.headers,content=b'{"data_url":"'+b'A'*(1024*1024)+b'"}')
            self.assertEqual(large.json()['error'],'body_size_limit')
        self.assertFalse((self.owner/'images').exists())

    def test_cron_page_only_reads(self):
        # Nocheh grants every schedule change (ADR-0290): Hermes's Cron page lists and shows, and every write is refused
        # before it reaches the store or Nocheh, even with the session token.
        from cron import jobs as native
        from .native_cron import store
        with store(self.owner):job=native.create_job(prompt='Brief me',schedule='every 1h',name='Fixture',deliver='telegram')
        stored=(self.owner/'cron/jobs.json').read_bytes()
        with patch('urllib.request.urlopen',side_effect=AssertionError('no call to Nocheh')):
            for method,path,body in (('POST','/api/cron/jobs?profile=default',{'name':'x','prompt':'p','schedule':'every 1m'}),
                                     ('PUT','/api/cron/jobs/'+job['id'],{'updates':{'prompt':'p'}}),
                                     ('POST','/api/cron/jobs/'+job['id']+'/pause',{'request_id':'one'}),
                                     ('POST','/api/cron/jobs/'+job['id']+'/resume',{'request_id':'one'}),
                                     ('POST','/api/cron/jobs/'+job['id']+'/trigger',{'request_id':'one'}),
                                     ('POST','/api/cron/jobs/'+job['id']+'/catch-up',{'request_id':'one'}),
                                     ('POST','/api/cron/jobs/'+job['id']+'/cancel',{}),
                                     ('DELETE','/api/cron/jobs/'+job['id']+'?profile=all',None),
                                     ('PATCH','/api/cron/jobs/'+job['id'],{})):
                self.assertEqual(self.client.request(method,path,json=body).status_code,401)
                response=self.client.request(method,path,headers=self.headers,json=body)
                self.assertEqual((response.status_code,response.json()),(403,{'error':'cron_read_only','detail':'cron_read_only'}),(method,path))
        self.assertEqual((self.owner/'cron/jobs.json').read_bytes(),stored)
        listed=self.client.get('/api/cron/jobs',headers=self.headers)
        self.assertEqual((listed.status_code,[row['id'] for row in listed.json()]),(200,[job['id']]))
        self.assertEqual(self.client.get('/api/cron/jobs/'+job['id'],headers=self.headers).json()['name'],'Fixture')

    def test_dashboard_preferences_do_not_write_runtime_profiles(self):
        before=(self.owner/'config.yaml').read_bytes()
        self.assertEqual(self.client.get('/api/dashboard/font').status_code,401)
        response=self.client.put('/api/dashboard/font',headers=self.headers,json={'font':'system-mono'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.client.get('/api/dashboard/font',headers=self.headers).json()['font'],'system-mono')
        self.assertEqual((self.owner/'config.yaml').read_bytes(),before)
        self.assertEqual(read(self.root/'dashboard-presentation/config.yaml')['dashboard']['font'],'system-mono')
        plugins=self.client.get('/api/dashboard/plugins',headers=self.headers)
        self.assertEqual(plugins.status_code,200,plugins.text)
        self.assertTrue(any(p['name']=='nocheh' for p in plugins.json()))
        self.assertEqual(self.client.post('/api/dashboard/agent-plugins/install',headers=self.headers,json={'identifier':'forbidden'}).status_code,409)

    def test_native_config_roundtrip_preserves_fields_and_rejects_stale_writer(self):
        before = read(self.owner / 'config.yaml')
        before['custom'] = {'api_key': 'must-never-be-returned', 'field': 'kept'}
        atomic_yaml(self.owner / 'config.yaml', before)
        response = self.client.get('/api/config', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn('must-never-be-returned', response.text)
        config = response.json(); config['agent']['max_iterations'] = 6
        headers = {**self.headers, 'If-Match': response.headers['etag']}
        saved = self.client.put('/api/config', json={'config': config}, headers=headers)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(inspect_profile(self.owner, 'gpt-5.6-sol')['values']['agent.max_iterations'], 6)
        self.assertEqual(read(self.owner / 'config.yaml')['custom'], before['custom'])
        self.assertEqual(self.client.put('/api/config', json={'config': config}, headers=headers).status_code, 409)
        fresh = self.client.get('/api/config', headers=self.headers)
        config = fresh.json(); config['model'] = 'paid-provider/model'
        rejected = self.client.put('/api/config', json={'config': config}, headers={**self.headers, 'If-Match': fresh.headers['etag']})
        self.assertEqual(rejected.status_code, 400)

    def test_sessions_are_actual_scoped_and_inspection_does_not_write(self):
        from .native_store import writer
        from .store_fixture import add_message, add_session
        for path, sid in ((self.owner, 'owner-session'), (self.group, 'group-session')):
            with writer(path) as db: add_session(db, sid, model='gpt-5.6-sol'); add_message(db, sid, 'user', 'Synthetic ' + sid)
        def fingerprint():
            return {str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file() and not p.name.endswith(('-wal','-shm'))}
        # SQLite may create lock/WAL sidecars on a mode=ro connection.
        # Original database, notes and configuration bytes must stay unchanged.
        before = fingerprint()
        response = self.client.get('/api/sessions/owner-session/messages', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('Synthetic owner-session', response.text)
        denied = self.client.get('/api/sessions/owner-session/messages?profile=' + self.group.name, headers=self.headers)
        self.assertEqual(denied.status_code, 404, denied.text)
        self.client.get('/api/sessions', headers=self.headers)
        self.client.get('/api/config', headers=self.headers)
        self.assertEqual(fingerprint(), before)
        # Hermes fences every session edit by the row's revision and a reusable request id.
        snapshot = self.client.get('/api/sessions/owner-session/mutation-snapshot', headers=self.headers)
        self.assertEqual(snapshot.status_code, 200, snapshot.text)
        renamed = self.client.patch('/api/sessions/owner-session', headers=self.headers,
            json={'title':'New title', 'profile':self.owner.name, 'request_id':'synthetic-rename',
                  'expected_revision':snapshot.json()['runtime_revision']})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        # Deletes also fence the generation. An absent row has revision and generation zero; deleting it is an idempotent success.
        absent = self.client.delete('/api/sessions/owner-session?request_id=synthetic-absent&expected_revision=0&expected_generation=0&profile='+self.group.name, headers=self.headers)
        self.assertTrue(absent.json()['already_absent'], absent.text)
        self.assertEqual(self.client.get('/api/sessions/owner-session/messages', headers=self.headers).status_code,200)
        current = self.client.get('/api/sessions/owner-session/mutation-snapshot', headers=self.headers).json()
        deleted = self.client.delete('/api/sessions/owner-session?request_id=synthetic-delete&expected_revision='
            f"{current['runtime_revision']}&expected_generation={current['runtime_generation']}", headers=self.headers)
        self.assertEqual(deleted.status_code, 200, deleted.text)

    def test_files_stay_in_selected_workspace_and_reads_do_not_create_it(self):
        workspace = self.owner / 'workspace'
        result = self.client.get('/api/files', headers=self.headers)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertFalse(workspace.exists())
        result = self.client.post('/api/files/upload', headers=self.headers,
            json={'path':'note.txt', 'data_url':'data:text/plain;base64,aGVsbG8=', 'overwrite':False})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual((workspace / 'note.txt').read_text(), 'hello')
        for target in ('../auth.json', str(self.group / 'config.yaml')):
            self.assertIn(self.client.get('/api/files/read', params={'path':target}, headers=self.headers).status_code, (400,403))
        (workspace / 'escape').symlink_to(self.group)
        self.assertIn(self.client.get('/api/files/read', params={'path':'escape/config.yaml'}, headers=self.headers).status_code, (400,403))

    def test_create_owner_profile_without_cloning_credentials_or_managed_binding(self):
        result = self.client.post('/api/profiles', headers=self.headers, json={'name':'research'})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.client.get('/api/config?profile=research', headers=self.headers).status_code, 200)
        self.assertFalse((self.root / 'profiles/research/auth.json').exists())
        self.assertEqual(self.client.get('/api/sessions?profile=research',headers=self.headers).json()['sessions'],[])
        self.assertFalse((self.root / 'profiles/research/state.db').exists())
        renamed = self.client.patch('/api/profiles/research', headers=self.headers, json={'new_name':'notes'})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        self.assertEqual(self.client.delete('/api/profiles/notes', headers=self.headers).status_code, 200)
        self.assertEqual(len(list((self.root / 'retired-profiles').iterdir())), 1)
        self.assertEqual(self.client.delete('/api/profiles/'+self.owner.name, headers=self.headers).status_code, 400)
        for body in ({'name':'nocheh-impostor'}, {'name':'unsafe','clone_from':'default'}):
            self.assertEqual(self.client.post('/api/profiles', headers=self.headers, json=body).status_code, 400)

class BrowserBoundaryTests(unittest.TestCase):
    def test_audience_revision_keeps_logical_preferences_without_copying_memory(self):
        from .native_admin import Administration
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);policy=Scopes({'enabled':True},Served.of('42',groups=['-10']))
            with patch.dict(os.environ,{'NOCHEH_RUNTIME_HOME':str(root)}):
                logical=root/'profiles'/Scopes.profile('-10')
                original=configure_profile(logical,'model')
                configure_profile(logical,'model',{'agent.reasoning_effort':'high','agent.max_iterations':7},original['revision'])
                admin=Administration(None,root,'model',policy,'fixture',lambda _:2)
                name,home=admin.profile(logical.name);home.mkdir(parents=True)
                (home/'space.json').write_text(json.dumps({'space':'-10','revision':2,'owner':False}))
                values=configure_profile(home,'model')['values']
                self.assertEqual(values['agent.reasoning_effort'],'high');self.assertEqual(values['agent.max_iterations'],7)
                self.assertEqual(admin.preference_home(name,home),logical)
                current=inspect_profile(logical,'model')
                configure_profile(logical,'model',{'agent.max_iterations':4},current['revision'])
                self.assertEqual(configure_profile(home,'model')['values']['agent.max_iterations'],4)
                self.assertFalse((home/'memories').exists())

    def test_group_browser_profiles_follow_audience_revision_without_copying_old_context(self):
        from .native_admin import Administration
        from .scopes import Scopes
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);policy=Scopes({'enabled':True},Served.of('42',groups=['-10']));revision=[1]
            admin=Administration(None,root,'model',policy,'fixture',lambda _:revision[0])
            name,path=admin.profile(Scopes.profile('-10'))
            self.assertEqual(name,Scopes.profile('-10:policy:1'));self.assertFalse(path.exists())
            path.mkdir(parents=True);(path/'space.json').write_text(json.dumps({'space':'-10','revision':1,'owner':False}))
            (path/'memories').mkdir();(path/'memories/MEMORY.md').write_text('Old audience fixture')
            self.assertFalse(admin.binding(name).owner)
            revision[0]=2
            fresh,new_path=admin.profile(Scopes.profile('-10'))
            self.assertNotEqual(fresh,name);self.assertFalse(new_path.exists())
            with self.assertRaisesRegex(ValueError,'profile_policy_changed'):admin.profile(name)
            self.assertEqual((path/'memories/MEMORY.md').read_text(),'Old audience fixture')

    def test_every_socket_closes_even_with_the_session_token(self):
        import asyncio
        from urllib.parse import urlencode
        from .native_admin import Administration
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);policy=Scopes({'enabled':False},Served.of('42',groups=['-10']))
            forwarded=[];sent=[]
            async def app(scope,receive,send): forwarded.append(scope)
            admin=Administration(app,root,'model',policy,'fixture')
            async def send(value): sent.append(value)
            async def receive(): return {'type':'websocket.connect'}
            for path in ('/api/pty','/api/ws','/api/pub','/api/events'):
                for token in ('fixture','wrong'):
                    scope={'type':'websocket','path':path,'query_string':urlencode({'token':token,'channel':'same-channel'}).encode()}
                    asyncio.run(admin(scope,receive,send))
            self.assertEqual(forwarded,[])
            self.assertEqual(sent,[{'type':'websocket.close','code':1008}]*8)

    def test_chat_page_cannot_open_or_launch(self):
        from fastapi.testclient import TestClient
        from starlette.websockets import WebSocketDisconnect
        from hermes_cli import web_server as native, web_server_chat
        from .native_admin import create_app
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);policy=Scopes({'enabled':False},Served.of('42',groups=['-10']))
            app=create_app(root,'model',policy,'fixture')
            self.assertFalse(native._DASHBOARD_EMBEDDED_CHAT_ENABLED)
            with self.assertRaisesRegex(ValueError,'browser_chat_off'):web_server_chat._resolve_chat_argv(profile=Scopes.profile('42'))
            with TestClient(app,base_url='http://127.0.0.1:8785') as client:
                for path in ('/api/ws','/api/pty'):
                    with self.subTest(path=path),self.assertRaises(WebSocketDisconnect),client.websocket_connect(path+'?token=fixture'):pass
            self.assertFalse(list(root.rglob('state.db')))
