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
from tools.acceptance.telegram_mock import TelegramMock,TOKEN


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

    async def test_file_metadata_and_download_preserve_exact_synthetic_bytes(self):
        content=b'\x00synthetic\xff\x00';self.mock.state['files']['file-one']={'file_id':'file-one','file_unique_id':'unique-one',
            'file_path':'documents/file-one.bin','file_size':len(content),'bytes_base64':base64.b64encode(content).decode()}
        result=await self.bot.get_file('file-one')
        self.assertEqual(result.file_size,len(content));self.assertEqual(await result.download_as_bytearray(),content)

    async def test_delivery_receipt_contains_parsed_text_and_rich_markup_fails_explicitly(self):
        text='[mock] سلام 🔭. '
        from telegram.helpers import escape_markdown
        sent=await self.bot.send_message(123,escape_markdown(text,version=2),parse_mode='MarkdownV2')
        self.assertEqual(sent.text,text)
        self.assertNotEqual(self.mock.state['sent'][-1]['parameters']['text'],sent.text)
        with self.assertRaises(BadRequest):await self.bot.send_message(123,'*bold*',parse_mode='MarkdownV2')
        self.assertEqual(self.mock.state['unknown'],['sendMessage:rich_markup'])
        self.assertEqual(len(self.mock.state['sent']),1)

    async def test_unknown_method_fails_loudly_and_is_preserved_for_gate(self):
        with self.assertRaises(BadRequest):await self.bot.get_chat(123)
        self.assertEqual(self.mock.state['unknown'],['getChat'])
        self.assertEqual(TelegramMock(self.path).state['unknown'],['getChat'])

    async def test_fixture_transport_keeps_operational_boundary_and_rejects_other_tokens(self):
        from tools.acceptance.telegram_runtime import install_transport
        from services.hermes.request_boundary import operational_request
        with patch.object(httpx.AsyncHTTPTransport,'handle_async_request',new_callable=AsyncMock) as send:
            restore=install_transport()
            try:
                bot=Bot(TOKEN)
                self.assertEqual(bot.base_url,'https://api.telegram.org/bot'+TOKEN)
                self.assertEqual(bot.base_file_url,'https://api.telegram.org/file/bot'+TOKEN)
                transport=httpx.AsyncHTTPTransport();self.addAsyncCleanup(transport.aclose)
                for path in ('/bot'+TOKEN+'/getUpdates','/file/bot'+TOKEN+'/documents/example.bin'):
                    request=httpx.Request('POST','https://api.telegram.org'+path,content=b'synthetic')
                    self.assertTrue(operational_request(request))
                    await transport.handle_async_request(request)
                    routed=send.call_args.args[-1]
                    self.assertEqual(str(routed.url),'http://cliproxy-api:8317'+path)
                    self.assertEqual(routed.headers['host'],'cliproxy-api:8317')
                    self.assertFalse(operational_request(routed))
                    self.assertEqual(await routed.aread(),b'synthetic')
                model=httpx.Request('POST','http://cliproxy-api:8317/v1/chat/completions',json={})
                await transport.handle_async_request(model);self.assertIs(send.call_args.args[-1],model)
                with self.assertRaisesRegex(ValueError,'synthetic_telegram_token_required'):Bot('999999:different')
                with self.assertRaisesRegex(ValueError,'synthetic_telegram_token_required'):
                    await transport.handle_async_request(httpx.Request('POST','https://api.telegram.org/bot999999:different/getMe'))
            finally:restore()
        with patch.dict(os.environ,{'NOCHEH_INSTALLATION_FIXTURE':'0'}):
            with self.assertRaisesRegex(ValueError,'explicit_fixture_required'):install_transport()


if __name__=='__main__':unittest.main()
