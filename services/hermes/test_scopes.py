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
from .assistant_gateway import prepare_profile
from .assistant_turn import restrict_session_search,install_tool_search_policy,ALLOWED_TOOLS,BACKGROUND_TOOLS,BACKGROUND_TOOLSETS,OWNER_SET_TOOLS,TURN_TOOLSETS,UnexpectedProfileTool,turn_tools,verify_profile_tools
from services.durable import canonical
from . import mcp_fixture

# The exact tools of a reply turn and of a job's plain and box steps. A job's turns never have the job tool.
# Nocheh's data tools come from its MCP endpoint; Hermes names each one mcp__nocheh__<tool>.
REPLY_TOOLS={'memory','session_search','skills_list','skill_view',*('mcp__nocheh__'+name for name in mcp_fixture.TOOLS)}
JOB_TOOLS=(REPLY_TOOLS-{'mcp__nocheh__background_job'})|{'todo_list'}
JOB_BOX_TOOLS=(JOB_TOOLS-{'memory','mcp__nocheh__shell','mcp__nocheh__browser'})|{'terminal','process_manage','read_file','write_file','patch','search_files','execute_code'}
JOB_MACHINE_TOOLS=JOB_BOX_TOOLS-{'execute_code'}


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.scopes=Scopes({'enabled':True,'owner_id':'123','group_ids':['-20','-30'],
                            'group_access':{'-30':{'granted':['456'],'denied':[]}}})

    def update(self,chat,user,kind='group'):
        return {'update_id':1,'message':{'message_id':1,'chat':{'id':chat,'type':kind},'from':{'id':user,'is_bot':False}}}

    def test_group_access_defaults_to_owner_and_denies_override_grants(self):
        self.assertIsNone(self.scopes.resolve(self.update(-20,456),'-20'))
        self.assertIsNotNone(self.scopes.resolve(self.update(-30,456),'-30'))
        denied=Scopes({'enabled':True,'owner_id':'123','group_ids':['-30'],
                       'group_access':{'-30':{'granted':['456'],'denied':['456']}}})
        self.assertIsNone(denied.resolve(self.update(-30,456),'-30'))
        self.assertIsNotNone(denied.resolve(self.update(-30,123),'-30'))

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
        with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}):
            with self.assertRaises(ValueError):verify_capability(token,secret,a,event)
        for scope,target in ((b,event),(owner,event),(a,'b'*64)):
            with self.assertRaises(ValueError):verify_capability(token,secret,scope,target)
        named_claims={'scope':'-20','space':'-20','event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant',
                      'generation':'11111111-1111-1111-1111-111111111111','guard_epoch':5,'revision':5,'logical_profile':'research'}
        def signed(claims):
            data=base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
            return 'turn.'+data+'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),data.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        # A background job run's credential lasts until 2 minutes after its job's hard deadline: up to 55 minutes, never past an hour.
        long_claims={'scope':'-20','event_id':event,'audience':'nocheh-assistant'}
        verify_capability(signed({**long_claims,'expires':time.time()*1000+55*60000}),secret,a,event)
        for expires in (time.time()*1000+61*60000,time.time()*1000-1000):
            with self.assertRaises(ValueError):verify_capability(signed({**long_claims,'expires':expires}),secret,a,event)
        with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}):
            bound=Scopes.apply_revision(a,verify_capability(signed(named_claims),secret,a,event))
            self.assertEqual(bound.logical_profile,'research')
            self.assertEqual(verify_capability(signed(named_claims),secret,bound,event)['logical_profile'],'research')
            for invalid in ('planning','../owner',None):
                with self.assertRaises(ValueError):verify_capability(signed({**named_claims,'logical_profile':invalid}),secret,bound,event)
            default_claims={**named_claims,'logical_profile':Scopes.profile('-20')}
            default_bound=Scopes.apply_revision(a,default_claims)
            implicit=Scopes.apply_revision(a,{key:value for key,value in default_claims.items() if key!='logical_profile'})
            self.assertEqual(default_bound.profile,implicit.profile,'default browser and Telegram profiles share native state')
            joined=Scopes.apply_revision(a,verify_capability(signed({**named_claims,'project':'c'*64}),secret,a,event))
            self.assertEqual((joined.project,joined.profile),('c'*64,bound.profile),'a project brings its role and skills, never another profile')
            for invalid in ('C'*64,'../projects',5):
                with self.assertRaises(ValueError):verify_capability(signed({**named_claims,'project':invalid}),secret,a,event)

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
        update=self.update(-20,123,'supergroup');update['message'].update(message_thread_id=42,is_topic_message=True)
        topic=self.scopes.resolve(update,'-20')
        self.assertEqual(topic.space,'-20/topic/42')
        # Bot API gives a reply chain in an ordinary supergroup its first message
        # as message_thread_id. It is not a topic, so the reply stays in the chat.
        reply=self.update(-20,123,'supergroup');reply['message'].update(message_thread_id=42,reply_to_message={'message_id':42})
        self.assertEqual(self.scopes.resolve(reply,'-20').space,'-20')
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
                # Without Nocheh's endpoint the turn has none of the data tools; the plugin registers none.
                definitions=get_tool_definitions(enabled_toolsets=TURN_TOOLSETS,quiet_mode=True)
                self.assertFalse({item['function']['name'] for item in definitions}&mcp_fixture.NAMES)
                # Connected as a turn connects them, through Hermes's own MCP client.
                with mcp_fixture.connected():
                    definitions=get_tool_definitions(enabled_toolsets=TURN_TOOLSETS,quiet_mode=True)
                names={item['function']['name'] for item in definitions}
                # Hermes offers a skill-writing tool too; turns drop it because the owner sets skills.
                self.assertEqual(names&OWNER_SET_TOOLS,OWNER_SET_TOOLS)
                self.assertEqual(names-OWNER_SET_TOOLS,ALLOWED_TOOLS)
                removed,allowed=turn_tools(False,False)
                self.assertEqual(names-removed,REPLY_TOOLS);self.assertEqual(allowed,REPLY_TOOLS)
            finally:reset_hermes_home_override(token)

    def test_turn_tools_are_exact_and_job_turns_have_no_job_tool(self):
        self.assertEqual(turn_tools(False,False),(OWNER_SET_TOOLS,REPLY_TOOLS))
        self.assertEqual(turn_tools(True,False),(OWNER_SET_TOOLS|{'mcp__nocheh__background_job'},JOB_TOOLS))
        self.assertEqual(turn_tools(True,True),(OWNER_SET_TOOLS|{'mcp__nocheh__background_job','mcp__nocheh__shell','mcp__nocheh__browser'},JOB_BOX_TOOLS))
        self.assertEqual(turn_tools(True,False,True),(OWNER_SET_TOOLS|{'mcp__nocheh__background_job','mcp__nocheh__shell','mcp__nocheh__browser'},JOB_MACHINE_TOOLS))
        self.assertIn('mcp__nocheh__background_job',REPLY_TOOLS)
        for tools in (JOB_TOOLS,JOB_BOX_TOOLS,JOB_MACHINE_TOOLS):self.assertNotIn('mcp__nocheh__background_job',tools)

    def test_background_job_steps_add_only_the_native_todo_list(self):
        from hermes_constants import set_hermes_home_override,reset_hermes_home_override
        from hermes_cli.plugins import discover_plugins
        from model_tools import get_tool_definitions
        with tempfile.TemporaryDirectory() as folder:
            profile=prepare_profile(Path(folder),self.scopes.resolve(self.update(-20,123),'-20'),'synthetic')
            token=set_hermes_home_override(str(profile))
            try:
                discover_plugins()
                with mcp_fixture.connected():
                    definitions=get_tool_definitions(enabled_toolsets=BACKGROUND_TOOLSETS,quiet_mode=True)
                names={item['function']['name'] for item in definitions}
                removed,allowed=turn_tools(True,False)
                self.assertEqual(names-removed,JOB_TOOLS);self.assertEqual(allowed,JOB_TOOLS);self.assertEqual(BACKGROUND_TOOLS,JOB_TOOLS)
                self.assertEqual(BACKGROUND_TOOLS^ALLOWED_TOOLS,{'todo_list','mcp__nocheh__background_job'})
                verify_profile_tools(names-removed,allowed)
            finally:reset_hermes_home_override(token)

    def test_turn_policy_disables_native_tool_search_even_when_loader_enables_it(self):
        from hermes_constants import set_hermes_home_override,reset_hermes_home_override
        from hermes_cli.plugins import discover_plugins
        from model_tools import get_tool_definitions
        from tools import tool_search
        from .profile_config import atomic_yaml,read
        with tempfile.TemporaryDirectory() as folder:
            profile=prepare_profile(Path(folder),self.scopes.resolve(self.update(-20,123),'-20'),'synthetic')
            config=read(profile/'config.yaml')
            config['tools']['tool_search']={'enabled':'on'}
            atomic_yaml(profile/'config.yaml',config)
            token=set_hermes_home_override(str(profile))
            try:
                discover_plugins()
                self.assertEqual(tool_search.load_config().enabled,'on')
                restore=install_tool_search_policy()
                try:
                    self.assertEqual(tool_search.load_config().enabled,'off')
                    self.assertEqual(tool_search.load_config_readonly().enabled,'off')
                    # Hermes would put every MCP tool behind its search bridge; the turn keeps them in view.
                    with mcp_fixture.connected():
                        definitions=get_tool_definitions(enabled_toolsets=TURN_TOOLSETS,quiet_mode=False)
                    names={item['function']['name'] for item in definitions}
                    self.assertEqual(names-OWNER_SET_TOOLS,ALLOWED_TOOLS)
                finally:restore()
                self.assertEqual(tool_search.load_config().enabled,'on')
            finally:reset_hermes_home_override(token)

    def test_unexpected_profile_tool_names_are_bounded_and_fail_closed(self):
        verify_profile_tools(ALLOWED_TOOLS)
        with self.assertRaises(UnexpectedProfileTool) as caught:
            verify_profile_tools(ALLOWED_TOOLS|{'foreign_tool','private:payload'})
        self.assertEqual(str(caught.exception),'unexpected_profile_tool')
        self.assertEqual(caught.exception.names,['foreign_tool'])


if __name__=='__main__':unittest.main()
