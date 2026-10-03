import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from .capture import Capture, DISPATCH_KEY, canonical, captured_adapter_class, digest, instrument_request


class Request:
    def __init__(self, response=None, error=None):
        self.response, self.error, self.calls = response, error, 0

    async def do_request(self, *args, **kwargs):
        self.calls += 1
        if self.error:
            raise self.error
        return self.response


class CaptureTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.capture = Capture(self.root, 'testbot')

    async def asyncTearDown(self):
        self.directory.cleanup()

    async def test_capture_before_return_and_duplicate_batches_preserve_originals(self):
        update = {'update_id':1,'message':{'message_id':5,'date':1700000000,'chat':{'id':-20},'text':'Aws pass: 123456\r\n😃  '}}
        raw = json.dumps({'ok':True,'result':[update]}).encode()
        request = instrument_request(Request((200,raw)), self.capture, polling=True)
        self.assertEqual(await request.do_request(url='https://api.telegram.org/botredacted/getUpdates'),(200,raw))
        files = list((self.root/'pending').glob('*.json'))
        self.assertEqual(len(files),2)
        events = [json.loads(p.read_bytes()) for p in files]
        self.assertEqual(next(e for e in events if e['kind']=='telegram_update')['text'],update['message']['text'])
        self.assertEqual(next(e for e in events if e['kind']=='telegram_wire')['origin'],'live')
        await request.do_request(url='https://api.telegram.org/botredacted/getUpdates')
        self.assertEqual(len(list((self.root/'pending').glob('*.json'))),2)

    async def test_reaction_timestamps_and_unknown_fields_are_captured_without_message_context(self):
        changes=[{'update_id':2,'message_reaction':{'chat':{'id':-20},'message_id':5,'date':1700000001,
                  'user':{'id':7},'old_reaction':[],'new_reaction':[{'type':'emoji','emoji':'✅'}],'future_field':'exact'}},
                 {'update_id':3,'message_reaction_count':{'chat':{'id':-20},'message_id':5,'date':1700000002,'reactions':[]}}]
        self.capture.updates((200,json.dumps({'ok':True,'result':changes}).encode()))
        events=[json.loads(p.read_bytes()) for p in (self.root/'pending').glob('*.json')]
        updates=sorted((e for e in events if e['kind']=='telegram_update'),key=lambda e:e['revision'])
        self.assertEqual([e['occurred_at'] for e in updates],['1700000001','1700000002'])
        self.assertEqual([e['payload'] for e in updates],changes)
        self.assertTrue(all(e['text'] is None for e in updates))

    async def test_disk_failure_never_returns_an_acknowledgeable_update(self):
        request=instrument_request(Request((200,b'{"ok":true,"result":[{"update_id":1}]}')),self.capture,polling=True)
        with patch.object(self.capture,'enqueue',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                await request.do_request(url='https://api.telegram.org/botredacted/getUpdates')

    async def test_ambiguous_send_survives_restart_without_resending(self):
        request=instrument_request(Request(error=TimeoutError()),self.capture)
        token=DISPATCH_KEY.set('telegram:testbot:update:1')
        arguments={'url':'https://api.telegram.org/botredacted/sendMessage','request_data':SimpleNamespace(parameters={'chat_id':-20,'text':'hello 😃'})}
        try:
            with self.assertRaises(TimeoutError): await request.do_request(**arguments)
            restarted=instrument_request(Request((200,b'{"ok":true}')),Capture(self.root,'testbot'))
            with self.assertRaisesRegex(RuntimeError,'ambiguous'): await restarted.do_request(**arguments)
            self.assertEqual(request.calls,1); self.assertEqual(restarted.calls,0)
            results=[json.loads(p.read_bytes()) for p in (self.root/'pending').glob('*.json')]
            self.assertEqual(next(e for e in results if e['kind']=='outbound_result')['payload']['state'],'ambiguous')
        finally: DISPATCH_KEY.reset(token)

    async def test_delivered_send_reuses_recorded_result_on_retry(self):
        request=instrument_request(Request((200,b'{"ok":true,"result":{"message_id":8}}')),self.capture)
        token=DISPATCH_KEY.set('telegram:testbot:update:2')
        try:
            args={'url':'https://api.telegram.org/botredacted/sendMessage','request_data':SimpleNamespace(parameters={'chat_id':20,'text':'hello'})}
            first=await request.do_request(**args)
            self.assertEqual(await request.do_request(**args),first)
            self.assertEqual(request.calls,1)
        finally: DISPATCH_KEY.reset(token)

    async def test_orphan_intent_is_recorded_as_ambiguous_at_restart(self):
        self.capture.outbound('sendMessage',{'chat_id':20,'text':'hello'},'crashed-dispatch')
        Capture(self.root,'testbot')
        results=[json.loads(p.read_bytes()) for p in (self.root/'pending').glob('*.json')]
        self.assertEqual(next(e for e in results if e['kind']=='outbound_result')['payload']['state'],'ambiguous')

    async def test_rate_limit_wait_survives_restart_then_success_is_reused(self):
        parameters={'chat_id':20,'text':'synthetic rate limit'}
        rejected=(429,canonical({'ok':False,'error_code':429,'parameters':{'retry_after':10}}))
        key,_=self.capture.outbound('sendMessage',parameters,'limited')
        self.capture.complete(key,'sendMessage',parameters,rejected)
        original=self.root/'outbound'/(digest(key)+'.result')
        original_bytes=original.read_bytes();completed_at=original.stat().st_mtime
        restarted=Capture(self.root,'testbot')
        with patch('services.hermes.capture.time.time',return_value=completed_at+9):
            self.assertEqual(restarted.outbound('sendMessage',parameters,'limited'),(key,rejected))
        with patch('services.hermes.capture.time.time',return_value=completed_at+10):
            retry,saved=restarted.outbound('sendMessage',parameters,'limited')
        self.assertNotEqual(retry,key);self.assertIsNone(saved)
        delivered=(200,b'{"ok":true,"result":{"message_id":8}}')
        restarted.complete(retry,'sendMessage',parameters,delivered)
        with patch('services.hermes.capture.time.time',return_value=completed_at+20):
            self.assertEqual(Capture(self.root,'testbot').outbound('sendMessage',parameters,'limited'),(retry,delivered))
        self.assertEqual(original.read_bytes(),original_bytes,'a retry must preserve the original rejection receipt')
        self.assertEqual(len(list((self.root/'outbound').glob('*.intent'))),2)

    async def test_rate_limit_retries_are_bounded_across_restart(self):
        parameters={'chat_id':20,'text':'bounded synthetic retry'}
        rejected=(429,canonical({'ok':False,'error_code':429,'parameters':{'retry_after':0}}))
        keys=[]
        for _ in range(3):
            key,saved=Capture(self.root,'testbot').outbound('sendMessage',parameters,'bounded')
            self.assertIsNone(saved);keys.append(key)
            self.capture.complete(key,'sendMessage',parameters,rejected)
        self.assertEqual(len(set(keys)),3)
        for _ in range(3):
            self.assertEqual(Capture(self.root,'testbot').outbound('sendMessage',parameters,'bounded'),(keys[-1],rejected))
        self.assertEqual(len(list((self.root/'outbound').glob('*.intent'))),3)

    async def test_only_documented_rate_limit_rejections_allow_another_attempt(self):
        responses=[(429,b'not json'),(429,b'[]'),(429,b'{"ok":false,"error_code":429}'),
                   (429,canonical({'ok':False,'error_code':400,'parameters':{'retry_after':0}})),
                   (400,canonical({'ok':False,'error_code':429,'parameters':{'retry_after':0}}))]
        responses += [(429,canonical({'ok':False,'error_code':429,'parameters':{'retry_after':delay}}))
                      for delay in (-1,False,'0',0.5,None)]
        for index,response in enumerate(responses):
            with self.subTest(response=response):
                parameters={'chat_id':20,'text':'invalid synthetic retry'};dispatch='invalid-'+str(index)
                key,_=self.capture.outbound('sendMessage',parameters,dispatch)
                self.capture.complete(key,'sendMessage',parameters,response)
                self.assertEqual(Capture(self.root,'testbot').outbound('sendMessage',parameters,dispatch),(key,response))

    async def test_crashed_or_uncertain_rate_limit_retry_is_never_repeated(self):
        parameters={'chat_id':20,'text':'uncertain synthetic retry'}
        rejected=(429,canonical({'ok':False,'error_code':429,'parameters':{'retry_after':0}}))
        for index,response in enumerate((None,(500,b'{"ok":false,"error_code":500}'))):
            with self.subTest(response=response):
                dispatch='uncertain-'+str(index)
                first,_=self.capture.outbound('sendMessage',parameters,dispatch)
                self.capture.complete(first,'sendMessage',parameters,rejected)
                retry,saved=self.capture.outbound('sendMessage',parameters,dispatch)
                self.assertIsNone(saved)
                if response is not None:self.capture.complete(retry,'sendMessage',parameters,response)
                with self.assertRaisesRegex(RuntimeError,'outbound_delivery_ambiguous'):
                    Capture(self.root,'testbot').outbound('sendMessage',parameters,dispatch)
                receipt=json.loads((self.root/'outbound'/(digest(retry)+'.result')).read_bytes())
                self.assertEqual(receipt['state'],'ambiguous')

    async def test_native_cold_start_retains_updates_and_handlers_require_committed_dispatch(self):
        from plugins.platforms.telegram.adapter import TelegramAdapter
        from telegram.ext import ApplicationHandlerStop
        cls=captured_adapter_class(); adapter=object.__new__(cls); adapter.capture=self.capture
        with patch.object(TelegramAdapter,'_start_polling_resilient',new_callable=AsyncMock) as native:
            await adapter._start_polling_resilient(drop_pending_updates=True,error_callback=None)
            self.assertFalse(native.call_args.kwargs['drop_pending_updates'])
            self.assertNotIn('allowed_updates',native.call_args.kwargs)
        with patch.object(TelegramAdapter,'_start_polling_once',new_callable=AsyncMock) as native:
            await adapter._start_polling_once(None,drop_pending_updates=True,error_callback=None)
            self.assertFalse(native.call_args.kwargs['drop_pending_updates'])
            self.assertNotIn('allowed_updates',native.call_args.kwargs)
        with self.assertRaises(RuntimeError): await adapter._start_webhook_mode('https://unused')
        app=SimpleNamespace(add_handler=lambda handler,group=0: handlers.append((handler,group)))
        handlers=[]
        with patch.object(TelegramAdapter,'_register_handlers') as native:
            adapter._register_handlers(app)
            native.assert_called_once_with(app)
        callback=handlers[0][0].callback
        with self.assertRaises(ApplicationHandlerStop): await callback(SimpleNamespace(update_id=1),None)
        token=DISPATCH_KEY.set('telegram:testbot:update:1')
        try: await callback(SimpleNamespace(update_id=1),None)
        finally: DISPATCH_KEY.reset(token)


if __name__ == '__main__':
    unittest.main()
