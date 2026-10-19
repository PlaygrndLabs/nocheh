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
    sys.modules['telegram']=fake

from .assistant_gateway import AssistantGateway
from .capture import OUTBOUND_CHECK


class ApprovalCardTests(unittest.IsolatedAsyncioTestCase):
    def gateway(self,root,sent,edits=None,answers=None,groups=('-20',),access=None):
        async def send_message(chat,text,message_thread_id=None,reply_markup=None,reply_to_message_id=None,allow_sending_without_reply=None):
            # The bound outbound check admits only this exact chat and topic.
            OUTBOUND_CHECK.get()('sendMessage',{'chat_id':chat,'text':text,**({'message_thread_id':message_thread_id} if message_thread_id else {})})
            sent.append((chat,message_thread_id,text,reply_markup,reply_to_message_id));return SimpleNamespace(message_id=40+len(sent))
        async def edit_message_text(text,chat_id,message_id,reply_markup=None):edits.append((chat_id,message_id,text,reply_markup));return True
        async def answer_callback_query(query,text=None):answers.append((query,text));return True
        value=AssistantGateway(root,root/'spool',SimpleNamespace(enabled=True,owner='123',groups=list(groups),group_access=access or {}),'123456:synthetic','synthetic',lambda:None)
        value.status='connected';value.action_lock=asyncio.Lock();value.group_replies='all';value.group_names=['Nocheh']
        value.adapter=SimpleNamespace(_bot=SimpleNamespace(username='nocheh_fixture_bot',first_name='My Nocheh',send_message=send_message,
                                                           edit_message_text=edit_message_text,answer_callback_query=answer_callback_query))
        return value

    async def test_cards_go_only_to_the_owner_and_are_sent_once(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];edits=[];answers=[];gateway=self.gateway(Path(folder),sent,edits,answers)
            data=lambda choice:'n'+choice+'a'*56
            card={'kind':'card','id':'a'*64,'chat_id':'123','text':'Send this message to your private chat?\n\nHello',
                  'buttons':[['Approve',data('a')],['Reject',data('d')]]}
            self.assertEqual(await gateway.send_approval(card),{'state':'done','chat_id':'123','message_id':'41'})
            self.assertEqual(await gateway.send_approval(card),{'state':'done','chat_id':'123','message_id':'41'})
            self.assertEqual(len(sent),1,'one card per action, even when offered again')
            self.assertEqual(sent[0][:3],(123,None,'Send this message to your private chat?\n\nHello'))
            for bad in [{**card,'id':'b'*64,'chat_id':'-20'},{**card,'id':'b'*64,'chat_id':'999'},
                        {**card,'id':'b'*64,'buttons':[['Approve','something else'],['Reject',data('d')]]},{**card,'id':'b'*64,'buttons':card['buttons'][:1]},
                        {**card,'id':'b'*64,'text':''},{**card,'id':'b'*64,'text':'x'*4097}]:
                with self.assertRaises(ValueError):await gateway.send_approval(bad)
            self.assertEqual(len(sent),1,'a card for a group or another chat, or with other buttons, is never sent')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'a'*64,'chat_id':'123','text':'Done'}),{'state':'done','edited':True})
            self.assertEqual(edits,[(123,41,'Done',None)],'the decided card loses its buttons')
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
            self.assertEqual(sent,[(-20,17,'Sorry, only allowed people.',None,5)],'one fixed reply to that message, in its topic')
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'text':'what is the plan?'}),{'state':'skipped'},
                             'a member who does not address Nocheh is not answered, whatever the reply setting')
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'user_id':'7'}),{'state':'skipped'},'an allowed member is never refused')
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'user_id':'123'}),{'state':'skipped'})
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'user_id':'8','group_addressing':{'direct':True,'handles':[]},'text':'hi'}),{'state':'done'},
                             'a denied member who replies to Nocheh is refused')
            for bad in [{**ask,'chat_id':'-30'},{**ask,'chat_id':'123'},{**ask,'reply':''},{**ask,'reply':'x'*1001},{**ask,'event_id':'x'}]:
                with self.assertRaises(ValueError):await gateway.send_refusal(bad)
            self.assertEqual(len(sent),2)


if __name__=='__main__':
    unittest.main()
