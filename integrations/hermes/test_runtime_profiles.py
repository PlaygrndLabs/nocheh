"""Separated profile authority against pinned native HTTP routes, offline."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from .scopes import Scopes, Scope
from .runtime_profiles import ProfileCatalog
from .profile_config import read


class ControlFixture:
    def __init__(self):
        self.epoch = 1; self.generation = '11111111-1111-4111-8111-111111111111'
        self.rows = {}; self.receipts = {}; self.calls = []

    def entry(self, space='42', custom=None):
        chat = space.split('/topic/')[0]; owner = chat == '42'
        logical = custom['id'] if custom else Scopes.profile(space)
        claims = {'generation': self.generation, 'guard_epoch': self.epoch, 'revision': self.epoch, 'logical_profile': logical}
        bound = Scopes.apply_revision(Scope(chat, '42', owner, Scopes.profile(space), space, self.epoch), claims)
        return {'name': custom['name'] if custom else logical, 'logical_profile': logical,
            'preference_profile': logical, 'native_profile': bound.profile, 'scope': chat, 'space': space,
            'owner': owner, 'managed': custom is None, 'is_default': owner and custom is None,
            'revision': custom['revision'] if custom else 0, 'policy_revision': self.epoch,
            'guard_epoch': self.epoch, 'generation': self.generation, 'guard_mode': 'on'}

    def request(self, route, body=None):
        self.calls.append((route, body))
        entries = [self.entry(), self.entry('-10')] + [self.entry(custom=row) for row in self.rows.values() if row['state'] == 'active']
        if route.endswith('/resolve'):
            selected = body['profile']
            if selected in ('', 'default', 'current'): return entries[0]
            if '/topic/' in body.get('space', ''): entries.append(self.entry(body['space']))
            for entry in entries:
                if selected in (entry['name'], entry['logical_profile'], entry['native_profile']):
                    if body.get('space', entry['space']) != entry['space']: raise ValueError('profile_scope_denied')
                    return entry
            raise ValueError('profile_not_found')
        if body is None: return {'profiles': entries}
        operation = body['operation_id']
        if operation in self.receipts:
            old, result = self.receipts[operation]
            if old != body: raise ValueError('owner_command_conflict')
            return result
        identity = body.get('id', 'profile-' + hashlib.sha256(operation.encode()).hexdigest()[:48])
        prior = self.rows.get(identity)
        if (prior['revision'] if prior else 0) != body['expected_revision']: raise ValueError('profile_revision_conflict')
        if prior and prior['state'] == 'retired': raise ValueError('profile_retired')
        if any(row['id'] != identity and row['name'] == body['name'] and row['state'] == 'active' for row in self.rows.values()):
            raise ValueError('profile_name_conflict')
        result = {'id': identity, 'name': body['name'], 'state': body['state'], 'revision': body['expected_revision'] + 1}
        self.rows[identity] = result; self.receipts[operation] = (body, result); self.epoch += 1
        return result


class RuntimeProfileTests(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient
        from .native_admin import create_app
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'NOCHEH_RUNTIME_HOME': str(self.root), 'NOCHEH_STORAGE_LAYOUT': 'original-only-v1'})
        self.env.start(); self.control = ControlFixture()
        self.policy = Scopes({'enabled': True, 'owner_id': '42', 'group_ids': ['-10']})
        self.catalog = ProfileCatalog(self.root, self.policy, 'fixture', self.control.request)
        self.app = create_app(self.root, 'gpt-5.6-sol', self.policy, 'fixture', True, profile_catalog=self.catalog)
        self.client = TestClient(self.app, base_url='http://127.0.0.1')
        self.headers = {'X-Hermes-Session-Token': 'fixture'}

    def tearDown(self): self.env.stop(); self.temp.cleanup()

    def create(self):
        response = self.client.post('/api/profiles', headers=self.headers, json={'name': 'research', 'operation_id': 'create-research'})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['profile']

    def test_current_control_identity_and_read_only_inspection(self):
        entries = self.client.get('/api/profiles', headers=self.headers).json()['profiles']
        self.assertEqual(len(entries), 2)
        self.assertNotEqual(entries[0]['name'], entries[0]['native_profile'])
        before = sorted(str(p) for p in self.root.rglob('*'))
        old, home = self.app.profile('default'); self.assertFalse(home.exists())
        self.assertEqual(self.client.get('/api/sessions', headers=self.headers).json()['sessions'], [])
        self.assertEqual(before, sorted(str(p) for p in self.root.rglob('*')))
        self.control.epoch += 1
        self.assertNotEqual(self.app.profile('default')[0], old)
        with self.assertRaisesRegex(ValueError, 'profile_not_found'): self.app.profile(old)
        fake = self.root / 'profiles/forged'; fake.mkdir(parents=True)
        (fake / 'nocheh-owner-profile.json').write_text('{"scope":"owner"}')
        with self.assertRaisesRegex(ValueError, 'profile_not_found'): self.app.profile('forged')
        with self.assertRaisesRegex(ValueError, 'profile_scope_denied'): self.app.profile('../forged')

    def test_crud_keeps_preferences_and_never_adopts_old_sessions(self):
        from .assistant_gateway import prepare_profile
        entry = self.create(); identity = entry['logical_profile']; pref = self.root / 'profiles' / identity
        response = self.client.get('/api/config?profile=research', headers=self.headers)
        config = response.json(); config['agent']['max_iterations'] = 5
        response = self.client.put('/api/config?profile=research', headers={**self.headers, 'If-Match': response.headers['etag']}, json={'config': config})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(read(pref / 'config.yaml')['agent']['max_iterations'], 5)
        bound = self.app.binding('research'); old = prepare_profile(self.root, bound, 'gpt-5.6-sol')
        # prepare_profile returns the profile path; native content never becomes preferences.
        old = self.root / 'profiles' / bound.profile
        (old / 'memories').mkdir(exist_ok=True); (old / 'memories/MEMORY.md').write_text('Old context')
        changed = self.client.patch('/api/profiles/research', headers=self.headers,
            json={'new_name': 'planning', 'expected_revision': 1, 'operation_id': 'rename-research'})
        self.assertEqual(changed.status_code, 200, changed.text)
        fresh = self.catalog.resolve('planning'); self.assertEqual(fresh['logical_profile'], identity)
        self.assertNotEqual(fresh['native_profile'], bound.profile)
        prepare_profile(self.root, self.app.binding('planning'), 'gpt-5.6-sol')
        current = self.root / 'profiles' / fresh['native_profile']
        self.assertEqual(read(current / 'config.yaml')['agent']['max_iterations'], 5)
        self.assertFalse((current / 'memories/MEMORY.md').exists())
        self.assertEqual((old / 'memories/MEMORY.md').read_text(), 'Old context')
        # An edit reaches an already-created native generation on its next turn.
        from .profile_config import configure_profile, inspect_profile
        configure_profile(pref, 'gpt-5.6-sol', {'agent.max_iterations': 6}, inspect_profile(pref, 'gpt-5.6-sol')['revision'])
        prepare_profile(self.root, self.app.binding('planning'), 'gpt-5.6-sol')
        self.assertEqual(read(current / 'config.yaml')['agent']['max_iterations'], 6)
        conflict = self.client.patch('/api/profiles/planning', headers=self.headers,
            json={'new_name': 'stale', 'expected_revision': 1, 'operation_id': 'stale-edit'})
        self.assertEqual(conflict.status_code, 409, conflict.text)
        retired = self.client.request('DELETE', '/api/profiles/planning', headers=self.headers,
            json={'expected_revision': 2, 'operation_id': 'retire-planning'})
        self.assertEqual(retired.status_code, 200, retired.text)
        self.assertTrue((pref / 'config.yaml').exists()); self.assertTrue(old.exists())
        with self.assertRaisesRegex(ValueError, 'profile_not_found'): self.app.profile(identity)

    def test_catalog_validation_topics_and_symlinks(self):
        entry = self.control.entry('-10/topic/7'); home = self.catalog.path(entry['native_profile']); home.mkdir(parents=True)
        (home / 'space.json').write_text(json.dumps({'space': '-10/topic/7'}))
        self.assertEqual(self.app.binding(home.name).space, '-10/topic/7')
        for forged in ({**entry, 'owner': True}, {**entry, 'scope': '-999'}, {**entry, 'native_profile': Scopes.profile('42')},
                       {**entry, 'preference_profile': Scopes.profile('42')}, {**entry, 'generation': 'old'}):
            with self.assertRaisesRegex(ValueError, 'profile_scope_denied'): self.catalog.validate(forged)
        link = self.catalog.path(self.control.entry()['native_profile']); link.symlink_to(home)
        with self.assertRaisesRegex(ValueError, 'profile_scope_denied'): self.catalog.resolve('default')

    def test_launch_propagates_generation_and_logical_identity_without_credentials(self):
        from .browser_launch import launch
        entry = self.create()
        argv, cwd, env = launch(self.app, profile='research')
        self.assertEqual(env['NOCHEH_STORAGE_LAYOUT'], 'original-only-v1')
        self.assertEqual(env['NOCHEH_BROWSER_LOGICAL_PROFILE'], entry['logical_profile'])
        self.assertEqual(env['NOCHEH_BROWSER_PROFILE'], entry['native_profile'])
        self.assertEqual(env['NOCHEH_BROWSER_GENERATION'], self.control.generation)
        self.assertEqual(env['NOCHEH_BROWSER_GUARD_EPOCH'], str(self.control.epoch))
        self.assertFalse((Path(env['HERMES_HOME']) / 'auth.json').exists())
        self.assertNotIn('POSTGRES_PASSWORD', env)

    def test_scheduler_uses_stable_profile_for_definitions_and_fires(self):
        from .native_cron import manage, inspect, workflow_cursor
        from .scheduler import Scheduler
        entry = self.create(); calls = []
        def call(route, body):
            calls.append((route, body))
            if route == 'ownership': return {'owner': 'inngest', 'epoch': 7, 'admission': True}
            if route == 'input': return {'event_id': 'a' * 64}
            return {}
        job = manage(self.app, '/api/cron/jobs', 'POST', {'profile': ['research']},
            {'name': 'Fixture', 'prompt': 'Retain exact\r\n prompt', 'schedule': 'every 1h'}, {}, call)
        home = Path(job['hermes_home']); self.assertEqual(home.name, entry['logical_profile'])
        manage(self.app, '/api/cron/jobs/' + job['id'] + '/trigger', 'POST', {'profile': ['research']},
            {'request_id': 'manual-fixture'}, {}, call)
        scheduler = Scheduler(self.app, None, call)
        result = scheduler.advance({'logical_profile': home.name, 'job_id': job['id'],
            'cursor': workflow_cursor(inspect(home)[0], home.name), 'owner_epoch': 7})
        self.assertEqual(result['state'], 'completed')
        for route, body in calls:
            if route in ('definition', 'input'):
                self.assertEqual(body['profile'], entry['logical_profile'])
                self.assertEqual(body['definition']['profile'], entry['logical_profile'])
        self.assertEqual(next(body for route, body in calls if route == 'input')['text'], 'Retain exact\r\n prompt')
