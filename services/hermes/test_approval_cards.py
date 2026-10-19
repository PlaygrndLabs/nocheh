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
    async def test_cards_go_only_to_the_owner_or_an_allowed_group_and_are_sent_once(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);sent=[];edits=[];answers=[]
            async def send_message(chat,text,message_thread_id=None,reply_markup=None):
                # The bound outbound check admits only this exact chat and topic.
                OUTBOUND_CHECK.get()('sendMessage',{'chat_id':chat,'text':text,**({'message_thread_id':message_thread_id} if message_thread_id else {})})
                sent.append((chat,message_thread_id,text,reply_markup));return SimpleNamespace(message_id=40+len(sent))
            async def edit_message_text(text,chat_id,message_id,reply_markup=None):edits.append((chat_id,message_id,text,reply_markup));return True
            async def answer_callback_query(query,text=None):answers.append((query,text));return True
            gateway=AssistantGateway(root,root/'spool',SimpleNamespace(enabled=True,owner='123',groups=['-20']),'123456:synthetic','synthetic',lambda:None)
            gateway.status='connected';gateway.action_lock=asyncio.Lock()
            gateway.adapter=SimpleNamespace(_bot=SimpleNamespace(send_message=send_message,edit_message_text=edit_message_text,answer_callback_query=answer_callback_query))
            data=lambda choice:'n'+choice+'a'*56
            card={'kind':'card','id':'a'*64,'chat_id':'-20','topic':'17','text':'Send this message to this chat?\n\nHello',
                  'buttons':[['Approve',data('a')],['Reject',data('d')]]}
            self.assertEqual(await gateway.send_approval(card),{'state':'done','chat_id':'-20','message_id':'41'})
            self.assertEqual(await gateway.send_approval(card),{'state':'done','chat_id':'-20','message_id':'41'})
            self.assertEqual(len(sent),1,'one card per action, even when offered again')
            self.assertEqual(sent[0][:3],(-20,17,'Send this message to this chat?\n\nHello'))
            for bad in [{**card,'id':'b'*64,'chat_id':'-30'},{**card,'id':'b'*64,'chat_id':'999'},{**card,'id':'b'*64,'chat_id':'123','topic':'17'},
                        {**card,'id':'b'*64,'buttons':[['Approve','something else'],['Reject',data('d')]]},{**card,'id':'b'*64,'buttons':card['buttons'][:1]},
                        {**card,'id':'b'*64,'text':''},{**card,'id':'b'*64,'text':'x'*4097}]:
                with self.assertRaises(ValueError):await gateway.send_approval(bad)
            self.assertEqual(len(sent),1,'a card for another chat, or with other buttons, is never sent')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'a'*64,'chat_id':'-20','text':'Done'}),{'state':'done','edited':True})
            self.assertEqual(edits,[(-20,41,'Done',None)],'the decided card loses its buttons')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'c'*64,'chat_id':'-20','text':'Done'}),{'state':'done','edited':False},
                             'only a card this runtime sent is edited')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'a'*64,'chat_id':'123','text':'Done'}),{'state':'done','edited':False})
            self.assertEqual(await gateway.send_approval({'kind':'answer','chat_id':'-20','callback_query_id':'q1','text':'Approved.'}),{'state':'done','answered':True})
            self.assertEqual(answers,[('q1','Approved.')])
            offline=AssistantGateway(root,root/'spool',SimpleNamespace(enabled=True,owner='123',groups=[]),'123456:synthetic','synthetic',lambda:None)
            offline.status='reconnecting';offline.action_lock=asyncio.Lock()
            self.assertEqual(await offline.send_approval({**card,'id':'d'*64,'chat_id':'123','topic':None}),{'state':'not_started','error_code':'telegram_not_connected'})


if __name__=='__main__':
    unittest.main()
