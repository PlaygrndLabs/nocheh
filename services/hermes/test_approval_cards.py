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
    fake.InlineKeyboardButton=lambda text,callback_data=None,url=None,web_app=None:(text,callback_data or url or web_app)
    fake.InlineKeyboardMarkup=lambda rows:rows
    fake.WebAppInfo=lambda url:('web_app',url)
    fake.LinkPreviewOptions=lambda is_disabled=None:SimpleNamespace(is_disabled=is_disabled)
    fake.error=types.ModuleType('telegram.error')
    fake.error.BadRequest=type('BadRequest',(Exception,),{})
    sys.modules['telegram.error']=fake.error
    fake.MessageEntity=type('MessageEntity',(),{'TEXT_LINK':'text_link','__init__':lambda self,type,offset,length,url=None:self.__dict__.update(type=type,offset=offset,length=length,url=url)})
    sys.modules['telegram']=fake

from .assistant_gateway import AssistantGateway
from .capture import OUTBOUND_CHECK


class ApprovalCardTests(unittest.IsolatedAsyncioTestCase):
    def gateway(self,root,sent,edits=None,answers=None,groups=('-20',),access=None):
        def previews_off(options):
            # Every card, refusal and notice is sent and edited with link previews off; the gateway counts a refused send as not done.
            if getattr(options,'is_disabled',None) is not True:raise ValueError('link_preview_on')
        async def send_message(chat,text,message_thread_id=None,reply_markup=None,reply_to_message_id=None,allow_sending_without_reply=None,entities=None,parse_mode=None,link_preview_options=None):
            previews_off(link_preview_options)
            # The bound outbound check admits only this exact chat and topic.
            OUTBOUND_CHECK.get()('sendMessage',{'chat_id':chat,'text':text,**({'message_thread_id':message_thread_id} if message_thread_id else {})})
            sent.append((chat,message_thread_id,text,reply_markup,reply_to_message_id,links(entities)));return SimpleNamespace(message_id=40+len(sent))
        async def edit_message_text(text,chat_id,message_id,reply_markup=None,entities=None,parse_mode=None,link_preview_options=None):
            previews_off(link_preview_options);edits.append((chat_id,message_id,text,reply_markup,links(entities)));return True
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
            self.assertEqual(len(getattr(sent[0][3],'inline_keyboard',sent[0][3])),1,'Approve and Reject share one row')
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
            # An operation that can be allowed here shows up to four buttons, one to a row so each label shows in full (ADR-0214).
            four={**card,'id':'f'*64,'text':'⚙️ Run browser','buttons':[['Allow once',data('a')],['Allow here',data('c')],['Always here',data('w')],['Reject',data('d')]]}
            self.assertEqual((await gateway.send_approval(four))['state'],'done')
            # The real keyboard, or the plain rows this file's stand-in builds when the runtime image is not here.
            rows=getattr(sent[2][3],'inline_keyboard',sent[2][3])
            self.assertEqual([[(getattr(button,'callback_data',None) or button[1])[:2] for button in row] for row in rows],[['na'],['nc'],['nw'],['nd']])
            for bad in [four['buttons'][::-1],four['buttons']+[['More',data('c')]],[four['buttons'][0],four['buttons'][0],four['buttons'][3]],
                        [four['buttons'][0],['Reject','nd'+'b'*56]],[four['buttons'][0],['Stop',data('s')]]]:
                with self.subTest(buttons=bad),self.assertRaisesRegex(ValueError,'invalid_approval'):
                    await gateway.send_approval({**four,'id':'1'*64,'buttons':bad})
            self.assertEqual(len(sent),3,'Approve first, Reject last, each choice once, all for the same action')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'a'*64,'chat_id':'123','text':'Done'}),{'state':'done','edited':True})
            self.assertEqual(edits,[(123,41,'Done',None,[])],'the decided card loses its buttons')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'e'*64,'chat_id':'-20','text':group['text']+'\n\nSent.','links':group['links']}),{'state':'done','edited':True})
            self.assertEqual(edits[-1][4],sent[1][5],'and keeps its links')
            # A running background job's card keeps one Stop button, and only that.
            stop=['🛑 Stop','ns'+'a'*56]
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'a'*64,'chat_id':'123','text':'Running','buttons':[stop]}),{'state':'done','edited':True})
            from telegram import InlineKeyboardButton,InlineKeyboardMarkup
            self.assertEqual(edits[-1][:3],(123,41,'Running'))
            self.assertEqual(edits[-1][3],InlineKeyboardMarkup([[InlineKeyboardButton('🛑 Stop',callback_data='ns'+'a'*56)]]))
            for buttons in ([['Approve','na'+'a'*56]],[stop,stop],[['x'*41,stop[1]]],[['',stop[1]]],[[stop[0],'ns'+'a'*55]],[stop[0]],'ns',[]):
                with self.subTest(buttons=buttons),self.assertRaisesRegex(ValueError,'invalid_approval'):
                    await gateway.send_approval({'kind':'settle','id':'a'*64,'chat_id':'123','text':'Running','buttons':buttons})
            self.assertEqual(len(edits),3,'a refused settle edits nothing')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'a'*64,'chat_id':'123','text':'Done'}),{'state':'done','edited':True})
            self.assertIsNone(edits[-1][3],'a settle without buttons removes them')
            self.assertEqual(await gateway.send_approval({'kind':'settle','id':'c'*64,'chat_id':'123','text':'Done'}),{'state':'done','edited':False},
                             'only a card this runtime sent is edited')
            self.assertEqual(await gateway.send_approval({'kind':'answer','chat_id':'123','callback_query_id':'q1','text':'Approved.'}),{'state':'done','answered':True})
            self.assertEqual(answers,[('q1','Approved.')])
            offline=self.gateway(Path(folder),sent);offline.status='reconnecting'
            self.assertEqual(await offline.send_approval({**card,'id':'d'*64}),{'state':'not_started','error_code':'telegram_not_connected'})

    async def test_a_card_whose_send_lost_its_answer_is_settled_through_the_press(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];edits=[];gateway=self.gateway(Path(folder),sent,edits)
            async def lost(*args,**kwargs):raise TimeoutError('the answer did not arrive')
            gateway.adapter._bot.send_message=lost
            data=lambda choice:'n'+choice+'f'*56
            card={'kind':'card','id':'f'*64,'chat_id':'123','text':'⚙️ Run browser','buttons':[['Approve',data('a')],['Reject',data('d')]]}
            self.assertEqual(await gateway.send_approval(card),{'state':'ambiguous'})
            settle={'kind':'settle','id':'f'*64,'chat_id':'123','text':'⚙️ Run browser\n\n✅ Approved.'}
            self.assertEqual(await gateway.send_approval(settle),{'state':'done','edited':False},'no message id is known yet')
            self.assertEqual(await gateway.send_approval({**settle,'chat_id':'-20','message_id':'77'}),{'state':'done','edited':False},
                             'a message in another chat is never this card')
            # Telegram names the card a button was pressed on; that message is edited and kept for later edits.
            self.assertEqual(await gateway.send_approval({**settle,'message_id':'77'}),{'state':'done','edited':True})
            self.assertEqual(edits[-1][:4],(123,77,settle['text'],None))
            self.assertEqual(await gateway.send_approval({**settle,'text':'⚙️ Run browser\n\n❌ Failed.'}),{'state':'done','edited':True})
            self.assertEqual(edits[-1][:2],(123,77),'a later edit without a press finds it')
            # A card never sent, a bad id, or a sent card's own message id is not replaced by a press.
            self.assertEqual(await gateway.send_approval({**settle,'id':'c'*64,'message_id':'78'}),{'state':'done','edited':False})
            for bad in ('x','0','1'*17):
                with self.subTest(message_id=bad),self.assertRaisesRegex(ValueError,'invalid_approval'):
                    await gateway.send_approval({**settle,'message_id':bad})
            other=self.gateway(Path(folder)/'other',sent,edits)
            self.assertEqual(await other.send_approval({**card,'id':'e'*64}),{'state':'done','chat_id':'123','message_id':'41'})
            self.assertEqual(await other.send_approval({**settle,'id':'e'*64,'message_id':'99'}),{'state':'done','edited':True})
            self.assertEqual(edits[-1][:2],(123,41),'a card with a known message id keeps it')
            self.assertEqual(len(edits),3)

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

    async def test_a_problem_notice_carries_its_buttons_and_falls_back_to_none(self):
        from telegram.error import BadRequest
        with tempfile.TemporaryDirectory() as folder:
            sent=[];gateway=self.gateway(Path(folder),sent)
            notice={'id':'a'*64,'chat_id':'123','text':'⚠️ Nocheh found a problem','buttons':[
                {'text':'Open','web_app':'https://mini.example.test/?page=problems'},{'text':'Retry failed','callback':'nr'}]}
            self.assertEqual(await gateway.send_notice(notice),{'state':'done'})
            self.assertEqual(await gateway.send_notice(notice),{'state':'done'})
            self.assertEqual(len(sent),1,'sent once')
            buttons=sent[0][3]
            self.assertEqual([button[0] for button in buttons[0]],['Open','Retry failed'])
            for bad in [{'text':'Open','url':'javascript:alert(1)'},{'text':'Open','web_app':'http://mini.example.test'},{'text':'Run','callback':'na'+'a'*56},
                        {'text':'','url':'https://example.test'},{'text':'Open','url':'https://example.test','callback':'nr'}]:
                with self.assertRaises(ValueError):await gateway.send_notice({**notice,'id':'b'*64,'buttons':[bad]})
            # Telegram refuses a dashboard address it does not accept: nothing was sent, so the text goes alone.
            send=gateway.adapter._bot.send_message
            async def strict(chat,text,reply_markup=None,**options):
                if reply_markup is not None:raise BadRequest('Wrong http url')
                return await send(chat,text,**options)
            gateway.adapter._bot.send_message=strict
            self.assertEqual(await gateway.send_notice({**notice,'id':'c'*64,'buttons':[{'text':'Open','url':'http://127.0.0.1:8783/#system'}]}),{'state':'done'})
            self.assertEqual((len(sent),sent[-1][3]),(2,None))
            with self.assertRaises(ValueError):await gateway.send_notice({**notice,'id':'d'*64,'chat_id':'-20'},)  # only the owner's private chat



if __name__=='__main__':
    unittest.main()
