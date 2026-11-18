"""Validate the HTTP simulator contract through the pinned Telegram SDK."""
import asyncio
import base64
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch,AsyncMock
import httpx
from fastapi import FastAPI
from telegram import Bot
from telegram.error import BadRequest,RetryAfter
from telegram.request import HTTPXRequest
from tools.acceptance.telegram_mock import ANONYMOUS_ADMIN,BOT_USER,CHANNEL_BOT,TelegramMock,TOKEN,bot_status,in_chat_name,left_member,press


class TelegramHttpFixtureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        environment=patch.dict(os.environ,{'NOCHEH_INSTALLATION_FIXTURE':'1'});environment.start();self.addCleanup(environment.stop)
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup);self.path=Path(directory.name)/'telegram.json'
        self.mock=TelegramMock(self.path);app=FastAPI();self.mock.install(app)
        def request():return HTTPXRequest(httpx_kwargs={'transport':httpx.ASGITransport(app=app)})
        self.bot=Bot(TOKEN,base_url='http://telegram.mock/bot',base_file_url='http://telegram.mock/file/bot',request=request(),get_updates_request=request())
        await self.bot.initialize();self.addAsyncCleanup(self.bot.shutdown)

    def message(self,number=1):
        return {'update_id':number,'message':{'message_id':number,'date':1700000000,'chat':{'id':123,'type':'private'},
            'from':{'id':123,'is_bot':False,'first_name':'Owner'},'text':'پیام مصنوعی 🔭'}}

    async def test_offsets_acknowledge_only_on_later_poll_and_queue_survives_restart(self):
        update=self.message();self.mock.inject({'updates':[update]})
        self.assertEqual((await self.bot.get_updates())[0].message.text,update['message']['text'])
        self.assertEqual((await self.bot.get_updates())[0].update_id,1)
        restarted=TelegramMock(self.path);self.assertEqual(len(restarted.state['updates']),1)
        self.assertEqual(await self.bot.get_updates(offset=2),())
        self.assertEqual(TelegramMock(self.path).state['updates'],[])
        # A restarted SDK begins with offset zero; already acknowledged
        # updates stay absent from the server queue.
        self.assertEqual(await self.bot.get_updates(),())

    async def test_poll_waits_for_injection_and_explicit_reaction_subscription(self):
        pending=asyncio.create_task(self.bot.get_updates(timeout=2,allowed_updates=['message','message_reaction']))
        await asyncio.sleep(.02);self.assertFalse(pending.done())
        self.mock.inject({'updates':[{'update_id':2,'message_reaction':{'chat':{'id':123,'type':'private'},'message_id':1,
            'date':1700000001,'user':{'id':123,'is_bot':False,'first_name':'Owner'},'old_reaction':[],
            'new_reaction':[{'type':'emoji','emoji':'🔭'}]}}]})
        result=await asyncio.wait_for(pending,1);self.assertEqual(result[0].message_reaction.new_reaction[0].emoji,'🔭')
        self.assertEqual(self.mock.state['allowed_updates'],['message','message_reaction'])

    async def test_negative_offset_keeps_requested_tail_and_honors_limit(self):
        self.mock.inject({'updates':[self.message(index) for index in (1,2,3)]})
        self.assertEqual([u.update_id for u in await self.bot.get_updates(offset=-2,limit=1)],[2])
        self.assertEqual([u['update_id'] for u in self.mock.state['updates']],[2,3])

    async def test_native_health_probe_observes_polling_webhook_and_pending_count(self):
        self.mock.inject({'updates':[self.message()]})
        info=await self.bot.get_webhook_info()
        self.assertEqual((info.url,info.has_custom_certificate,info.pending_update_count),('',False,1))
        await self.bot.delete_webhook(drop_pending_updates=False)
        self.assertEqual((await self.bot.get_webhook_info()).pending_update_count,1)
        await self.bot.get_updates(offset=2)
        self.assertEqual((await self.bot.get_webhook_info()).pending_update_count,0)

    async def test_topic_delivery_and_rejection_receipts_use_real_sdk_types(self):
        self.mock.state['faults'].append({'method':'sendMessage','code':429,'description':'Too Many Requests: retry after 1','parameters':{'retry_after':1}})
        with self.assertRaises(RetryAfter):await self.bot.send_message(-10042,'سلام',message_thread_id=7)
        self.assertEqual(self.mock.state['sent'],[])
        sent=await self.bot.send_message(-10042,'سلام 🔭',message_thread_id=7)
        self.assertEqual((sent.chat.id,sent.message_thread_id,sent.text),(-10042,7,'سلام 🔭'))
        self.assertEqual(len(TelegramMock(self.path).state['sent']),1)
        with self.assertRaises(BadRequest):await self.bot.send_message(123,'x'*4097)
        self.assertEqual(len(self.mock.state['sent']),1)

    async def test_approval_card_buttons_edit_and_one_answer_per_injected_press(self):
        from telegram import InlineKeyboardButton,InlineKeyboardMarkup
        keyboard=InlineKeyboardMarkup([[InlineKeyboardButton('✅ Approve',callback_data='na'+'1'*56),InlineKeyboardButton('❌ Reject',callback_data='nd'+'1'*56)]])
        card=await self.bot.send_message(123,'📨 Send to the team',reply_markup=keyboard)
        self.assertEqual(card.reply_markup.inline_keyboard[0][0].callback_data,'na'+'1'*56)
        press={'update_id':5,'callback_query':{'id':'cb5','from':{'id':123,'is_bot':False,'first_name':'Owner'},'chat_instance':'i',
            'data':'na'+'1'*56,'message':self.mock.state['sent'][0]['message']}}
        self.mock.inject({'updates':[press]})
        self.assertEqual((await self.bot.get_updates())[0].callback_query.data,'na'+'1'*56)
        with self.assertRaises(BadRequest):await self.bot.answer_callback_query('never-pressed')
        self.assertTrue(await self.bot.answer_callback_query('cb5'))
        with self.assertRaises(BadRequest):await self.bot.answer_callback_query('cb5')
        edited=await self.bot.edit_message_text('📨 Send to the team\n\n✅ Approved and sent.',chat_id=123,message_id=card.message_id)
        self.assertIsNone(edited.reply_markup)
        with self.assertRaises(BadRequest):await self.bot.edit_message_text('📨 Send to the team\n\n✅ Approved and sent.',chat_id=123,message_id=card.message_id)
        saved=TelegramMock(self.path).state['sent'][0]
        self.assertEqual((len(saved['edits']),'reply_markup' in saved['message']),(1,False))

    async def test_file_metadata_and_download_preserve_exact_synthetic_bytes(self):
        content=b'\x00synthetic\xff\x00';self.mock.state['files']['file-one']={'file_id':'file-one','file_unique_id':'unique-one',
            'file_path':'documents/file-one.bin','file_size':len(content),'bytes_base64':base64.b64encode(content).decode()}
        result=await self.bot.get_file('file-one')
        self.assertEqual(result.file_size,len(content));self.assertEqual(await result.download_as_bytearray(),content)

    async def test_fault_and_file_control_is_durable_and_rejects_partial_invalid_changes(self):
        content=b'\x00synthetic\xff';row={'file_id':'controlled','file_unique_id':'unique-controlled',
            'file_path':'documents/controlled.bin','file_size':len(content),'bytes_base64':base64.b64encode(content).decode()}
        with self.assertRaises(ValueError):self.mock.configure({'files':[row],'faults':[{'method':'unknown','code':500,'description':'invalid'}]})
        self.assertEqual(self.mock.state['files'],{});self.assertEqual(self.mock.state['faults'],[])
        self.mock.configure({'files':[row],'faults':[{'method':'sendMessage','code':429,'description':'Too Many Requests','parameters':{'retry_after':2}}]})
        self.assertEqual(TelegramMock(self.path).state['files']['controlled'],row)
        with self.assertRaises(RetryAfter):await self.bot.send_message(123,'first')
        await self.bot.send_message(123,'second')
        calls=[r for r in self.mock.state['calls'] if r['method']=='sendMessage']
        self.assertEqual([r['status'] for r in calls],[429,200]);self.assertTrue(all(r['at']>0 for r in calls))
        self.assertEqual(await (await self.bot.get_file('controlled')).download_as_bytearray(),content)

    async def test_get_chat_answers_configured_chats_and_reports_upgraded_groups(self):
        from telegram.error import BadRequest,ChatMigrated
        with self.assertRaises(ValueError):self.mock.configure({'chats':[{'id':'-1','type':'group'}]})
        self.mock.configure({'chats':[{'id':-10042,'type':'supergroup','title':'گروه مصنوعی','is_forum':True},
                                      {'id':-4242,'type':'group','migrate_to_chat_id':-1004242}]})
        chat=await self.bot.get_chat(-10042)
        self.assertEqual((chat.title,chat.type,chat.is_forum),('گروه مصنوعی','supergroup',True))
        with self.assertRaises(ChatMigrated) as moved:await self.bot.get_chat(-4242)
        self.assertEqual(moved.exception.new_chat_id,-1004242)
        with self.assertRaises(BadRequest):await self.bot.get_chat(-1)
        self.assertEqual(self.mock.state['sent'],[],'getChat sends nothing')

    async def test_lost_response_delivers_once_and_reports_only_a_gateway_failure(self):
        from telegram.error import NetworkError
        for invalid in ({'method':'getFile','code':502,'description':'x','parameters':{'deliver':True}},
                        {'method':'sendMessage','code':400,'description':'x','parameters':{'deliver':True}},
                        {'method':'sendMessage','code':502,'description':'x','parameters':{'deliver':False}}):
            with self.subTest(invalid=invalid),self.assertRaises(ValueError):self.mock.configure({'faults':[invalid]})
        self.mock.configure({'faults':[{'method':'sendMessage','code':502,'description':'Bad Gateway','parameters':{'deliver':True}}]})
        with self.assertRaises(NetworkError):await self.bot.send_message(123,'accepted but unobserved')
        self.assertEqual([row['message']['text'] for row in self.mock.state['sent']],['accepted but unobserved'])
        calls=[row for row in self.mock.state['calls'] if row['method']=='sendMessage']
        self.assertEqual([(row['status'],row['delivered']) for row in calls],[(502,True)],'one physical delivery, one observed failure')
        self.assertEqual(self.mock.state['faults'],[])

    async def test_delivery_receipt_contains_parsed_text_and_rich_markup_fails_explicitly(self):
        text='[mock] سلام 🔭. '
        from telegram.helpers import escape_markdown
        sent=await self.bot.send_message(123,escape_markdown(text,version=2),parse_mode='MarkdownV2')
        self.assertEqual(sent.text,text)
        self.assertNotEqual(self.mock.state['sent'][-1]['parameters']['text'],sent.text)
        # MarkdownV2 is parsed like Telegram: valid bold becomes an entity, an
        # unclosed entity is refused, and any other parse mode fails the gate.
        bold=await self.bot.send_message(123,'*bold*',parse_mode='MarkdownV2')
        self.assertEqual((bold.text,bold.entities[0].type),('bold','bold'))
        with self.assertRaises(BadRequest):await self.bot.send_message(123,'*bold',parse_mode='MarkdownV2')
        with self.assertRaises(BadRequest):await self.bot.send_message(123,'<b>bold</b>',parse_mode='HTML')
        self.assertEqual(self.mock.state['unknown'],['sendMessage:HTML'])
        self.assertEqual(len(self.mock.state['sent']),2)

    async def test_get_me_describes_the_bot_with_its_group_and_business_flags(self):
        me=await self.bot.get_me()
        self.assertEqual((me.id,me.can_join_groups,me.can_read_all_group_messages,me.supports_inline_queries,me.can_connect_to_business),
                         (BOT_USER['id'],True,True,False,False))
        sent=await self.bot.send_message(123,'x')
        self.assertEqual(self.mock.state['sent'][0]['message']['from'],BOT_USER,'a message carries the plain user, not getMe')
        self.assertEqual(sent.from_user.id,BOT_USER['id'])

    async def test_adds_by_the_owner_someone_or_an_anonymous_admin_parse_as_telegram_sends_them(self):
        group={'id':-1001234567890,'type':'supergroup','title':'Bakery'}
        alice={'id':111,'is_bot':False,'first_name':'Alice'}
        self.mock.inject({'updates':[bot_status(10,group,alice),bot_status(20,group,ANONYMOUS_ADMIN,'member','administrator'),
                                     bot_status(30,group,alice,'administrator','kicked')]})
        updates=await self.bot.get_updates(allowed_updates=['message','my_chat_member'])
        changes=[(u.my_chat_member.from_user.id,u.my_chat_member.old_chat_member.status,u.my_chat_member.new_chat_member.status) for u in updates]
        self.assertEqual(changes,[(111,'left','member'),(1087968824,'member','administrator'),(111,'administrator','kicked')])
        self.assertTrue(all(u.my_chat_member.new_chat_member.user.id==BOT_USER['id'] and u.my_chat_member.chat.title=='Bakery' for u in updates))
        self.assertEqual(self.mock.state['members']['-1001234567890']['status'],'kicked')

    async def test_leave_chat_reports_the_bot_leaving_and_a_second_leave_is_refused(self):
        group={'id':-1001234567890,'type':'supergroup','title':'Bakery'}
        self.mock.inject({'updates':[bot_status(40,group,{'id':111,'is_bot':False,'first_name':'Alice'})]})
        self.assertEqual(len(await self.bot.get_updates()),1)
        self.assertTrue(await self.bot.leave_chat(-1001234567890))
        left=(await self.bot.get_updates(offset=41))[0]
        # Like Telegram: a my_chat_member update from the bot itself, numbered after every queued update.
        self.assertEqual((left.update_id,left.my_chat_member.from_user.id,left.my_chat_member.old_chat_member.status,
                          left.my_chat_member.new_chat_member.status,left.my_chat_member.chat.title),(41,BOT_USER['id'],'member','left','Bakery'))
        self.assertEqual([row['chat_id'] for row in TelegramMock(self.path).state['left']],[-1001234567890])
        from telegram.error import Forbidden
        with self.assertRaises(Forbidden):await self.bot.leave_chat(-1001234567890)
        with self.assertRaises(BadRequest):await self.bot.leave_chat(123)
        self.assertEqual(len(self.mock.state['left']),1)
        self.assertEqual(self.mock.state['unknown'],[])

    async def test_updates_the_fake_sends_never_take_an_id_the_tester_keeps_and_sort_after_queued_ones(self):
        group={'id':-1001234567890,'type':'supergroup','title':'Bakery'}
        self.mock.inject({'updates':[self.message(9)]})
        self.assertEqual(self.mock.next_update_id(),11,'ten is the tester\'s')
        self.mock.state['last_update_id']=19;self.mock.state['offset']=0
        self.assertEqual(self.mock.next_update_id(),21)
        self.assertTrue(await self.bot.leave_chat(-1001234567890))
        self.assertEqual([u['update_id'] for u in self.mock.state['updates']],[9,22])
        # A tester update queued later still gets its own id: a multiple of ten after what the fake sent.
        self.assertEqual(self.mock.inject({'updates':[self.message(30)]})['last_update_id'],30)
        self.assertEqual([u.update_id for u in await self.bot.get_updates()],[9,22,30])

    async def test_a_refused_leave_is_reported_without_leaving(self):
        self.mock.configure({'faults':[{'method':'leaveChat','code':400,'description':'Bad Request: synthetic refusal to leave'}]})
        with self.assertRaises(BadRequest):await self.bot.leave_chat(-1001234567890)
        self.assertEqual((self.mock.state.get('left',[]),self.mock.state['updates']),([],[]))
        self.assertEqual([row['status'] for row in self.mock.state['calls'] if row['method']=='leaveChat'],[400])
        self.assertTrue(await self.bot.leave_chat(-1001234567890))

    async def test_a_leave_service_message_parses_as_telegram_sends_it(self):
        group={'id':-1001234567890,'type':'supergroup','title':'Bakery'}
        alice,admin={'id':111,'is_bot':False,'first_name':'Alice'},{'id':222,'is_bot':False,'first_name':'Admin'}
        self.mock.inject({'updates':[left_member(60,group,alice),left_member(70,group,alice,by=admin)]})
        updates=await self.bot.get_updates()
        # Left on their own, the person is also its sender; removed, the remover is.
        self.assertEqual([(u.message.message_id,u.message.chat.id,u.message.left_chat_member.id,u.message.from_user.id) for u in updates],
                         [(60,-1001234567890,111,111),(70,-1001234567890,111,222)])
        self.assertTrue(all(u.message.text is None and u.message.sender_chat is None for u in updates))
        self.assertEqual(self.mock.state['titles']['-1001234567890'],'Bakery')

    async def test_posts_in_a_chats_own_name_name_no_person(self):
        group={'id':-1001234567890,'type':'supergroup','title':'Bakery','is_forum':True}
        channel={'id':-1009876543210,'type':'channel','title':'Bakery news'}
        mention=[{'type':'mention','offset':0,'length':len('@'+BOT_USER['username'])}]
        self.mock.inject({'updates':[in_chat_name(80,group,'@'+BOT_USER['username']+' hello',topic=7,entities=mention),
                                     in_chat_name(90,group,'Fresh bread today',sender_chat=channel)]})
        anonymous,post=await self.bot.get_updates()
        # An anonymous admin posts as the group itself, from GroupAnonymousBot, in the topic it wrote in.
        self.assertEqual((anonymous.message.sender_chat.id,anonymous.message.from_user.id,anonymous.message.message_thread_id,
                          anonymous.message.is_topic_message,anonymous.message.entities[0].type),(-1001234567890,ANONYMOUS_ADMIN['id'],7,True,'mention'))
        # A channel posts as itself, from Channel_Bot, in no topic.
        self.assertEqual((post.message.sender_chat.id,post.message.sender_chat.type,post.message.from_user.id,post.message.from_user.is_bot,
                          post.message.message_thread_id,post.message.text),(-1009876543210,'channel',CHANNEL_BOT['id'],True,None,'Fresh bread today'))
        self.assertEqual(self.mock.state['unknown'],[])

    async def test_a_press_on_a_card_reaches_the_bot_and_is_answered_once(self):
        from telegram import InlineKeyboardButton,InlineKeyboardMarkup
        data='ngx'+'a'*32
        card=await self.bot.send_message(123,'Nocheh is on in “Bakery”',reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton('No project',callback_data=data)]]))
        self.mock.inject({'updates':[press(50,self.mock.state['sent'][0]['message'],data,{'id':123,'is_bot':False,'first_name':'Owner'})]})
        query=(await self.bot.get_updates())[0].callback_query
        self.assertEqual((query.data,query.message.message_id,query.from_user.id),(data,card.message_id,123))
        self.assertTrue(await self.bot.answer_callback_query(query.id))

    async def test_unknown_method_fails_loudly_and_is_preserved_for_gate(self):
        with self.assertRaises(BadRequest):await self.bot.get_chat_administrators(123)
        self.assertEqual(self.mock.state['unknown'],['getChatAdministrators'])
        self.assertEqual(TelegramMock(self.path).state['unknown'],['getChatAdministrators'])

    async def test_fixture_transport_routes_only_the_synthetic_bot_and_rejects_other_tokens(self):
        from tools.acceptance.telegram_runtime import install_transport
        with patch.object(httpx.AsyncHTTPTransport,'handle_async_request',new_callable=AsyncMock) as send:
            restore=install_transport()
            try:
                bot=Bot(TOKEN)
                self.assertEqual(bot.base_url,'https://api.telegram.org/bot'+TOKEN)
                self.assertEqual(bot.base_file_url,'https://api.telegram.org/file/bot'+TOKEN)
                transport=httpx.AsyncHTTPTransport();self.addAsyncCleanup(transport.aclose)
                for path in ('/bot'+TOKEN+'/getUpdates','/file/bot'+TOKEN+'/documents/example.bin'):
                    request=httpx.Request('POST','https://api.telegram.org'+path,content=b'synthetic')
                    await transport.handle_async_request(request)
                    routed=send.call_args.args[-1]
                    self.assertEqual(str(routed.url),'http://model-fixture:8317'+path)
                    self.assertEqual(routed.headers['host'],'model-fixture:8317')
                    self.assertEqual(await routed.aread(),b'synthetic')
                model=httpx.Request('POST','http://model-fixture:8317/v1/chat/completions',json={})
                await transport.handle_async_request(model);self.assertIs(send.call_args.args[-1],model)
                with self.assertRaisesRegex(ValueError,'synthetic_telegram_token_required'):Bot('999999:different')
                with self.assertRaisesRegex(ValueError,'synthetic_telegram_token_required'):
                    await transport.handle_async_request(httpx.Request('POST','https://api.telegram.org/bot999999:different/getMe'))
            finally:restore()
        with patch.dict(os.environ,{'NOCHEH_INSTALLATION_FIXTURE':'0'}):
            with self.assertRaisesRegex(ValueError,'explicit_fixture_required'):install_transport()


if __name__=='__main__':unittest.main()
