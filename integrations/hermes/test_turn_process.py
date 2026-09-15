import asyncio
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, AsyncMock
from .turn_process import _run_process,run_process
from .scopes import Scope

class TurnProcessTests(unittest.IsolatedAsyncioTestCase):
    async def execute(self,source,cancel=None):
        with tempfile.TemporaryDirectory() as folder:
            self.env=None;original=asyncio.create_subprocess_exec
            async def spawn(*args,**kwargs):
                self.env=kwargs['env']
                return await original(sys.executable,'-c',source,**kwargs)
            with patch('integrations.hermes.turn_process.asyncio.create_subprocess_exec',spawn),patch.dict(os.environ,{'TELEGRAM_BOT_TOKEN':'hidden','OPENAI_API_KEY':'hidden','SERVICE_TOKEN':'hidden'}),patch('integrations.hermes.assistant_gateway.check_delivery_policy',return_value=True):
                events=[]
                result=await _run_process(Path(folder),Scope('-10','42',False,'group'),
                    {'event_id':'event','archive_credential':'scoped','text':'original','channel':'browser'},'model',
                    SimpleNamespace(access_token='ephemeral'),'session',events.append,cancel)
                self.assertNotIn('SERVICE_TOKEN',self.env);self.assertNotIn('TELEGRAM_BOT_TOKEN',self.env);self.assertNotIn('OPENAI_API_KEY',self.env)
                return result,events
    async def test_stream_framing_and_failed_child(self):
        result,events=await self.execute('import sys,json; body=json.load(sys.stdin); assert body["channel"]=="browser"; print(json.dumps({"event":"message.delta","text":"hello"})); print(json.dumps({"state":"done","text":"hello"}))')
        self.assertEqual(events,['hello']);self.assertEqual(result['state'],'done')
        with self.assertRaisesRegex(RuntimeError,'assistant_process_failed'):
            await self.execute('import sys; sys.stdin.read(); sys.exit(1)')
    async def test_cancel_kills_child(self):
        cancel=threading.Event()
        async def stop(): await asyncio.sleep(.15);cancel.set()
        task=asyncio.create_task(stop())
        result,_=await self.execute('import sys,time; sys.stdin.read(); time.sleep(60)',cancel)
        await task;self.assertEqual(result['state'],'cancelled')
    async def test_profile_wait_preserves_identity_and_does_not_block_capture_loop(self):
        import fcntl
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);body={'archive_credential':'turn.e30.signature'}
            with (profile/'.turn.lock').open('a') as lock,patch('integrations.hermes.assistant_gateway.prepare_profile',return_value=profile),patch('integrations.hermes.assistant_gateway.check_delivery_policy',return_value=True),patch('integrations.hermes.turn_process._run_process',new_callable=AsyncMock,return_value={'state':'done'}) as child:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                task=asyncio.create_task(run_process(profile,Scope('42','42',True,'owner'),body,'model',None,'same-session'))
                await asyncio.sleep(.05)
                self.assertFalse(task.done());child.assert_not_awaited()
                fcntl.flock(lock,fcntl.LOCK_UN)
                self.assertEqual((await asyncio.wait_for(task,2))['state'],'done')
                self.assertIs(child.call_args.args[2],body)
                self.assertEqual(child.call_args.args[5],'same-session')
                self.assertTrue((profile/'.foreground').exists())

    async def test_cancel_and_revocation_while_waiting_never_start_child(self):
        import fcntl
        for revoked in (False,True):
            with tempfile.TemporaryDirectory() as folder:
                profile=Path(folder);cancel=threading.Event();valid=True
                with (profile/'.turn.lock').open('a') as lock,patch('integrations.hermes.assistant_gateway.prepare_profile',return_value=profile),patch('integrations.hermes.assistant_gateway.check_delivery_policy',side_effect=lambda _:valid),patch('integrations.hermes.turn_process._run_process',new_callable=AsyncMock) as child:
                    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    task=asyncio.create_task(run_process(profile,Scope('42','42',True,'owner'),{'archive_credential':'turn.e30.signature'},'model',None,'session',cancelled=cancel))
                    await asyncio.sleep(.05)
                    if revoked:valid=False
                    else:cancel.set()
                    result=await asyncio.wait_for(task,2)
                    self.assertEqual(result['state'],'failed' if revoked else 'cancelled')
                    child.assert_not_awaited()

    async def test_review_defers_before_execution_when_profile_is_busy(self):
        import fcntl
        from .review_worker import review
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder)
            with (profile/'.turn.lock').open('a') as lock,patch('integrations.hermes.review_worker.prepare_profile',return_value=profile),patch('integrations.hermes.review_worker._review') as child:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                result=review(profile,SimpleNamespace(owner='42'),'model',None,{'scope':'42','id':'a'*64,'content':'synthetic','archive_credential':'turn.e30.signature'})
                self.assertEqual(result,{'state':'waiting','error_code':'profile_busy'});child.assert_not_called()

    async def test_already_cancelled_never_starts_a_child(self):
        cancel=threading.Event();cancel.set()
        with patch('integrations.hermes.turn_process.asyncio.create_subprocess_exec',side_effect=AssertionError('must not spawn')):
            result=await _run_process(Path('/unused'),None,{},None,None,'session',None,cancel)
            self.assertEqual(result['state'],'cancelled')

    async def test_review_waits_for_conversation_quiet_interval_without_losing_identity(self):
        from .review_worker import review
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);activity=profile/'.foreground';activity.touch()
            body={'scope':'42','id':'a'*64,'content':'synthetic','archive_credential':'turn.e30.signature'}
            with patch('integrations.hermes.review_worker.prepare_profile',return_value=profile),patch('integrations.hermes.review_worker._review',return_value={'state':'done'}) as child:
                now=activity.stat().st_mtime
                with patch('integrations.hermes.review_worker.time.time',return_value=now+30):
                    self.assertEqual(review(profile,SimpleNamespace(owner='42'),'model',None,body),{'state':'waiting','error_code':'profile_busy'})
                    child.assert_not_called()
                with patch('integrations.hermes.review_worker.time.time',return_value=now+61):
                    self.assertEqual(review(profile,SimpleNamespace(owner='42'),'model',None,body),{'state':'done'})
                    self.assertIs(child.call_args.args[-1],body)
