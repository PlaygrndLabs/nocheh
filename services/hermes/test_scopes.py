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

from .scopes import Scopes,topic_id,verify_capability
from services.chats import Fixed,Served
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


# The Hermes profile of the owner's ask d*32 about a member at generation 1111..., epoch 5, in the owner's chat 123.
MEMBER_READ_PROFILE='nocheh-4c79eaf776a2c61788142716'


def turn(update,scopes,scope=None,**changes):
    """A Telegram turn as storage sends it to Hermes, with the claims of its pass (ADR-0252): the chat and space by their
    Nocheh ids, and where the chat is in Telegram now. The owner's own turn in a private chat has no scope claim."""
    message=update['message'];external=str(message['chat']['id']);topic=topic_id(message);served=scopes.current()
    chat=served.resolve(external) or external
    space=chat if topic is None else served.resolve(external,topic) or chat+':'+str(topic)
    app=served.binding(space) or {'app':'telegram','chat':external,'topic':None if topic is None else str(topic)}
    body={'scope':external if scope is None else scope,'payload':update,'chat':chat,'space':space,'app':app}
    claims={'scope':None if message['chat']['type']=='private' else chat,'space':space,'app':app}
    for key,value in changes.items():(claims if key.startswith('claim_') else body)[key.removeprefix('claim_')]=value
    return body,claims


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.scopes=Scopes({'enabled':True},Served.of('123',groups=['-20','-30'],topics=[['-20/topic/42','-20','42']]))

    def update(self,chat,user,kind='group'):
        return {'update_id':1,'message':{'message_id':1,'chat':{'id':chat,'type':kind},'from':{'id':user,'is_bot':False}}}

    def resolve(self,update,scope,scopes=None,**changes):
        scopes=scopes or self.scopes
        return scopes.resolve(*turn(update,scopes,scope,**changes))

    def test_a_group_turn_admits_the_person_the_app_admitted(self):
        # Who may talk in a served group is the app's member directory (step 3): it admitted this sender and signed this
        # event's pass, so a person's turn there is served, whoever they are. A bot, or a message in a chat's own name, never is.
        self.assertIsNotNone(self.resolve(self.update(-20,456),'-20'))
        self.assertEqual(self.resolve(self.update(-30,456),'-30').user_id,'456')
        owner=self.resolve(self.update(-30,123),'-30')
        self.assertEqual((owner.user_id,owner.owner),('123',False),'the owner in a group is the group, as before')
        bot=self.update(-30,456);bot['message']['from']['is_bot']=True
        self.assertIsNone(self.resolve(bot,'-30'))
        anonymous=self.update(-30,1087968824);anonymous['message']['sender_chat']={'id':-30,'type':'supergroup'}
        self.assertIsNone(self.resolve(anonymous,'-30'))
        # Unchanged: only the owner is served privately, and a group the list does not serve gets no turn.
        self.assertIsNone(self.resolve(self.update(456,456,'private'),'456'))
        self.assertIsNone(self.resolve(self.update(-99,456),'-99'))
        # A policy file's old member list grants and denies nothing.
        listed=Scopes({'enabled':True,'group_access':{'-30':{'granted':[],'denied':['456']}}},Served.of('123',groups=['-30']))
        self.assertIsNotNone(self.resolve(self.update(-30,456),'-30',listed))

    def test_native_profile_routes_and_capability_must_agree(self):
        a=self.resolve(self.update(-20,123),'-20');b=self.resolve(self.update(-30,456),'-30')
        owner=self.resolve(self.update(123,123,'private'),'123')
        self.assertFalse(a.owner);self.assertTrue(owner.owner);self.assertNotEqual(a.profile,b.profile)
        self.assertIsNone(self.resolve(self.update(123,456,'private'),'123'))
        self.assertIsNone(self.resolve(self.update(-99,123),'-99'))
        with self.assertRaises(ValueError):self.resolve(self.update(-20,123),'-30')
        secret='synthetic-service-token';event='a'*64
        body=base64.urlsafe_b64encode(canonical({'scope':'-20','event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant','app':{'app':'telegram','chat':'-20','topic':None}})).decode().rstrip('=')
        signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        token='turn.'+body+'.'+signature
        verify_capability(token,secret,a,event)
        with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}):
            with self.assertRaises(ValueError):verify_capability(token,secret,a,event)
        for scope,target in ((b,event),(owner,event),(a,'b'*64)):
            with self.assertRaises(ValueError):verify_capability(token,secret,scope,target)
        named_claims={'scope':'-20','space':'-20','app':{'app':'telegram','chat':'-20','topic':None},'event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant',
                      'generation':'11111111-1111-1111-1111-111111111111','guard_epoch':5,'revision':5,'logical_profile':'research'}
        def signed(claims):
            data=base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
            return 'turn.'+data+'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),data.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        # A background job run's credential lasts until 2 minutes after its job's hard deadline: up to 55 minutes, never past an hour.
        long_claims={'scope':'-20','event_id':event,'audience':'nocheh-assistant','app':{'app':'telegram','chat':'-20','topic':None}}
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

    def test_a_chat_keeps_its_profile_and_session_by_its_nocheh_id(self):
        # ADR-0252: a chat stored before step 2b keeps its Telegram id as its chat id, so its profile, its topic's space and
        # its session cursor keep the names they had; a group Telegram upgraded keeps them under its new Telegram id, and
        # a chat first seen after step 2b has its own.
        from services.durable import digest
        served=Served.of('123',groups=[('-20','-1007'),('b'*64,'-1009')],old={'-20':['-20']},
                         topics=[('-20/topic/42','-20','42'),('c'*64,'b'*64,'5')])
        scopes=Scopes({'enabled':True},served)
        old=self.resolve(self.update(-20,123),'-20')
        self.assertEqual(old.profile,'nocheh-'+hashlib.sha256(b'-20').hexdigest()[:24])
        upgraded=self.resolve(self.update(-1007,123,'supergroup'),'-1007',scopes)
        self.assertEqual((upgraded.chat_id,upgraded.space,upgraded.profile,upgraded.app),('-20','-20',old.profile,('telegram','-1007',None)))
        self.assertEqual(digest(upgraded.chat_id+':main'),digest('-20:main'),'the same native session')
        # An update still under the old id, read after the upgrade, is the same chat; its pass binds where it is now.
        late=self.resolve(self.update(-20,123,'group'),'-20',scopes)
        self.assertEqual((late.chat_id,late.profile,late.app),('-20',old.profile,('telegram','-1007',None)))
        topic=self.update(-1007,123,'supergroup');topic['message'].update(message_thread_id=42,is_topic_message=True)
        self.assertEqual(self.resolve(topic,'-1007',scopes).space,'-20/topic/42')
        new=self.resolve(self.update(-1009,123,'supergroup'),'-1009',scopes)
        self.assertEqual((new.chat_id,new.space,new.profile),('b'*64,'b'*64,Scopes.profile('b'*64)))
        self.assertNotIn(new.profile,(old.profile,Scopes.profile('-1009')))
        topic=self.update(-1009,123,'supergroup');topic['message'].update(message_thread_id=5,is_topic_message=True)
        self.assertEqual(self.resolve(topic,'-1009',scopes).space,'c'*64)

    def test_a_pass_that_does_not_match_its_update_is_refused(self):
        update=self.update(-20,123)
        for changes in ({'app':{'app':'telegram','chat':'-30','topic':None}},{'claim_app':{'app':'telegram','chat':'-30','topic':None}},
                        {'app':{'app':'telegram','chat':'-20','topic':'42'}},{'chat':'-30'},{'space':'-30'},{'claim_space':'-30'},
                        {'claim_scope':'-30'},{'app':None},{'chat':None}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):self.resolve(update,'-20',**changes)
        # A group's topic must be the chat's own; the owner's private chat has none.
        topic=self.update(-20,123,'supergroup');topic['message'].update(message_thread_id=43,is_topic_message=True)
        with self.assertRaises(ValueError):self.resolve(topic,'-20')
        with self.assertRaises(ValueError):self.resolve(self.update(123,123,'private'),'123',space='-20/topic/42')
        # A chat the list no longer serves is not answered.
        self.assertIsNone(self.resolve(update,'-20',Scopes({'enabled':True},Served.of('123',groups=['-30']))))

    def test_a_served_list_that_cannot_be_read_serves_nothing(self):
        from services.chats import ServedList
        def refused(request,timeout):raise OSError('synthetic outage')
        scopes=Scopes({'enabled':True},ServedList('http://127.0.0.1:9','synthetic-token',refused))
        with self.assertRaisesRegex(RuntimeError,'served_chats_unavailable'):self.resolve(self.update(-20,123),'-20',scopes)
        self.assertEqual(scopes.current().groups(),[])
        # The environment names no owner or group any more: they come from the app's served list.
        with patch.dict(os.environ,{'TELEGRAM_ENABLED':'true','TELEGRAM_OWNER_ID':'123','TELEGRAM_GROUP_IDS':'-20'},clear=True):
            self.assertIsInstance(Scopes.load(None).served,ServedList)
        # Nor does a policy file (ADR-0253): a group is served once the owner adds Nocheh there, never by a list.
        with tempfile.NamedTemporaryFile('w',suffix='.json') as policy:
            policy.write('{"enabled":true,"owner_id":"123","group_ids":["-20"]}');policy.flush()
            self.assertIsInstance(Scopes.load(policy.name).served,ServedList)

    def test_a_topic_recorded_after_the_list_was_read_is_served_on_its_first_turn(self):
        # A new forum topic, or a group's new Telegram id, moves no guard epoch (ADR-0252): the turn's pass names a space
        # the list read a moment ago does not hold, so the list is read again (at most once a second) before deciding.
        from services.chats import ServedList
        topic=('d'*64,'-20','77')
        lists=[Served.of('123',groups=['-20']),Served.of('123',groups=['-20'],topics=[topic])]
        reads,now=[],[0.0]
        class Response:
            def __init__(self,value):self.value=value
            def __enter__(self):return self
            def __exit__(self,*_):return False
            def read(self,_size):return json.dumps(self.value).encode()
        def opener(request,timeout):
            reads.append(request.full_url);served=lists[min(len(reads)-1,1)]
            return Response({'epoch':served.epoch,'owner_chat':served.owner_chat,'owner_account':served.owner_account,
                             'chats':[{key:value for key,value in row.items()} for row in served.chats.values()]})
        scopes=Scopes({'enabled':True},ServedList('http://app.test','synthetic-token',opener,clock=lambda:now[0]))
        self.assertEqual(self.resolve(self.update(-20,123),'-20',scopes).space,'-20')
        self.assertEqual(len(reads),1)
        message=self.update(-20,123,'supergroup');message['message'].update(message_thread_id=77,is_topic_message=True)
        body,claims=turn(message,scopes,'-20')
        body.update(space='d'*64,app={'app':'telegram','chat':'-20','topic':'77'})
        claims.update(space='d'*64,app=body['app'])
        # Within a second of the last read the list is not read again, so the topic is still unknown: refused, retried.
        with self.assertRaises(ValueError):scopes.resolve(body,claims)
        self.assertEqual(len(reads),1)
        now[0]=1.5
        bound=scopes.resolve(body,claims)
        self.assertEqual((bound.chat_id,bound.space,bound.app),('-20','d'*64,('telegram','-20','77')))
        self.assertEqual(len(reads),2)
        # A topic the app does not hold is still refused, and the list is read again at most once a second.
        other=self.update(-20,123,'supergroup');other['message'].update(message_thread_id=78,is_topic_message=True)
        body,claims=turn(other,scopes,'-20')
        body.update(space='e'*64,app={'app':'telegram','chat':'-20','topic':'78'});claims.update(space='e'*64,app=body['app'])
        for _ in range(3):
            with self.assertRaises(ValueError):scopes.resolve(body,claims)
        self.assertEqual(len(reads),2)

    def test_the_served_list_takes_every_chat_state_and_a_topic_follows_its_chat(self):
        # Every state the app may list (src/chat-wire.ts chatStates); only an active chat is served, whatever its topics hold.
        wire=(Path(__file__).resolve().parents[2]/'src'/'chat-wire.ts').read_text()
        import re
        from services import chats
        listed=re.search(r"export const chatStates=\[([^\]]*)\]",wire).group(1)
        self.assertEqual(chats.STATES,tuple(re.findall(r"'([a-z_]+)'",listed)))
        rows=[{'id':'-20','app':'telegram','kind':'group','parent_id':None,'topic_key':None,'state':'active','app_ids':[{'external':'-20','state':'current'}]},
              {'id':'f'*64,'app':'telegram','kind':'topic','parent_id':'-20','topic_key':'9','state':'pending','app_ids':[]},
              *({'id':state,'app':'telegram','kind':'group','parent_id':None,'topic_key':None,'state':state,'app_ids':[{'external':'-'+str(i+40),'state':'current'}]}
                for i,state in enumerate(chats.STATES) if state!='active')]
        served=Served({'epoch':3,'owner_chat':None,'owner_account':None,'chats':rows})
        self.assertTrue(served.available)
        self.assertEqual(served.groups(),['-20'])
        self.assertEqual((served.group('f'*64),served.resolve('-20','9')),('-20','f'*64))
        for state in chats.STATES[1:]:self.assertFalse(served.served(state),state)
        with self.assertRaises(ValueError):Served({'epoch':3,'owner_chat':None,'owner_account':None,'chats':[{**rows[0],'state':'unknown'}]})

    def test_a_telegram_turn_is_bound_to_where_its_chat_is_and_a_job_is_not(self):
        secret='synthetic-service-token';event='a'*64
        def signed(claims):
            data=base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
            return 'turn.'+data+'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),data.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        group=self.resolve(self.update(-20,123),'-20')
        claims={'scope':'-20','space':'-20','revision':1,'event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant'}
        verify_capability(signed({**claims,'app':{'app':'telegram','chat':'-20','topic':None}}),secret,group,event)
        for app in (None,{'app':'telegram','chat':'-30','topic':None},{'app':'telegram','chat':'-20','topic':'42'}):
            with self.subTest(app=app),self.assertRaises(ValueError):verify_capability(signed({**claims,'app':app}),secret,group,event)
        from dataclasses import replace
        verify_capability(signed(claims),secret,replace(group,app=()),event)

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
                    scope=self.resolve(self.update(chat,123),str(chat));profile=prepare_profile(root,scope,'synthetic')
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
        topic=self.resolve(update,'-20')
        self.assertEqual(topic.space,'-20/topic/42')
        # Bot API gives a reply chain in an ordinary supergroup its first message
        # as message_thread_id. It is not a topic, so the reply stays in the chat.
        reply=self.update(-20,123,'supergroup');reply['message'].update(message_thread_id=42,reply_to_message={'message_id':42})
        self.assertEqual(self.resolve(reply,'-20').space,'-20')
        first=Scopes.apply_revision(topic,{'revision':1});second=Scopes.apply_revision(topic,{'revision':2})
        self.assertNotEqual(first.profile,second.profile)
        group=self.resolve(self.update(-20,123),'-20')
        self.assertNotEqual(first.profile,Scopes.apply_revision(group,{'revision':1}).profile)
        owner=self.resolve(self.update(123,123,'private'),'123')
        self.assertEqual(Scopes.apply_revision(owner,{'revision':1}).profile,Scopes.apply_revision(owner,{'revision':2}).profile)

    def test_each_private_answer_has_its_own_profile_and_carries_no_earlier_conversation(self):
        from dataclasses import replace
        claims={'generation':'11111111-1111-1111-1111-111111111111','guard_epoch':5,'revision':1}
        # The answer runs as the asker's private chat, never as the owner (ADR-0249).
        asker=replace(self.resolve(self.update(123,123,'private'),'123'),owner=False,space='123')
        answer=Scopes.apply_revision(asker,{**claims,'answer':'a'*32})
        # test/private-answers.test.ts pins the same name for runtimeProfile with the same claims.
        self.assertEqual(answer.profile,'nocheh-b550c3bb0a154a446943f8f8')
        self.assertEqual(answer.answer,'a'*32)
        profiles={answer.profile,Scopes.apply_revision(asker,{**claims,'answer':'b'*32}).profile,Scopes.apply_revision(asker,claims).profile,
                  Scopes.apply_revision(replace(asker,owner=True),claims).profile}
        self.assertEqual(len(profiles),4,"never another answer's, a plain scoped one or the owner's")
        self.assertEqual(Scopes.apply_revision(asker,claims).answer,'')
        for invalid in ({**claims,'answer':'A'*32},{**claims,'answer':'a'*31},{**claims,'answer':None},{'revision':1,'answer':'a'*32}):
            with self.assertRaisesRegex(ValueError,'invalid_private_answer'):Scopes.apply_revision(asker,invalid)
        with self.assertRaisesRegex(ValueError,'invalid_private_answer'):Scopes.apply_revision(replace(asker,owner=True),{**claims,'answer':'a'*32})
        # A newer epoch's answer starts empty, whatever an earlier answer said; an ordinary chat keeps carrying its conversation.
        with tempfile.TemporaryDirectory() as folder,patch('services.hermes.profile_history.carry',return_value=0) as carry:
            prepare_profile(Path(folder),Scopes.apply_revision(asker,{**claims,'answer':'a'*32}),'synthetic')
            carry.assert_not_called()
            prepare_profile(Path(folder),Scopes.apply_revision(self.resolve(self.update(-20,123),'-20'),claims),'synthetic')
            carry.assert_called_once()

    def test_a_private_answers_pass_is_taken_only_in_the_owners_chat_as_that_chat(self):
        secret='synthetic-service-token';event='a'*64
        owner=self.resolve(self.update(123,123,'private'),'123');group=self.resolve(self.update(-20,123),'-20')
        def signed(claims):
            data=base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
            return 'turn.'+data+'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),data.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        claims={'scope':'123','space':'123','app':{'app':'telegram','chat':'123','topic':None},'event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant',
                'generation':'11111111-1111-1111-1111-111111111111','guard_epoch':5,'revision':1,'answer':'b'*32}
        self.assertEqual(verify_capability(signed(claims),secret,owner,event)['answer'],'b'*32)
        # Its scope is the chat itself, never the owner's (none); a group, a malformed record or a missing scope is refused.
        for bad,scope in (({**claims,'scope':None},owner),({**claims,'answer':'B'*32},owner),({**claims,'answer':'b'*31},owner),({**claims,'answer':5},owner),
                          ({**claims,'scope':'-20','space':'-20'},group),({**claims,'answer':None,'scope':'123'},owner)):
            with self.subTest(claims=bad),self.assertRaises(ValueError):verify_capability(signed(bad),secret,scope,event)
        # Without a record, the owner's own pass is unchanged.
        plain={key:value for key,value in claims.items() if key!='answer'}
        self.assertNotIn('answer',verify_capability(signed({**plain,'scope':None}),secret,owner,event))

    def test_an_ask_about_a_member_has_its_own_profile_never_carried_and_its_pass_only_in_the_owners_chat(self):
        # Step 4b: the owner's ask about a member reads as the owner's private chat, never as the owner, in a profile of its own.
        from dataclasses import replace
        claims={'generation':'11111111-1111-1111-1111-111111111111','guard_epoch':5,'revision':1}
        asker=replace(self.resolve(self.update(123,123,'private'),'123'),owner=False,space='123')
        asked=Scopes.apply_revision(asker,{**claims,'member_read':'d'*32})
        # test/owner-member-asks.test.ts pins the same name for runtimeProfile with the same claims.
        self.assertEqual(asked.profile,MEMBER_READ_PROFILE)
        self.assertEqual((asked.member_read,asked.answer),('d'*32,''))
        profiles={asked.profile,Scopes.apply_revision(asker,{**claims,'member_read':'e'*32}).profile,Scopes.apply_revision(asker,{**claims,'answer':'d'*32}).profile,
                  Scopes.apply_revision(asker,claims).profile,Scopes.apply_revision(replace(asker,owner=True),claims).profile}
        self.assertEqual(len(profiles),5,"never another ask's, an answer's, a plain scoped one or the owner's")
        for invalid in ({**claims,'member_read':'D'*32},{**claims,'member_read':'d'*31},{**claims,'member_read':None},{'revision':1,'member_read':'d'*32},
                        {**claims,'member_read':'d'*32,'answer':'a'*32}):
            with self.subTest(claims=invalid),self.assertRaises(ValueError):Scopes.apply_revision(asker,invalid)
        with self.assertRaisesRegex(ValueError,'invalid_member_read'):Scopes.apply_revision(replace(asker,owner=True),{**claims,'member_read':'d'*32})
        # Nothing is carried into it, its receipt marks it, and it loads no chat's own role.
        with tempfile.TemporaryDirectory() as folder,patch('services.hermes.profile_history.carry',return_value=0) as carry,\
                patch('services.hermes.persona.materialize') as materialize:
            profile=prepare_profile(Path(folder),asked,'synthetic')
            carry.assert_not_called()
            self.assertIsNone(materialize.call_args.args[2])
            receipt=json.loads((profile/'space.json').read_text())
            self.assertEqual((receipt['member_read'],receipt['owner'],receipt['space']),('d'*32,False,'123'))
        # Its pass: in the owner's chat, with that chat as its scope; never the owner's (none), a group's or with an answer.
        secret='synthetic-service-token';event='a'*64
        owner=self.resolve(self.update(123,123,'private'),'123');group=self.resolve(self.update(-20,123),'-20')
        def signed(claims):
            data=base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
            return 'turn.'+data+'.'+base64.urlsafe_b64encode(hmac.new(secret.encode(),data.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        passed={'scope':'123','space':'123','app':{'app':'telegram','chat':'123','topic':None},'event_id':event,'expires':time.time()*1000+600000,
                'audience':'nocheh-assistant',**claims,'member_read':'d'*32}
        self.assertEqual(verify_capability(signed(passed),secret,owner,event)['member_read'],'d'*32)
        for bad,scope in (({**passed,'scope':None},owner),({**passed,'member_read':'D'*32},owner),({**passed,'member_read':5},owner),
                          ({**passed,'answer':'a'*32},owner),({**passed,'scope':'-20','space':'-20'},group)):
            with self.subTest(claims=bad),self.assertRaises(ValueError):verify_capability(signed(bad),secret,scope,event)
        # resolve() takes it as the owner writing in the owner's private chat, as an answer.
        body,claims=turn(self.update(123,123,'private'),self.scopes,'123',claim_scope='123',claim_member_read='d'*32)
        self.assertTrue(self.scopes.resolve(body,claims).owner)

    def test_native_tool_definitions_are_an_explicit_safe_allowlist(self):
        from hermes_constants import set_hermes_home_override,reset_hermes_home_override
        from hermes_cli.plugins import discover_plugins
        from model_tools import get_tool_definitions
        with tempfile.TemporaryDirectory() as folder:
            profile=prepare_profile(Path(folder),self.resolve(self.update(-20,123),'-20'),'synthetic')
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
        # A private answer only reads (ADR-0249): no native memory, no tool that sends, changes, starts or asks.
        removed,answer=turn_tools(False,False,False,True)
        self.assertEqual(answer,{'session_search','skills_list','skill_view',*('mcp__nocheh__'+name for name in ('archive_search','archive_read','archive_page','memory_search','tasks'))})
        self.assertEqual(removed,OWNER_SET_TOOLS|(REPLY_TOOLS-answer))
        self.assertEqual(turn_tools(True,True,True,True),(removed,answer),'an answer is never a job step')

    def test_background_job_steps_add_only_the_native_todo_list(self):
        from hermes_constants import set_hermes_home_override,reset_hermes_home_override
        from hermes_cli.plugins import discover_plugins
        from model_tools import get_tool_definitions
        with tempfile.TemporaryDirectory() as folder:
            profile=prepare_profile(Path(folder),self.resolve(self.update(-20,123),'-20'),'synthetic')
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
            profile=prepare_profile(Path(folder),self.resolve(self.update(-20,123),'-20'),'synthetic')
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
