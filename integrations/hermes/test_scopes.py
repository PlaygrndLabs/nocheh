import asyncio
import base64
import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from .scopes import Scopes,verify_capability
from .assistant_gateway import AssistantGateway,prepare_profile
from .assistant_turn import restrict_session_search,ALLOWED_TOOLS
from .capture import canonical,immutable_file


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.scopes=Scopes({'enabled':True,'owner_id':'123','group_ids':['-20','-30']})

    def update(self,chat,user,kind='group'):
        return {'update_id':1,'message':{'message_id':1,'chat':{'id':chat,'type':kind},'from':{'id':user,'is_bot':False}}}

    def test_native_profile_routes_and_capability_must_agree(self):
        a=self.scopes.resolve(self.update(-20,123),'-20');b=self.scopes.resolve(self.update(-30,456),'-30')
        owner=self.scopes.resolve(self.update(123,123,'private'),'123')
        self.assertFalse(a.owner);self.assertTrue(owner.owner);self.assertNotEqual(a.profile,b.profile)
        self.assertIsNone(self.scopes.resolve(self.update(123,456,'private'),'123'))
        self.assertIsNone(self.scopes.resolve(self.update(-99,123),'-99'))
        with self.assertRaises(ValueError):self.scopes.resolve(self.update(-20,123),'-30')
        secret='synthetic-service-token';event='a'*64
        body=base64.urlsafe_b64encode(canonical({'scope':'-20','event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant'})).decode().rstrip('=')
        signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        token='turn.'+body+'.'+signature
        verify_capability(token,secret,a,event)
        for scope,target in ((b,event),(owner,event),(a,'b'*64)):
            with self.assertRaises(ValueError):verify_capability(token,secret,scope,target)

    def test_native_memory_and_session_search_cannot_open_other_profiles(self):
        from hermes_constants import set_hermes_home_override,reset_hermes_home_override
        from hermes_state import SessionDB
        from tools.memory_tool import MemoryStore
        from tools.session_search_tool import session_search
        restore=restrict_session_search()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);databases=[]
            try:
                for chat,marker in ((-20,'GROUP_A_JUNIPER'),(-30,'GROUP_B_MAPLE')):
                    scope=self.scopes.resolve(self.update(chat,123),str(chat));profile=prepare_profile(root,scope,'synthetic')
                    token=set_hermes_home_override(str(profile))
                    try:
                        memory=MemoryStore();memory.load_from_disk();self.assertTrue(memory.add('memory',marker)['success'])
                        db=SessionDB(profile/'state.db');databases.append(db)
                        db.create_session(marker,source='telegram');db.append_message(marker,role='user',content=marker)
                        self.assertIn(marker,(profile/'memories/MEMORY.md').read_text())
                    finally:reset_hermes_home_override(token)
                result=session_search(session_id='GROUP_B_MAPLE',db=databases[0]);self.assertFalse(json.loads(result)['success'])
                self.assertFalse(json.loads(session_search(session_id='GROUP_B_MAPLE',profile='default',db=databases[0]))['success'])
                self.assertFalse(json.loads(session_search(session_id='default/GROUP_B_MAPLE',db=databases[0]))['success'])
                local=json.loads(session_search(session_id='GROUP_A_JUNIPER',db=databases[0]));self.assertTrue(local['success'])
                self.assertNotIn('GROUP_B_MAPLE',json.dumps(local))
            finally:
                for db in databases:db.close()
                restore()

    def test_topics_and_revisions_have_distinct_native_memory(self):
        update=self.update(-20,123);update['message']['message_thread_id']=42
        topic=self.scopes.resolve(update,'-20')
        self.assertEqual(topic.space,'-20/topic/42')
        first=Scopes.apply_revision(topic,{'revision':1});second=Scopes.apply_revision(topic,{'revision':2})
        self.assertNotEqual(first.profile,second.profile)
        group=self.scopes.resolve(self.update(-20,123),'-20')
        self.assertNotEqual(first.profile,Scopes.apply_revision(group,{'revision':1}).profile)
        owner=self.scopes.resolve(self.update(123,123,'private'),'123')
        self.assertEqual(Scopes.apply_revision(owner,{'revision':1}).profile,Scopes.apply_revision(owner,{'revision':2}).profile)

    def test_native_tool_definitions_are_an_explicit_safe_allowlist(self):
        from hermes_constants import set_hermes_home_override,reset_hermes_home_override
        from hermes_cli.plugins import discover_plugins
        from model_tools import get_tool_definitions
        with tempfile.TemporaryDirectory() as folder:
            profile=prepare_profile(Path(folder),self.scopes.resolve(self.update(-20,123),'-20'),'synthetic')
            token=set_hermes_home_override(str(profile))
            try:
                discover_plugins()
                definitions=get_tool_definitions(enabled_toolsets=['memory','session_search','nocheh_archive'],quiet_mode=True)
                names={item['function']['name'] for item in definitions}
                self.assertEqual(names,ALLOWED_TOOLS)
            finally:reset_hermes_home_override(token)

    def test_restart_marks_orphan_dispatch_and_action_receipts_ambiguous(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name in ('a'*64,'action-'+'b'*64):immutable_file(root/'spool/dispatch',name+'.intent',b'{}')
            gateway=AssistantGateway(root,root/'spool',self.scopes,'','synthetic',lambda:None)
            for path in (root/'spool/dispatch').glob('*.result'):self.assertEqual(json.loads(path.read_text())['state'],'ambiguous')
            gateway.start();self.assertEqual(gateway.status,'credentials_missing')


if __name__=='__main__':unittest.main()
