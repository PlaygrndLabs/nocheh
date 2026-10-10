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
from .assistant_gateway import AssistantGateway,committed_adapter_class,render_reply_citations,TURN
from .capture import canonical,digest,instrument_request
from .scopes import Scopes


class BotFixtureRequest(BaseRequest):
    def __init__(self):self.sent=[];self.lost=0;self.transmitted=[];self.reject=None;self.rejected=[]
    @property
    def read_timeout(self):return 1
    async def initialize(self):pass
    async def shutdown(self):pass
    async def do_request(self,url,method,request_data=None,**kwargs):
        operation=url.rsplit('/',1)[-1]
        if operation=='getMe':result={'id':123456,'is_bot':True,'first_name':'Nocheh','username':'nocheh_fixture_bot'}
        elif operation=='sendMessage' and self.reject:
            # Telegram answers with a definite error envelope: not delivered.
            self.rejected.append(request_data.parameters)
            return self.reject[0],canonical({'ok':False,'error_code':self.reject[0],'description':self.reject[1]})
        elif operation=='sendMessage' and self.lost:
            # The request reached the wire, but its response was lost.
            from telegram.error import NetworkError
            self.lost-=1;self.transmitted.append(request_data.parameters)
            raise NetworkError('httpx.RemoteProtocolError: Server disconnected without sending a response.')
        elif operation=='sendMessage':
            data=request_data.parameters;self.sent.append(data)
            result={'message_id':100+len(self.sent),'date':1700000000,'chat':{'id':int(data['chat_id']),'type':'group','title':'Fixture'},'text':data['text']}
        else:raise AssertionError('Unexpected Telegram method: '+operation)
        return 200,canonical({'ok':True,'result':result})


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_raw_archive_citations_are_removed_from_telegram_prose(self):
        source='a'*64
        self.assertEqual(render_reply_citations('The answer is in this chat. 【nocheh:event:'+source+'】'),
                         'The answer is in this chat.')
        self.assertEqual(render_reply_citations('See nocheh:event:'+source+' for context.'),'See the Archive for context.')

    async def test_action_executor_replay_and_interrupted_send_remain_single_effect(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);policy=Scopes({'enabled':True,'owner_id':'123','group_ids':[]})
            calls=[];started=asyncio.Event()
            async def send(destination,text,metadata=None):
                calls.append((destination,text));return SimpleNamespace(success=True)
            def gateway(sender):
                value=AssistantGateway(root,root/'spool',policy,'123456:synthetic','synthetic',lambda:None)
                value.status='connected';value.adapter=SimpleNamespace(send=sender);value.action_lock=asyncio.Lock()
                return value
            first={'id':'d'*64,'destination':'123','text':'Exact approved fixture'}
            self.assertEqual(await gateway(send).send_action(first),{'state':'done'})
            self.assertEqual(await gateway(send).send_action(first),{'state':'done'})
            self.assertEqual(len(calls),1,'executor replay after restart must use the durable result')
            async def interrupted(destination,text,metadata=None):
                calls.append((destination,text));started.set();await asyncio.Future()
            second={'id':'e'*64,'destination':'123','text':'Interrupted fixture'}
            task=asyncio.create_task(gateway(interrupted).send_action(second))
            await asyncio.wait_for(started.wait(),1);task.cancel()
            with self.assertRaises(asyncio.CancelledError):await task
            recovered=gateway(send)
            self.assertEqual(recovered.action({'id':second['id'],'observe_only':True})['state'],'ambiguous')
            self.assertEqual((await recovered.send_action(second))['state'],'ambiguous')
            self.assertEqual(len(calls),2,'an interrupted in-flight send cannot be repeated')
            offline=gateway(send);offline.status='reconnecting'
            third={'id':'f'*64,'destination':'123','text':'Sent after reconnect'}
            self.assertEqual(await offline.send_action(third),{'state':'not_started','error_code':'telegram_not_connected'})
            self.assertFalse((offline.receipts/('action-'+'f'*64+'.intent')).exists(),'a refusal records no send intent')
            self.assertEqual(offline.action({'id':third['id'],'observe_only':True}),{'state':'not_found'})
            self.assertEqual(await gateway(send).send_action(third),{'state':'done'})
            self.assertEqual(len(calls),3,'the refused action is sent once after reconnect')
            self.assertEqual((await offline.send_action(second))['state'],'ambiguous','an existing intent is never treated as a refusal')

    async def test_native_ptb_batching_and_send_finish_before_durable_receipt_and_commands_cannot_enter_admin_handlers(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);secret='synthetic-service-token-123456789';(root/'token').write_text(secret)
            policy=Scopes({'enabled':True,'owner_id':'123','group_ids':['-20'],
                           'group_access':{'-20':{'granted':['456'],'denied':[]}}})
            with patch.dict(os.environ,{'NOCHEH_SPOOL_DIR':str(root/'spool'),'SERVICE_TOKEN':secret}), patch('services.hermes.assistant_gateway.check_delivery_policy',return_value=True):
                adapter=committed_adapter_class()(PlatformConfig(enabled=True,token='123456:synthetic',typing_indicator=False))
                request=BotFixtureRequest();instrument_request(request,adapter.capture)
                bot=ExtBot('123456:synthetic',request=request,get_updates_request=BotFixtureRequest())
                app=Application.builder().bot(bot).build();await app.initialize()
                adapter._app=app;adapter._bot=bot;adapter._text_batch_delay_seconds=0.001
                adapter._register_handlers(app)
                gateway=AssistantGateway(root,root/'spool',policy,'123456:synthetic','synthetic',lambda:None)
                gateway.status='connected';gateway.adapter=adapter;gateway.capacity=asyncio.Semaphore(2);gateway.action_lock=asyncio.Lock()
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
                    lane={'lock':asyncio.Lock(),'users':0};gateway.lanes['-20']=lane
                    async with lane['lock'],gateway.capacity,gateway.capacity:
                        action=await asyncio.wait_for(gateway.send_action({'id':'a'*64,'destination':'777','text':'Approved fixture'}),1)
                    del gateway.lanes['-20']
                    self.assertEqual(action,{'state':'done'},'approved sends cannot wait behind a conversation lock')
                    with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}), patch('services.hermes.assistant_gateway.check_action_policy',return_value=False):
                        count=len(request.sent)
                        self.assertEqual(await gateway.send_action({'id':'b'*64,'destination':'777','text':'Revoked approval'}),{'state':'denied'})
                        self.assertEqual(len(request.sent),count)
                    with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}), patch('services.hermes.assistant_gateway.check_action_policy',return_value=True):
                        self.assertEqual(await gateway.send_action({'id':'b'*64,'destination':'777','text':'Revoked approval'}),{'state':'denied'},'denied receipt cannot later send')
                        (gateway.receipts/('action-'+'c'*64+'.intent')).write_bytes(canonical({'action_id':'c'*64}))
                        self.assertEqual(await gateway.send_action({'id':'c'*64,'destination':'777','text':'Uncertain old attempt'}),{'state':'ambiguous'})
                        self.assertEqual(gateway.action({'id':'c'*64,'observe_only':True}),{'state':'ambiguous'})
                        self.assertEqual(len(request.sent),count,'preexisting intent cannot send again')
                    before=len(request.sent)
                    with patch('services.hermes.assistant_gateway.check_delivery_policy',return_value=False):
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
                    failures=[]
                    async def fail_before_delivery(event):
                        failures.append(event)
                        TURN.get()['agent_result']={'state':'failed','error_code':'assistant_runtime_unavailable',
                            'error_type':'HTTPError','error_stage':'request','private_response':'do not persist'}
                        return None
                    adapter.set_message_handler(fail_before_delivery)
                    retry=envelope(23,'Retry a failed assistant turn')
                    safe_failure={'state':'failed','error_code':'assistant_runtime_unavailable',
                        'error_type':'HTTPError','error_stage':'request'}
                    self.assertEqual(await gateway.dispatch(retry),safe_failure)
                    self.assertEqual(len(request.sent),before,'pre-delivery failure cannot send')
                    self.assertEqual(await gateway.dispatch(retry),safe_failure)
                    self.assertEqual(len(failures),1,'same attempt reuses its failed receipt')
                    adapter.set_message_handler(message);retry['attempt']=2
                    self.assertEqual(await gateway.dispatch(retry),{'state':'done'})
                    self.assertEqual(len(request.sent),before+1,'fresh retry attempt sends exactly once')
                    async def malformed_diagnostic(event):
                        TURN.get()['agent_result']={'state':'failed','error_code':'assistant_runtime_unavailable',
                            'error_type':'HTTPError:private','error_stage':'request:private'}
                        return None
                    adapter.set_message_handler(malformed_diagnostic)
                    self.assertEqual(await gateway.dispatch(envelope(26,'Invalid diagnostic is excluded')),
                                     {'state':'failed','error_code':'assistant_runtime_unavailable'})
                    async def unexpected_tool(event):
                        TURN.get()['agent_result']={'state':'failed','error_code':'unexpected_profile_tool',
                            'unexpected_tool_names':['foreign_tool','private:payload']}
                        return None
                    adapter.set_message_handler(unexpected_tool)
                    mismatch=envelope(25,'Tool mismatch remains fail closed')
                    expected={'state':'failed','error_code':'unexpected_profile_tool','unexpected_tool_names':['foreign_tool']}
                    self.assertEqual(await gateway.dispatch(mismatch),expected)
                    self.assertEqual(await gateway.dispatch(mismatch),expected,'replay preserves the bounded diagnostic')
                    self.assertEqual(len(request.sent),before+1,'tool mismatch cannot send')
                    uncertain_calls=[]
                    async def interrupt_after_delivery_started(event):
                        uncertain_calls.append(event);TURN.get()['delivery_started']=True
                        raise RuntimeError('synthetic interruption')
                    adapter.set_message_handler(interrupt_after_delivery_started)
                    uncertain=envelope(24,'Do not repeat an uncertain send')
                    self.assertEqual(await gateway.dispatch(uncertain),{'state':'ambiguous','error_code':'dispatch_interrupted'})
                    self.assertEqual(await gateway.dispatch(uncertain),{'state':'ambiguous','error_code':'dispatch_interrupted'})
                    self.assertEqual(len(uncertain_calls),1,'uncertain effect receipt cannot be retried')
                    cancel=threading.Event();cancel.set()
                    self.assertEqual(await gateway.dispatch(envelope(22,'Cancelled'),cancelled=cancel),{'state':'cancelled'})
                    self.assertEqual(len(request.sent),before+1,'silence, failed attempts, and cancellation do not add sends')
                    adapter.set_message_handler(message)
                    prepared=envelope(30,'[An attachment or non-text message was archived.]','00000000-0000-4000-8000-000000000001')
                    prepared.update(text=None,transcripts=['Prepared replacement transcript'],files=[{'kind':'file','name':'Attachment','sha256':'d'*64,'text':None}])
                    prepared['payload']['message']['from']={'id':456,'is_bot':False,'first_name':'Participant'}
                    prepared['payload']['message']['chat']={'id':-20,'type':'supergroup','is_forum':False}
                    with patch.dict(os.environ,{'NOCHEH_STORAGE_LAYOUT':'original-only-v1'}):
                        self.assertEqual(await gateway.dispatch(prepared),{'state':'done'})
                        self.assertEqual(await gateway.dispatch(prepared),{'state':'done'})
                    self.assertEqual(len(request.sent),before+2,'minimal prepared-media dispatch uses the committed receipt and sends once')
                    from services.hermes.assistant_turn import conversation_result
                    completion={'completed':True,'final_response':'   '};model_calls=[]
                    async def native_completion(event):
                        model_calls.append(event)
                        result=conversation_result(completion,'synthetic-session',limited_memory=True)
                        TURN.get()['agent_result']=result
                        return result.get('text')
                    adapter.set_message_handler(native_completion)
                    empty=envelope(40,'An empty completion must be recoverable')
                    sent_before=len(request.sent)
                    expected={'state':'failed','error_code':'model_unavailable'}
                    self.assertEqual(await gateway.dispatch(empty),expected)
                    self.assertEqual(await gateway.dispatch(empty),expected)
                    self.assertEqual(len(model_calls),1,'same attempt reuses the failure receipt')
                    self.assertEqual(len(request.sent),sent_before,'empty completion cannot send a memory notice')
                    completion['final_response']='Recovered synthetic answer';empty['attempt']=2
                    self.assertEqual(await gateway.dispatch(empty),{'state':'done'})
                    self.assertEqual(await gateway.dispatch(empty),{'state':'done'})
                    self.assertEqual(len(model_calls),2,'only the new attempt calls the model')
                    self.assertEqual(len(request.sent),sent_before+1,'recovery delivers once')
                    completion['final_response']='[NO_REPLY]'
                    silent=envelope(41,'Explicit silence remains a distinct completed decision')
                    suppressed={'state':'suppressed','error_code':'intentional_silence'}
                    self.assertEqual(await gateway.dispatch(silent),suppressed)
                    self.assertEqual(await gateway.dispatch(silent),suppressed)
                    self.assertEqual(len(model_calls),3)
                    self.assertEqual(len(request.sent),sent_before+1,'silence adds no delivery')
                    # A native send can fail before any request, for example
                    # while polling reconnects. That outcome is not uncertain.
                    completion['final_response']='Reply after reconnect'
                    unsent=envelope(42,'Native send unavailable before transmission')
                    adapter._send_path_degraded=True
                    not_sent={'state':'failed','error_code':'assistant_runtime_unavailable','error_stage':'telegram_send_not_transmitted'}
                    self.assertEqual(await gateway.dispatch(unsent),not_sent)
                    self.assertEqual(await gateway.dispatch(unsent),not_sent,'same attempt reuses its receipt')
                    self.assertEqual(len(request.sent),sent_before+1,'no request was transmitted')
                    adapter._send_path_degraded=False;unsent['attempt']=2
                    self.assertEqual(await gateway.dispatch(unsent),{'state':'done'})
                    self.assertEqual(len(request.sent),sent_before+2,'a fresh attempt delivers exactly once')
                    # Once a request is admitted for transmission, a lost
                    # response remains uncertain and is never resent.
                    request.lost=3;lost=envelope(43,'Lost Telegram response')
                    uncertain={'state':'ambiguous','error_code':'delivery_unconfirmed'}
                    self.assertEqual(await gateway.dispatch(lost),uncertain)
                    self.assertTrue(request.transmitted,'fixture observed a transmitted request')
                    self.assertEqual(await gateway.dispatch(lost),uncertain)
                    self.assertEqual(len(request.sent),sent_before+2)
                    # Definite Bot API rejections are terminal, not uncertain.
                    request.reject=(403,'Forbidden: bot was blocked by the user');blocked=envelope(44,'Blocked bot')
                    rejected={'state':'suppressed','error_code':'telegram_rejected'}
                    self.assertEqual(await gateway.dispatch(blocked),rejected)
                    self.assertEqual(len(request.rejected),1,'a definite rejection is not retried')
                    self.assertEqual(await gateway.dispatch(blocked),rejected,'the receipt is reused')
                    self.assertEqual(len(request.sent),sent_before+2)
                    request.reject=None
                finally:await app.shutdown()

    async def test_turns_in_different_chats_run_side_by_side_and_one_chat_keeps_its_order(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);secret='synthetic-service-token-123456789'
            policy=Scopes({'enabled':True,'owner_id':'123','group_ids':['-20','-30','-40'],
                           'group_access':{chat:{'granted':['456'],'denied':[]} for chat in ('-20','-30','-40')}})
            with patch.dict(os.environ,{'NOCHEH_SPOOL_DIR':str(root/'spool'),'SERVICE_TOKEN':secret}), patch('services.hermes.assistant_gateway.check_delivery_policy',return_value=True):
                adapter=committed_adapter_class()(PlatformConfig(enabled=True,token='123456:synthetic',typing_indicator=False))
                request=BotFixtureRequest();instrument_request(request,adapter.capture)
                bot=ExtBot('123456:synthetic',request=request,get_updates_request=BotFixtureRequest())
                app=Application.builder().bot(bot).build();await app.initialize()
                adapter._app=app;adapter._bot=bot;adapter._text_batch_delay_seconds=0.001
                adapter._register_handlers(app)
                gateway=AssistantGateway(root,root/'spool',policy,'123456:synthetic','synthetic',lambda:None)
                gateway.status='connected';gateway.adapter=adapter;gateway.capacity=asyncio.Semaphore(2);gateway.action_lock=asyncio.Lock()
                gates={};started=[]
                async def message(event):
                    turn=TURN.get();text=turn['body']['payload']['message']['text']
                    started.append(text)
                    await gates.setdefault(text,asyncio.Event()).wait()
                    turn['agent_result']={'state':'done','text':'Reply to '+text,'session_id':'fixture'}
                    return 'Reply to '+text
                adapter.set_message_handler(message)
                def envelope(update_id,chat,text):
                    key=f'telegram:123456:update:{update_id}';event=digest(key)
                    claims={'scope':chat,'event_id':event,'expires':time.time()*1000+600000,'audience':'nocheh-assistant'}
                    body=base64.urlsafe_b64encode(canonical(claims)).decode().rstrip('=')
                    signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
                    return {'event_id':event,'source_key':key,'scope':chat,'attempt':1,'archive_credential':'turn.'+body+'.'+signature,
                        'payload':{'update_id':update_id,'message':{'message_id':update_id,'date':1700000000,'chat':{'id':int(chat),'type':'group','title':'Fixture'},'from':{'id':456,'is_bot':False,'first_name':'User'},'text':text,'entities':[]}}}
                async def until(condition):
                    for _ in range(500):
                        if condition():return
                        await asyncio.sleep(0.005)
                    self.fail('condition not reached')
                try:
                    progress={}
                    def track(text):return lambda stage:progress.setdefault(text,[]).append(stage)
                    slow=asyncio.create_task(gateway.dispatch(envelope(1,'-20','slow'),progress=track('slow')))
                    await until(lambda:'slow' in started)
                    later=asyncio.create_task(gateway.dispatch(envelope(2,'-20','later'),progress=track('later')))
                    gates['other']=asyncio.Event();gates['other'].set()
                    other=await asyncio.wait_for(gateway.dispatch(envelope(3,'-30','other'),progress=track('other')),2)
                    self.assertEqual(other,{'state':'done'},'another chat does not wait for a running turn')
                    self.assertEqual([m['text'] for m in request.sent],['Reply to other'])
                    self.assertEqual([str(m['chat_id']) for m in request.sent],['-30'],'each reply goes to its own chat')
                    held=asyncio.create_task(gateway.dispatch(envelope(4,'-30','held'),progress=track('held')))
                    await until(lambda:'held' in started)
                    third=asyncio.create_task(gateway.dispatch(envelope(5,'-40','third'),progress=track('third')))
                    await asyncio.sleep(0.05)
                    self.assertNotIn('later',started,'the same chat keeps its order')
                    self.assertNotIn('third',progress,'a third chat waits for a free slot before its turn starts')
                    gates['held'].set()
                    self.assertEqual(await asyncio.wait_for(held,2),{'state':'done'})
                    gates.setdefault('third',asyncio.Event()).set()
                    self.assertEqual(await asyncio.wait_for(third,2),{'state':'done'})
                    self.assertNotIn('later',started,'a free slot does not reorder one chat')
                    gates.setdefault('later',asyncio.Event()).set();gates['slow'].set()
                    self.assertEqual(await asyncio.wait_for(slow,2),{'state':'done'})
                    self.assertEqual(await asyncio.wait_for(later,2),{'state':'done'})
                    self.assertLess(started.index('slow'),started.index('later'))
                    replies=[m['text'] for m in request.sent]
                    self.assertLess(replies.index('Reply to slow'),replies.index('Reply to later'))
                    self.assertEqual(len(replies),5,'every turn sends exactly once')
                    self.assertEqual(gateway.lanes,{},'idle chats leave no lane behind')
                    again=await gateway.dispatch(envelope(1,'-20','slow'))
                    self.assertEqual(again,{'state':'done'});self.assertEqual(len(request.sent),5,'a replayed receipt does not resend')
                finally:await app.shutdown()


if __name__=='__main__':unittest.main()
