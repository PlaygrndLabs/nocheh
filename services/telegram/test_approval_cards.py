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
    fake.error.Forbidden=type('Forbidden',(Exception,),{})
    sys.modules['telegram.error']=fake.error
    fake.MessageEntity=type('MessageEntity',(),{'TEXT_LINK':'text_link','__init__':lambda self,type,offset,length,url=None:self.__dict__.update(type=type,offset=offset,length=length,url=url)})
    sys.modules['telegram']=fake

from .capture import OUTBOUND_CHECK, SEND_CLASS
from .gateway import TelegramService
from .settings import Policy


class ApprovalCardTests(unittest.IsolatedAsyncioTestCase):
    def gateway(self,root,sent,edits=None,answers=None,groups=('-20',)):
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
        async def answer_callback_query(query,text=None,url=None):answers.append((query,text)+((url,) if url is not None else ()));return True
        # The served list: the owner's chat and each group, with topic 17 of each (old-shaped ids, as before step 2b).
        value=TelegramService(Policy.of(True,'123',list(groups),topics=[(group+'/topic/17',group,'17') for group in groups]),'123456:synthetic',root/'spool',root/'state')
        value.status='connected';value.action_lock=asyncio.Lock()
        value.bot=SimpleNamespace(send_message=send_message,edit_message_text=edit_message_text,answer_callback_query=answer_callback_query)
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

    async def test_an_answer_privately_tap_opens_the_bots_private_chat_with_its_record_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];answers=[];gateway=self.gateway(Path(folder),sent,[],answers)
            gateway.identity={'bot_id':'1','username':'synthetic_fixture_bot','first_name':'Synthetic'}
            tap={'kind':'answer','chat_id':'-20','callback_query_id':'q1','text':'🔒 Opening your private chat.','start':'a'*32}
            self.assertEqual(await gateway.send_approval(tap),{'state':'done','answered':True})
            self.assertEqual(answers,[('q1','🔒 Opening your private chat.','https://t.me/synthetic_fixture_bot?start='+'a'*32)],
                             'the link opens this bot, with the record id as /start')
            for start in ('A'*32,'a'*31,'a'*33,'a'*30+'/x','',32,['a'*32]):
                with self.subTest(start=start),self.assertRaisesRegex(ValueError,'invalid_approval'):
                    await gateway.send_approval({**tap,'callback_query_id':'q2','start':start})
            for identity in (None,{'bot_id':'1'},{'bot_id':'1','username':'x/../y'},{'bot_id':'1','username':'bot'}):
                gateway.identity=identity
                with self.subTest(identity=identity),self.assertRaisesRegex(ValueError,'approval_link_unavailable'):
                    await gateway.send_approval({**tap,'callback_query_id':'q3'})
            self.assertEqual(len(answers),1,'a refused tap answer reaches Telegram never; without the bot name there is no link')
            self.assertEqual(await gateway.send_approval({'kind':'answer','chat_id':'-20','callback_query_id':'q4','text':'Only the person who asked can use this button.'}),
                             {'state':'done','answered':True})
            self.assertEqual(answers[-1],('q4','Only the person who asked can use this button.'),'a refusal popup carries no link')
            self.assertEqual(sent,[])

    async def test_a_card_whose_send_lost_its_answer_is_settled_through_the_press(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];edits=[];gateway=self.gateway(Path(folder),sent,edits)
            async def lost(*args,**kwargs):raise TimeoutError('the answer did not arrive')
            gateway.bot.send_message=lost
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

    async def test_an_operation_card_carries_its_formatting_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];gateway=self.gateway(Path(folder),sent)
            data=lambda choice:'n'+choice+'b'*56
            text='Run a command\n\ntitle: Made-up\ncontent:\nLine one\nLine two\nnote:\nShort one\nShort two\n\nprintf ok'
            at=lambda part:text.index(part)
            formats=[{'type':'bold','offset':at('title:'),'length':6},{'type':'bold','offset':at('content:'),'length':8},
                     {'type':'expandable_blockquote','offset':at('Line one'),'length':17},{'type':'blockquote','offset':at('Short one'),'length':19},
                     {'type':'pre','offset':at('printf'),'length':9}]
            card={'kind':'card','id':'a'*64,'chat_id':'123','text':text,'links':formats,'buttons':[['Approve',data('a')],['Reject',data('d')]]}
            self.assertEqual((await gateway.send_approval(card))['state'],'done')
            self.assertEqual(sent[0][5],[(link['type'],link['offset'],link['length'],None) for link in formats],
                             'labels in bold, text in a quote shown whole or one that opens on a tap, a command as code')
            bold={'type':'bold','offset':0,'length':3}
            for bad in [[{**bold,'type':'italic'}],[{**bold,'type':'text_link'}],[{**bold,'url':'https://t.me/nocheh_team'}],[{**bold,'type':'spoiler'}],
                        [{**bold,'length':0}],[{**bold,'offset':len(text)}],[{'offset':0,'length':3}],[bold]*101,['bold']]:
                with self.subTest(bad=bad),self.assertRaises(ValueError):await gateway.send_approval({**card,'id':'c'*64,'links':bad})
            self.assertEqual(await gateway.send_approval({**card,'id':'d'*64,'links':[bold]*100}),{'state':'done','chat_id':'123','message_id':'42'},
                             'up to Telegram\'s 100 entities')
            # Arguments folded under a summary: bold labels inside one quote that opens on a tap, as Telegram allows.
            fold={'type':'expandable_blockquote','offset':at('title:'),'length':at('note:')-at('title:')}
            self.assertEqual((await gateway.send_approval({**card,'id':'e'*64,'links':[fold,formats[0],formats[1]]}))['state'],'done')
            span=lambda kind,offset,size:{'type':kind,'offset':offset,'length':size}
            for bad in [[fold,formats[2]],                                          # a quote in a quote
                        [fold,span('pre',at('title:'),3)],                         # code in a quote
                        [fold,span('bold',at('note:')-2,4)],                       # a label across the fold's end
                        [span('pre',at('printf'),9),span('bold',at('printf'),6)],  # anything in code
                        [span('bold',at('title:'),8),span('bold',at('title:')+4,6)]]:  # a partial overlap
                with self.subTest(nested=bad),self.assertRaisesRegex(ValueError,'invalid_approval'):await gateway.send_approval({**card,'id':'f'*64,'links':bad})
            self.assertEqual(len(sent),3)

    async def test_someone_not_allowed_who_addresses_nocheh_gets_each_fixed_reply_once_a_day_per_group(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder:
            sent=[];gateway=self.gateway(Path(folder),sent,groups=('-20','-30'))
            # Nocheh's core sends a group refusal only for a message that addressed the bot, from someone its member directory
            # does not let talk there: a stranger, or a member who is paused or switched off there (step 3).
            ask={'event_id':'e'*64,'chat_id':'-20','user_id':'9','message_id':'5','topic':'17','once':'not_allowed','reply':'Sorry, only members.'}
            self.assertEqual(await gateway.send_refusal(ask),{'state':'done'})
            self.assertEqual(await gateway.send_refusal(ask),{'state':'done'})
            self.assertEqual(sent,[(-20,17,'Sorry, only members.',None,5,[])],'one fixed reply, in the topic of the message that asked')
            # The same person asking again that day, in any topic of that group, gets no second reply.
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'message_id':'6','topic':''}),{'state':'done'})
            self.assertEqual(len(sent),1,'at most one reply a day per person and group')
            # Each kind is its own reply; another group and another person each get theirs.
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'1'*64,'message_id':'7','once':'daily_limit','reply':'That is all for today.'}),{'state':'done'})
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'2'*64,'chat_id':'-30','message_id':'8'}),{'state':'done'})
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'3'*64,'user_id':'7','message_id':'9'}),{'state':'done'})
            self.assertEqual([(chat,answered) for chat,_,_,_,answered,_ in sent],[(-20,5),(-20,7),(-30,8),(-20,9)],'replies to messages 5, 7, 8 and 9')
            # The gateway never decides who is a member: anyone the core refuses gets the reply. Only the owner never does.
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'4'*64,'user_id':'123'}),{'state':'skipped'})
            # A new UTC day answers again.
            with patch('services.telegram.gateway.datetime') as clock:
                from datetime import datetime,timezone
                clock.now.return_value=datetime(2100,1,2,tzinfo=timezone.utc)
                self.assertEqual(await gateway.send_refusal({**ask,'event_id':'5'*64,'message_id':'10'}),{'state':'done'})
            self.assertEqual(len(sent),5)
            for bad in [{**ask,'chat_id':'-40'},{**ask,'chat_id':'123'},{**ask,'reply':''},{**ask,'reply':'x'*1001},{**ask,'event_id':'x'},
                        {key:value for key,value in ask.items() if key!='once'},{**ask,'once':'other'},{**ask,'once':['not_allowed']}]:
                with self.subTest(bad=bad),self.assertRaisesRegex(ValueError,'invalid_refusal'):await gateway.send_refusal(bad)
            self.assertEqual(len(sent),5)

    async def test_only_a_fixed_reply_that_may_have_gone_out_uses_up_the_day(self):
        try:
            from telegram.error import TimedOut
            from telegram.ext import ExtBot
            from telegram.request import BaseRequest
        except ImportError:
            self.skipTest('needs the Telegram library')
        from services.durable import canonical
        from .capture import Capture, instrument_request

        class Telegram(BaseRequest):
            """Telegram at the HTTP boundary: each sendMessage takes the next queued answer."""
            def __init__(self):self.calls,self.answers=[],[]
            @property
            def read_timeout(self):return 1
            async def initialize(self):pass
            async def shutdown(self):pass
            async def do_request(self,url,method,request_data=None,**kwargs):
                name,data=url.rsplit('/',1)[-1],request_data.parameters if request_data else {}
                if name=='getMe':return 200,canonical({'ok':True,'result':{'id':123456,'is_bot':True,'first_name':'Nocheh','username':'nocheh_fixture_bot'}})
                self.calls.append((data['chat_id'],data.get('message_thread_id'),(data.get('reply_parameters') or {}).get('message_id')))
                answer=self.answers.pop(0) if self.answers else 'sent'
                if isinstance(answer,Exception):raise answer
                if answer!='sent':return 400,canonical({'ok':False,'error_code':400,'description':answer})
                return 200,canonical({'ok':True,'result':{'message_id':40+len(self.calls),'date':1700000000,
                                                          'chat':{'id':int(data['chat_id']),'type':'supergroup'},'text':data['text']}})

        with tempfile.TemporaryDirectory() as folder:
            root,wire=Path(folder),Telegram()
            gateway=TelegramService(Policy.of(True,'123',['-20'],topics=[('-20/topic/17','-20','17')]),'123456:synthetic',root/'spool',root/'state')
            # The bot journals every send, as the running service's does.
            capture=Capture(root/'capture','123456')
            gateway.bot=ExtBot('123456:synthetic',request=instrument_request(wire,capture),get_updates_request=Telegram())
            gateway.status,gateway.action_lock='connected',asyncio.Lock()
            await gateway.bot.initialize()
            ask={'event_id':'e'*64,'chat_id':'-20','user_id':'9','message_id':'5','topic':'17','once':'not_allowed','reply':'Sorry, only members.'}
            # Telegram refuses the reply in a closed topic: nothing reached the person, so their next message gets it.
            wire.answers.append('Bad Request: TOPIC_CLOSED')
            self.assertEqual(await gateway.send_refusal(ask),{'state':'suppressed','error_code':'telegram_rejected'})
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'f'*64,'message_id':'6','topic':''}),{'state':'done'})
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'1'*64,'message_id':'7'}),{'state':'done'})
            self.assertEqual(wire.calls,[(-20,17,5),(-20,None,6)],'one reply went out that day, after the one Telegram refused')
            # A send whose answer never came may have reached them: it counts, and nothing more goes that day.
            wire.answers.append(TimedOut())
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'2'*64,'user_id':'7','message_id':'8'}),{'state':'ambiguous'})
            self.assertEqual(await gateway.send_refusal({**ask,'event_id':'3'*64,'user_id':'7','message_id':'9'}),{'state':'ambiguous'})
            self.assertEqual(wire.calls[2:],[(-20,17,8)])
            await capture.sends.settle()

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
            for bad in [{**ask,'chat_id':'10'},{**ask,'chat_id':'-20','user_id':'-20'},{**ask,'topic':'17'},{**ask,'reply':''},{**ask,'once':'not_allowed'}]:
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
            # The real keyboard, or the plain rows this file's stand-in builds when the Telegram library is not here.
            rows=getattr(sent[0][3],'inline_keyboard',sent[0][3])
            self.assertEqual([getattr(button,'text',None) or button[0] for button in rows[0]],['Open','Retry failed'])
            for bad in [{'text':'Open','url':'javascript:alert(1)'},{'text':'Open','web_app':'http://mini.example.test'},{'text':'Run','callback':'na'+'a'*56},
                        {'text':'','url':'https://example.test'},{'text':'Open','url':'https://example.test','callback':'nr'}]:
                with self.assertRaises(ValueError):await gateway.send_notice({**notice,'id':'b'*64,'buttons':[bad]})
            # Telegram refuses a dashboard address it does not accept: nothing was sent, so the text goes alone.
            send=gateway.bot.send_message
            async def strict(chat,text,reply_markup=None,**options):
                if reply_markup is not None:raise BadRequest('Wrong http url')
                return await send(chat,text,**options)
            gateway.bot.send_message=strict
            self.assertEqual(await gateway.send_notice({**notice,'id':'c'*64,'buttons':[{'text':'Open','url':'http://127.0.0.1:8783/#system'}]}),{'state':'done'})
            self.assertEqual((len(sent),sent[-1][3]),(2,None))
            with self.assertRaises(ValueError):await gateway.send_notice({**notice,'id':'d'*64,'chat_id':'-20'},)  # only the owner's private chat

    async def test_a_member_spend_notice_carries_pause_or_resume_and_no_other_press(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];gateway=self.gateway(Path(folder),sent)
            notice={'id':'a'*64,'chat_id':'123','text':'💸 Jobs members approved themselves spent $20.10 today.','buttons':[{'text':'⏸ Pause member jobs','callback':'njp'}]}
            self.assertEqual(await gateway.send_notice(notice),{'state':'done'})
            self.assertEqual(await gateway.send_notice({**notice,'id':'b'*64,'buttons':[{'text':'▶\ufe0f Resume member jobs','callback':'nju'}]}),{'state':'done'})
            first=lambda markup:getattr(markup,'inline_keyboard',markup)[0]
            self.assertEqual([getattr(button,'callback_data',None) or button[1] for row in sent for button in first(row[3])],['njp','nju'])
            for bad in ['njx','njpp','nj','np'+'a'*32]:
                with self.assertRaises(ValueError):await gateway.send_notice({**notice,'id':'c'*64,'buttons':[{'text':'Pause','callback':bad}]})
            self.assertEqual(len(sent),2,'a refused button sends nothing')
            with self.assertRaises(ValueError):await gateway.send_notice({**notice,'id':'d'*64,'chat_id':'-20'})  # only the owner's private chat

    async def test_cards_refusals_and_notices_are_sent_under_their_own_class(self):
        with tempfile.TemporaryDirectory() as folder:
            sent=[];edits=[];gateway=self.gateway(Path(folder),sent,edits,[])
            classes=[];bot=gateway.bot
            def marked(send):
                async def call(*args,**options):classes.append(SEND_CLASS.get());return await send(*args,**options)
                return call
            gateway.bot=SimpleNamespace(send_message=marked(bot.send_message),edit_message_text=marked(bot.edit_message_text),answer_callback_query=bot.answer_callback_query)
            data=lambda choice:'n'+choice+'b'*56
            await gateway.send_approval({'kind':'card','id':'b'*64,'chat_id':'123','text':'Approve?','buttons':[['Approve',data('a')],['Reject',data('d')]],'send_class':'reply'})
            await gateway.send_approval({'kind':'settle','id':'b'*64,'chat_id':'123','text':'Approved'})
            await gateway.send_refusal({'event_id':'e'*64,'chat_id':'-20','user_id':'9','message_id':'5','reply':'Sorry.','once':'not_allowed','send_class':'reply'})
            await gateway.send_notice({'id':'c'*64,'chat_id':'123','text':'Reminder','send_class':'reminder'})
            # A class the notice route does not send falls back to a notice, and the notice still goes.
            self.assertEqual(await gateway.send_notice({'id':'d'*64,'chat_id':'123','text':'Problem','send_class':'reply'}),{'state':'done'})
            await gateway.send_notice({'id':'d'*64,'chat_id':'123','text':'Cleared','edit':True})
            # The card about a group the owner added Nocheh to, and its edit after a press, are a notice and a card update (ADR-0253).
            press='ngx'+'e'*32
            await gateway.send_notice({'id':'f'*64,'chat_id':'123','text':'Nocheh is on in “Bakery”.','buttons':[{'text':'No project','callback':press}],'send_class':'notice'})
            await gateway.send_notice({'id':'f'*64,'chat_id':'123','text':'“Bakery” is in no project now.','edit':True})
            self.assertEqual(classes,['card','card_update','refusal','reminder','notice','card_update','notice','card_update'])
            self.assertIsNone(SEND_CLASS.get(),'each route resets its class')

    async def test_a_group_card_carries_rows_of_its_presses_and_no_other(self):
        # The card about a group the owner added Nocheh to (ADR-0253): a Move button per offered project, then No project and Turn off.
        with tempfile.TemporaryDirectory() as folder:
            sent=[];edits=[];gateway=self.gateway(Path(folder),sent,edits)
            press=lambda action,event='e'*32:'ng'+action+event
            rows=[[{'text':'Move to Bakery','callback':press('0')},{'text':'Move to Garden','callback':press('1')},{'text':'Move to Books','callback':press('2')}],
                  [{'text':'No project','callback':press('x')},{'text':'Turn off','callback':press('o')}]]
            card={'id':'a'*64,'chat_id':'123','text':'Nocheh is on in “Bakery” (#4321), in its new project “Bakery”.','buttons':rows}
            self.assertEqual(await gateway.send_notice(card),{'state':'done'})
            keyboard=lambda markup:[[getattr(button,'callback_data',None) or button[1] for button in row] for row in getattr(markup,'inline_keyboard',markup)]
            self.assertEqual(keyboard(sent[0][3]),[[press('0'),press('1'),press('2')],[press('x'),press('o')]])
            # One row of card presses works as a list of buttons too, and the edit after a press drops them.
            self.assertEqual(await gateway.send_notice({**card,'id':'b'*64,'buttons':rows[1]}),{'state':'done'})
            self.assertEqual(keyboard(sent[1][3]),[[press('x'),press('o')]])
            self.assertEqual(await gateway.send_notice({'id':card['id'],'chat_id':'123','text':card['text']+'\n\n“Bakery” is in no project now.','edit':True}),
                             {'state':'done','edited':True})
            self.assertIsNone(edits[-1][3])
            button=lambda data:{'text':'Move','callback':data}
            for bad in [[button(press('3'))],[button(press('m'))],[button(press('0','e'*31))],[button(press('0','e'*33))],[button(press('0','E'*32))],
                        [button('ng0')],[button('na'+'e'*56)],[button(None)],[[button(press('0'))]]*4,[[button(press('0'))]*4],[[]],[],
                        [button(press('0')),[button(press('1'))]],[[[button(press('0'))]]],[{'text':'Move','callback':press('0'),'url':'https://example.test'}]]:
                with self.subTest(bad),self.assertRaises(ValueError):await gateway.send_notice({**card,'id':'c'*64,'buttons':bad})
            self.assertEqual(len(sent),2,'a refused button sends nothing')

    async def test_a_sent_notice_is_edited_in_place_and_only_that_one(self):
        from telegram.error import BadRequest, Forbidden
        with tempfile.TemporaryDirectory() as folder:
            sent=[];edits=[];gateway=self.gateway(Path(folder),sent,edits)
            notice={'id':'a'*64,'chat_id':'123','text':'⚠️ Nocheh found a problem','buttons':[{'text':'Retry failed','callback':'nr'}]}
            self.assertEqual(await gateway.send_notice(notice),{'state':'done'})
            self.assertEqual(await gateway.send_notice(notice),{'state':'done'},'a repeated send answers only its state')
            self.assertEqual(await gateway.send_notice({**notice,'text':'✅ one cleared','edit':True}),{'state':'done','edited':True})
            self.assertEqual(edits[-1][:3],(123,41,'✅ one cleared'));self.assertIsNotNone(edits[-1][3],'it keeps its buttons')
            self.assertEqual(await gateway.send_notice({'id':'a'*64,'chat_id':'123','text':'✅ all cleared','edit':True}),{'state':'done','edited':True})
            self.assertEqual(edits[-1][:4],(123,41,'✅ all cleared',None),'the message that was sent, now without buttons')
            self.assertEqual(await gateway.send_notice({**notice,'id':'b'*64,'edit':True}),{'state':'not_found'},'only a notice this runtime sent')
            self.assertEqual(len(sent),1,'an edit never sends')
            async def unchanged(*args,**options):raise BadRequest('Message is not modified')
            gateway.bot.edit_message_text=unchanged
            self.assertEqual(await gateway.send_notice({**notice,'edit':True}),{'state':'done','edited':False})
            async def blocked(*args,**options):raise Forbidden('Forbidden: bot was blocked by the user')
            gateway.bot.edit_message_text=blocked
            self.assertEqual(await gateway.send_notice({**notice,'edit':True}),{'state':'done','edited':False},'a definite refusal is not tried again')
            async def offline(*args,**options):raise TimeoutError()
            gateway.bot.edit_message_text=offline
            self.assertEqual(await gateway.send_notice({**notice,'edit':True}),{'state':'not_started','error_code':'telegram_edit_failed'},
                             'tried again on the next check')
            with self.assertRaises(ValueError):await gateway.send_notice({**notice,'edit':'yes'})



if __name__=='__main__':
    unittest.main()
