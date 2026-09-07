"""Real pinned routes, temporary native state, no model or Telegram calls."""
import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from .scopes import Scopes
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
        self.policy = Scopes({'enabled': True, 'owner_id': '42', 'group_ids': ['-10']})
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
        self.assertEqual(len(schema.json()['fields']),5)
        self.assertEqual(schema.json()['category_order'][0],'agent')
        profiles = self.client.get('/api/profiles', headers=self.headers).json()['profiles']
        self.assertEqual(len(profiles), 2)
        self.assertEqual(self.client.get('/api/config?profile=../../secrets', headers=self.headers).status_code, 400)
        for method, path in [('POST','/api/gateway/start'), ('GET','/api/env/reveal'), ('GET','/api/fs/read-text'),
                             ('POST','/api/cron/jobs'), ('POST','/api/mcp/test')]:
            self.assertEqual(self.client.request(method, path, headers=self.headers).status_code, 409)

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
        from hermes_state import SessionDB
        for path, sid in ((self.owner, 'owner-session'), (self.group, 'group-session')):
            db = SessionDB(path / 'state.db'); db.create_session(sid, source='telegram', model='gpt-5.6-sol')
            db.append_message(sid, 'user', 'Synthetic ' + sid); db.close()
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
        renamed = self.client.patch('/api/sessions/owner-session', headers=self.headers,
            json={'title':'New title', 'profile':self.owner.name})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        absent = self.client.delete('/api/sessions/owner-session?profile='+self.group.name, headers=self.headers)
        self.assertTrue(absent.json()['already_absent'])
        self.assertEqual(self.client.get('/api/sessions/owner-session/messages', headers=self.headers).status_code,200)
        self.assertEqual(self.client.delete('/api/sessions/owner-session', headers=self.headers).status_code,200)

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
