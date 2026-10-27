import asyncio
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

try:
    import telegram  # noqa: F401
except ImportError:
    # The card only needs the two keyboard types; keep this check runnable without the runtime image.
    fake=types.ModuleType('telegram')
    fake.InlineKeyboardButton=lambda text,callback_data:(text,callback_data)
    fake.InlineKeyboardMarkup=lambda rows:rows
    fake.MessageEntity=type('MessageEntity',(),{'TEXT_LINK':'text_link','__init__':lambda self,type,offset,length,url=None:self.__dict__.update(type=type,offset=offset,length=length,url=url)})
    sys.modules['telegram']=fake

from .assistant_gateway import AssistantGateway
from .capture import OUTBOUND_CHECK


class ApprovalCardTests(unittest.IsolatedAsyncioTestCase):
    def gateway(self,root,sent,edits=None,answers=None,groups=('-20',),access=None):
        async def send_message(chat,text,message_thread_id=None,reply_markup=None,reply_to_message_id=None,allow_sending_without_reply=None,entities=None,parse_mode=None):
            # The bound outbound check admits only this exact chat and topic.
            OUTBOUND_CHECK.get()('sendMessage',{'chat_id':chat,'text':text,**({'message_thread_id':message_thread_id} if message_thread_id else {})})
            sent.append((chat,message_thread_id,text,reply_markup,reply_to_message_id,links(entities)));return SimpleNamespace(message_id=40+len(sent))
        async def edit_message_text(text,chat_id,message_id,reply_markup=None,entities=None,parse_mode=None):edits.append((chat_id,message_id,text,reply_markup,links(entities)));return True
        links=lambda entities:[(entity.type,entity.offset,entity.length,entity.url) for entity in entities or []]
        async def answer_callback_query(query,text=None):answers.append((query,text));return True
        value=AssistantGateway(root,root/'spool',SimpleNamespace(enabled=True,owner='123',groups=list(groups),group_access=access or {}),'123456:synthetic','synthetic',lambda:None)
        value.status='connected';value.action_lock=asyncio.Lock();value.group_replies='all';value.group_names=['Nocheh']
        value.adapter=SimpleNamespace(_bot=SimpleNamespace(username='nocheh_fixture_bot',first_name='My Nocheh',send_message=send_message,
                                                           edit_message_text=edit_message_text,answer_callback_query=answer_callback_query))
        return value

    async def test_cards_go_to_the_owner_or_an_allowed_group_and_are_sent_once(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];edits=[];answers=[];gateway=self.gateway(Path(folder),sent,edits,answers)
            data=lambda choice:'n'+choice+'a'*56
            card={'kind':'card','id':'a'*64,'chat_id':'123','text':'Send this message to your private chat?\n\nHello',
                  'buttons':[['Approve',data('a')],['Reject',data('d')]]}
            self.assertEqual(await gateway.send_approval(card),{'state':'done','chat_id':'123','message_id':'41'})
            self.assertEqual(await gateway.send_approval(card),{'state':'done','chat_id':'123','message_id':'41'})
            self.assertEqual(len(sent),1,'one card per action, even when offered again')
            self.assertEqual(sent[0][:3],(123,None,'Send this message to your private chat?\n\nHello'))
            group={**card,'id':'e'*64,'chat_id':'-20','topic':'17','reply_to':'5','text':'📨 Send to “Team” › Plans\n\nHello',
                   'links':[{'offset':11,'length':6,'url':'https://t.me/c/20/9'},{'offset':20,'length':5,'url':'https://t.me/c/20/17'}]}
            self.assertEqual(await gateway.send_approval(group),{'state':'done','chat_id':'-20','message_id':'42'})
            self.assertEqual(sent[1],(-20,17,group['text'],sent[1][3],5,[('text_link',11,6,'https://t.me/c/20/9'),('text_link',20,5,'https://t.me/c/20/17')]),
                             'a requester-reviewed card goes to its own group and topic, as the reply to the request, with its names linked')
            link=lambda **change:{**card,'id':'b'*64,'links':[{'offset':0,'length':4,'url':'https://t.me/nocheh_team',**change}]}
            for bad in [link(url='https://example.com/x'),link(url='tg://resolve?domain=x'),link(offset=-1),link(length=0),link(length=99),link(offset='0'),
                        {**card,'id':'b'*64,'links':'x'},{**card,'id':'b'*64,'reply_to':'x'},{**card,'id':'b'*64,'chat_id':'-30'},{**card,'id':'b'*64,'chat_id':'999'},{**card,'id':'b'*64,'topic':'17'},{**group,'id':'b'*64,'topic':'x'},
                        {**card,'id':'b'*64,'buttons':[['Approve','something else'],['Reject',data('d')]]},{**card,'id':'b'*64,'buttons':card['buttons'][:1]},
                        {**card,'id':'b'*64,'text':''},{**card,'id':'b'*64,'text':'x'*4097}]:
                with self.assertRaises(ValueError):await gateway.send_approval(bad)
            self.assertEqual(len(sent),2,'a card for another group or chat, or with other buttons, is never sent')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'a'*64,'chat_id':'123','text':'Done'}),{'state':'done','edited':True})
            self.assertEqual(edits,[(123,41,'Done',None,[])],'the decided card loses its buttons')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'e'*64,'chat_id':'-20','text':group['text']+'\n\nSent.','links':group['links']}),{'state':'done','edited':True})
            self.assertEqual(edits[-1][4],sent[1][5],'and keeps its links')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'c'*64,'chat_id':'123','text':'Done'}),{'state':'done','edited':False},
                             'only a card this runtime sent is edited')
            self.assertEqual(await gateway.send_approval({'kind':'answer','chat_id':'123','callback_query_id':'q1','text':'Approved.'}),{'state':'done','answered':True})
            self.assertEqual(answers,[('q1','Approved.')])
            offline=self.gateway(Path(folder),sent);offline.status='reconnecting'
            self.assertEqual(await offline.send_approval({**card,'id':'d'*64}),{'state':'not_started','error_code':'telegram_not_connected'})

    async def test_unallowed_members_who_address_nocheh_get_the_fixed_reply_once(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];gateway=self.gateway(Path(folder),sent,access={'-20':{'granted':['7'],'denied':['8']}})
            ask={'event_id':'e'*64,'chat_id':'-20','user_id':'9','message_id':'5','topic':'17','text':'Nocheh, what is the plan?',
                 'group_addressing':{'direct':False,'handles':[]},'reply':'Sorry, only allowed people.'}
            self.assertEqual(await gateway.send_refusal(ask),{'state':'done'})
            self.assertEqual(await gateway.send_refusal(ask),{'state':'done'})
            self.assertEqual(sent,[(-20,17,'Sorry, only allowed people.',None,5,[])],'one fixed reply to that message, in its topic')
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'text':'what is the plan?'}),{'state':'skipped'},
                             'a member who does not address Nocheh is not answered, whatever the reply setting')
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'user_id':'7'}),{'state':'skipped'},'an allowed member is never refused')
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'user_id':'123'}),{'state':'skipped'})
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'user_id':'8','group_addressing':{'direct':True,'handles':[]},'text':'hi'}),{'state':'done'},
                             'a denied member who replies to Nocheh is refused')
            for bad in [{**ask,'chat_id':'-30'},{**ask,'chat_id':'123'},{**ask,'reply':''},{**ask,'reply':'x'*1001},{**ask,'event_id':'x'}]:
                with self.assertRaises(ValueError):await gateway.send_refusal(bad)
            self.assertEqual(len(sent),2)

    async def test_anyone_but_the_owner_writing_privately_gets_the_private_reply_once_a_day(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];gateway=self.gateway(Path(folder),sent)
            ask={'event_id':'e'*64,'chat_id':'9','user_id':'9','message_id':'5','private':True,'reply':'Sorry, this is private.'}
            self.assertEqual(await gateway.send_refusal(ask),{'state':'done'})
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'message_id':'6'}),{'state':'done'})
            self.assertEqual(sent,[(9,None,'Sorry, this is private.',None,5,[])],'one fixed reply a day, however often they write')
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'chat_id':'10','user_id':'10'}),{'state':'done'})
            self.assertEqual(len(sent),2,'each person gets their own reply')
            self.assertEqual(await gateway.send_refusal({**ask,'chat_id':'123','user_id':'123'}),{'state':'skipped'},'the owner is never refused')
            for bad in [{**ask,'chat_id':'10'},{**ask,'chat_id':'-20','user_id':'-20'},{**ask,'topic':'17'},{**ask,'reply':''}]:
                with self.assertRaises(ValueError):await gateway.send_refusal(bad)
            self.assertEqual(len(sent),2)


if __name__=='__main__':
    unittest.main()
