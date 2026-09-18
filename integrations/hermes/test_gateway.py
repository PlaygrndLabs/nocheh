import asyncio
import base64
import hashlib
import hmac
import json
import os
import tempfile
import time
import threading
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
            with patch.dict(os.environ,{'NOCHEH_SPOOL_DIR':str(root/'spool'),'SERVICE_TOKEN':secret}), patch('integrations.hermes.assistant_gateway.check_delivery_policy',return_value=True):
                adapter=committed_adapter_class()(PlatformConfig(enabled=True,token='123456:synthetic',typing_indicator=False))
                request=BotFixtureRequest();instrument_request(request,adapter.capture)
                bot=ExtBot('123456:synthetic',request=request,get_updates_request=BotFixtureRequest())
                app=Application.builder().bot(bot).build();await app.initialize()
                adapter._app=app;adapter._bot=bot;adapter._text_batch_delay_seconds=0.001
                adapter._register_handlers(app)
                gateway=AssistantGateway(root,root/'spool',policy,'123456:synthetic','synthetic',lambda:None)
                gateway.status='connected';gateway.adapter=adapter;gateway.lock=asyncio.Lock();gateway.action_lock=asyncio.Lock()
                handled=[]
                async def message(event):
                    turn=TURN.get();handled.append(event)
                    self.assertFalse(turn['scope'].owner)
                    turn['agent_result']={'state':'done','text':'Scoped fixture reply','session_id':'fixture'}
                    await asyncio.sleep(0.01)
                    return 'Scoped fixture reply'
                adapter.set_message_handler(message)
                def envelope(update_id,text,generation=None):
                    key=f'telegram:123456:update:{update_id}';event=digest(key)
                    claims={'scope':'-20','event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant'}
                    if generation:claims.update(generation=generation,space='-20',revision=2,guard_epoch=2)
                    body=base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
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
                    file={'file_id':'already-archived','file_unique_id':'fixture'}
                    for index,media in enumerate([
                        {'voice':dict(file,duration=1)},
                        {'audio':dict(file,duration=1)},
                        {'photo':[dict(file,width=20,height=20)]},
                        {'sticker':dict(file,width=20,height=20,type='regular',is_animated=False,is_video=False)},
                        {'video_note':dict(file,duration=1,length=20)},
                        {'document':file},
                    ],3):
                        media_body=envelope(index,'');msg=media_body['payload']['message'];msg.pop('text');msg.update(media)
                        msg['caption']='Original Aws 😃  '
                        media_body['transcripts']=['Separately archived transcript.']
                        self.assertEqual(await gateway.dispatch(media_body),{'state':'done'},str(media.keys()))
                        self.assertEqual(handled[-1].text,msg['caption'])
                    self.assertEqual(len(handled),8)
                    # Fixture rejects getFile: none of these paths downloads or
                    # invokes the native sticker vision helper again.
                    async with gateway.lock:
                        action=await asyncio.wait_for(gateway.send_action({'id':'a'*64,'destination':'777','text':'Approved fixture'}),1)
                    self.assertEqual(action,{'state':'done'},'approved sends cannot wait behind a conversation lock')
                    with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}), patch('integrations.hermes.assistant_gateway.check_action_policy',return_value=False):
                        count=len(request.sent)
                        self.assertEqual(await gateway.send_action({'id':'b'*64,'destination':'777','text':'Revoked approval'}),{'state':'denied'})
                        self.assertEqual(len(request.sent),count)
                    with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}), patch('integrations.hermes.assistant_gateway.check_action_policy',return_value=True):
                        self.assertEqual(await gateway.send_action({'id':'b'*64,'destination':'777','text':'Revoked approval'}),{'state':'denied'},'denied receipt cannot later send')
                        (gateway.receipts/('action-'+'c'*64+'.intent')).write_bytes(canonical({'action_id':'c'*64}))
                        self.assertEqual(await gateway.send_action({'id':'c'*64,'destination':'777','text':'Uncertain old attempt'}),{'state':'ambiguous'})
                        self.assertEqual(gateway.action({'id':'c'*64,'observe_only':True}),{'state':'ambiguous'})
                        self.assertEqual(len(request.sent),count,'preexisting intent cannot send again')
                    before=len(request.sent)
                    with patch('integrations.hermes.assistant_gateway.check_delivery_policy',return_value=False):
                        blocked=await gateway.dispatch(envelope(20,'Policy changed during generation'))
                    self.assertEqual(blocked,{'state':'failed','error_code':'space_policy_changed'})
                    self.assertEqual(len(request.sent),before,'policy recheck precedes native sending')
                    async def silence(event):
                        TURN.get()['agent_result']={'state':'done','text':'','session_id':'fixture'}
                        return ''
                    adapter.set_message_handler(silence)
                    silent=envelope(21,'Intentional silence')
                    self.assertEqual(await gateway.dispatch(silent),{'state':'suppressed','error_code':'intentional_silence'})
                    self.assertEqual(await gateway.dispatch(silent),{'state':'suppressed','error_code':'intentional_silence'})
                    cancel=threading.Event();cancel.set()
                    self.assertEqual(await gateway.dispatch(envelope(22,'Cancelled'),cancelled=cancel),{'state':'cancelled'})
                    self.assertEqual(len(request.sent),before,'silence and cancellation cannot send a reply')
                    adapter.set_message_handler(message)
                    prepared=envelope(30,'[An attachment or non-text message was archived.]','00000000-0000-4000-8000-000000000001')
                    prepared.update(text=None,transcripts=['Prepared replacement transcript'],files=[{'kind':'file','name':'Attachment','sha256':'d'*64,'text':None}])
                    prepared['payload']['message']['from']={'id':456,'is_bot':False,'first_name':'Participant'}
                    prepared['payload']['message']['chat']={'id':-20,'type':'supergroup','is_forum':False}
                    with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}):
                        self.assertEqual(await gateway.dispatch(prepared),{'state':'done'})
                        self.assertEqual(await gateway.dispatch(prepared),{'state':'done'})
                    self.assertEqual(len(request.sent),before+1,'minimal prepared-media dispatch uses the committed receipt and sends once')
                finally:await app.shutdown()


if __name__=='__main__':unittest.main()
