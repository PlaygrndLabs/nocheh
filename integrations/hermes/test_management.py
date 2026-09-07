import tempfile
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
            (profile_path(root,'123',policy)/'memories').mkdir(parents=True)
            (profile_path(root,'123',policy)/'memories/MEMORY.md').symlink_to(root/'profiles'/Scopes.profile('-30')/'memories/MEMORY.md')
            with self.assertRaises(ValueError):call(action='memory',scope='123')

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
