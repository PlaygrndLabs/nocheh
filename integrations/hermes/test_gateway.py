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

from telegram.ext import Application,ExtBot
from telegram.request import BaseRequest
from gateway.config import PlatformConfig
from .assistant_gateway import AssistantGateway,committed_adapter_class,TURN
from .capture import canonical,digest,instrument_request
from .scopes import Scopes


class BotFixtureRequest(BaseRequest):
    def __init__(self):self.sent=[]
    @property
    def read_timeout(self):return 1
    async def initialize(self):pass
    async def shutdown(self):pass
    async def do_request(self,url,method,request_data=None,**kwargs):
        operation=url.rsplit('/',1)[-1]
        if operation=='getMe':result={'id':123456,'is_bot':True,'first_name':'Nocheh','username':'nocheh_fixture_bot'}
        elif operation=='sendMessage':
            data=request_data.parameters;self.sent.append(data)
            result={'message_id':100+len(self.sent),'date':1700000000,'chat':{'id':int(data['chat_id']),'type':'group','title':'Fixture'},'text':data['text']}
        else:raise AssertionError('Unexpected Telegram method: '+operation)
        return 200,canonical({'ok':True,'result':result})


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_ptb_batching_and_send_finish_before_durable_receipt_and_commands_cannot_enter_admin_handlers(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);secret='synthetic-service-token-123456789';(root/'token').write_text(secret)
            policy=Scopes({'enabled':True,'owner_id':'123','group_ids':['-20']})
            with patch.dict(os.environ,{'NOCHEH_SPOOL_DIR':str(root/'spool'),'SERVICE_TOKEN':secret}):
                adapter=committed_adapter_class()(PlatformConfig(enabled=True,token='123456:synthetic',typing_indicator=False))
                request=BotFixtureRequest();instrument_request(request,adapter.capture)
                bot=ExtBot('123456:synthetic',request=request,get_updates_request=BotFixtureRequest())
                app=Application.builder().bot(bot).build();await app.initialize()
                adapter._app=app;adapter._bot=bot;adapter._text_batch_delay_seconds=0.001
                adapter._register_handlers(app)
                gateway=AssistantGateway(root,root/'spool',policy,'123456:synthetic','synthetic',lambda:None)
                gateway.status='connected';gateway.adapter=adapter;gateway.lock=asyncio.Lock()
                handled=[]
                async def message(event):
                    turn=TURN.get();handled.append(event)
                    self.assertFalse(turn['scope'].owner)
                    turn['agent_result']={'state':'done','text':'Scoped fixture reply','session_id':'fixture'}
                    await asyncio.sleep(0.01)
                    return 'Scoped fixture reply'
                adapter.set_message_handler(message)
                def envelope(update_id,text):
                    key=f'telegram:123456:update:{update_id}';event=digest(key)
                    body=base64.urlsafe_b64encode(canonical({'scope':'-20','event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant'})).decode().rstrip('=')
                    signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
                    return {'event_id':event,'source_key':key,'scope':'-20','attempt':1,'archive_credential':'turn.'+body+'.'+signature,
                        'payload':{'update_id':update_id,'message':{'message_id':update_id,'date':1700000000,'chat':{'id':-20,'type':'group','title':'Fixture'},'from':{'id':456,'is_bot':False,'first_name':'User'},'text':text,'entities':[{'type':'bot_command','offset':0,'length':6}] if text.startswith('/') else []}}}
                try:
                    first=envelope(1,'Hello')
                    self.assertEqual(await gateway.dispatch(first),{'state':'done'})
                    self.assertEqual(len(request.sent),1)
                    self.assertEqual(await gateway.dispatch(first),{'state':'done'})
                    self.assertEqual(len(request.sent),1,'receipt retry cannot resend')
                    self.assertEqual(await gateway.dispatch(envelope(2,'/model')),{'state':'done'})
                    self.assertEqual(len(handled),2,'native admin command is routed only as ordinary text')
                    self.assertEqual(len(request.sent),2)
                    self.assertTrue(list((root/'spool/outbound').glob('*.result')))
                finally:await app.shutdown()


if __name__=='__main__':unittest.main()
