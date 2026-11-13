import tempfile
import json
import unittest
from pathlib import Path
from .scopes import Scopes
from .management import dispatch, profile_path


class ManagementTests(unittest.TestCase):
    def test_native_notes_sessions_pagination_and_wrong_profile(self):
        from hermes_state import SessionDB
        policy=Scopes({'enabled':True,'owner_id':'123','group_ids':['-20','-30']})
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for chat in ('-20','-30'):
                profile=profile_path(root,chat,policy);(profile/'memories').mkdir(parents=True)
                (profile/'memories/MEMORY.md').write_text('  note '+chat+'\n'+'nocheh:event:'+'a'*64)
                db=SessionDB(profile/'state.db');db.create_session('session'+chat,source='telegram')
                for i in range(52):db.append_message('session'+chat,role='user',content=f'{chat}: {i}')
                db.close()
            call=lambda **body:dispatch(root,'test-model',policy,body)
            result=call(action='memory',scope='-20');self.assertEqual(result['memories'][0]['text'][:2],'  ')
            self.assertEqual(result['memories'][0]['citations'],['a'*64]);self.assertEqual(len(result['sessions']),1)
            result=call(action='memory',scope='-20',session='session-20');self.assertEqual(len(result['messages']),50);self.assertEqual(result['next_offset'],50)
            result=call(action='memory',scope='-20',session='session-20',offset=50);self.assertEqual(len(result['messages']),2);self.assertIsNone(result['next_offset'])
            for body in ({'scope':'-99'}, {'scope':'-20','session':'session-30'}, {'scope':'-20','offset':-1}):
                with self.assertRaises(ValueError):call(action='memory',**body)
            self.assertFalse(call(action='memory',scope='123')['memories'][0]['exists'])
            self.assertFalse(call(action='memory',scope='123',profile=Scopes.profile('123'))['memories'][0]['exists'])
            (profile_path(root,'123',policy)/'memories').mkdir(parents=True)
            (profile_path(root,'123',policy)/'memories/MEMORY.md').symlink_to(root/'profiles'/Scopes.profile('-30')/'memories/MEMORY.md')
            with self.assertRaises(ValueError):call(action='memory',scope='123')

    def test_a_project_role_and_skills_are_kept_in_their_own_folder(self):
        policy=Scopes({'enabled':True,'owner_id':'123','group_ids':['-20']})
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);call=lambda **body:dispatch(root,'test-model',policy,body);scope='project:'+'d'*64
            first=call(action='persona',scope=scope)
            self.assertEqual((first['scope'],first['role'],first['skills']),(scope,'',[]))
            call(action='persona',scope=scope,role='Client project role',skills=[],revision=first['revision'])
            self.assertEqual((root/'projects'/('d'*64)/'SOUL.md').read_text(),'Client project role\n')
            for bad in ('project:../profiles','project:'+'D'*64):
                with self.assertRaises(ValueError):call(action='persona',scope=bad)

    def test_the_private_chats_and_the_groups_defaults_are_kept_apart(self):
        policy=Scopes({'enabled':True,'owner_id':'123','group_ids':['-20']})
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);call=lambda **body:dispatch(root,'test-model',policy,body)
            private,groups=call(action='persona',scope='default'),call(action='persona',scope='default:groups')
            self.assertEqual((groups['scope'],groups['role'],groups['skills']),('default:groups','',[]))
            saved=call(action='persona',scope='default:groups',role='Group role',skills=[],revision=groups['revision'])
            self.assertEqual((root/'nocheh-default-groups'/'SOUL.md').read_text(),'Group role\n')
            self.assertEqual(call(action='persona',scope='default'),private,'a groups save never changes the private chat\'s default')
            call(action='persona',scope='default',role='Private role',skills=[],revision=private['revision'])
            self.assertEqual(call(action='persona',scope='default:groups'),saved,'and the other way round')
            self.assertEqual((root/'nocheh-default'/'SOUL.md').read_text(),'Private role\n')
            with self.assertRaisesRegex(ValueError,'configuration_conflict'):
                call(action='persona',scope='default:groups',role='Stale',skills=[],revision=groups['revision'])
            for bad in ('default:members','default:'):
                with self.assertRaises(ValueError):call(action='persona',scope=bad)

    def test_owner_inspects_retired_topic_notes_by_registered_profile(self):
        policy=Scopes({'enabled':True,'owner_id':'123','group_ids':['-20']})
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);name=Scopes.profile('-20/topic/1:policy:2');path=root/'profiles'/name
            (path/'memories').mkdir(parents=True)
            (path/'space.json').write_text(json.dumps({'space':'-20/topic/1','revision':2,'guard_epoch':7,'owner':False}))
            (path/'memories/MEMORY.md').write_text('Historical topic note')
            listing=dispatch(root,'test',policy,{'action':'profiles'})
            self.assertTrue(any(p.get('revision')==2 for p in listing['history_profiles']))
            self.assertTrue(any(p.get('guard_epoch')==7 for p in listing['history_profiles']))
            result=dispatch(root,'test',policy,{'action':'memory','scope':'-20/topic/1','profile':name})
            self.assertEqual(result['memories'][0]['text'],'Historical topic note')
            with self.assertRaises(ValueError):dispatch(root,'test',policy,{'action':'memory','scope':'-20/topic/2','profile':name})

    def test_preferences_use_revision_and_policy(self):
        policy=Scopes({'enabled':True,'owner_id':'123','group_ids':[]})
        with tempfile.TemporaryDirectory() as root:
            request={'action':'preferences','scope':'123'}
            first=dispatch(root,'test',policy,request)
            self.assertEqual(list(Path(root).iterdir()),[],'Viewing preferences must not mutate a backup source')
            updated=dispatch(root,'test',policy,{**request,'revision':first['revision'],'changes':{'agent.max_iterations':4}})
            self.assertEqual(updated['values']['agent.max_iterations'],4)
            with self.assertRaises(ValueError):dispatch(root,'test',policy,{**request,'revision':first['revision'],'changes':{'agent.max_iterations':5}})
            with self.assertRaises(ValueError):dispatch(root,'test',policy,{**request,'revision':updated['revision'],'changes':{'model.provider':'unsafe'}})


class SettingsErrorRelayTests(unittest.TestCase):
    def test_settings_validation_says_what_to_fix_and_other_errors_stay_generic(self):
        import io
        import json
        from contextlib import redirect_stdout
        from unittest.mock import patch
        from tools.runtime import management

        def run(operation, error):
            out = io.StringIO()
            stdin = type('In', (), {'buffer': io.BytesIO(json.dumps({'operation': operation}).encode())})()
            with patch.object(management, 'dispatch', side_effect=error), patch.object(management.sys, 'stdin', stdin), redirect_stdout(out):
                management.main()
            return json.loads(out.getvalue())['error']

        self.assertEqual(run('settings.save', ValueError('Memory (Honcho) needs a model name')), 'Memory (Honcho) needs a model name')
        self.assertEqual(run('settings.save', ValueError('configuration_conflict')), 'configuration_conflict')
        from tools.operations.installation.configuration import OWNER_CONFLICT
        from tools.operations.installation.settings import OWNER_FROM_CLI
        for message in (OWNER_CONFLICT, OWNER_FROM_CLI):self.assertEqual(run('settings.save', ValueError(message)), message)
        self.assertEqual(run('archive.view', ValueError('upstream said secret-value here')), 'ValueError')
        self.assertEqual(run('settings.save', RuntimeError('provider body')), 'RuntimeError')
