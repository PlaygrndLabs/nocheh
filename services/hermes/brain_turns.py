"""Telegram turns whose reply goes back to Nocheh, which sends it. Nothing here reaches Telegram.

Receipts stay content-free like every async run. The reply lives only in the run's .outcome file."""
import asyncio
import json
import re
import threading
import time
import traceback
from dataclasses import replace
from pathlib import Path
from .assistant_gateway import TURN_CAPACITY,continuation_id,native_turn,render_reply_citations
from .async_runs import CLOSED,AsyncRuns,identity
from services.durable import canonical,digest,immutable_file
from .environment import secret
from .scopes import Scopes,verify_capability
from .subscription import ProviderNotConfigured
from .timing import safe

SOURCE=re.compile(r'telegram:(\d{1,20}):update:(\d{1,20})')
BOUNDED=re.compile(r'[A-Za-z_]{1,64}')
TOOL=re.compile(r'[A-Za-z0-9_]{1,64}')


def outcome(agent,cancelled):
    """A finished turn as the gateway maps it, without delivery. Only a done turn carries content: its reply."""
    if agent['state']=='cancelled':return {'state':'cancelled'}
    if agent['state']!='done':
        result={'state':'failed','error_code':agent.get('error_code','model_unavailable')}
        if result['error_code']=='assistant_runtime_unavailable':
            # The child emits only Python type/function identifiers, never exception text.
            result.update({key:agent[key] for key in ('error_type','error_stage') if isinstance(agent.get(key),str) and BOUNDED.fullmatch(agent[key])})
        if result['error_code']=='unexpected_profile_tool' and isinstance(agent.get('unexpected_tool_names'),list):
            result['unexpected_tool_names']=[name for name in agent['unexpected_tool_names'][:16] if isinstance(name,str) and TOOL.fullmatch(name)]
        return result
    text=render_reply_citations(agent.get('text') or '')
    # Nothing to say is the brain's choice, not a failure; a blank reply cannot be sent either.
    if not text.strip():return {'state':'suppressed','error_code':'intentional_silence'}
    # A cancel that arrives while the answer is written still withdraws it, as the gateway never sends it.
    if cancelled.is_set():return {'state':'cancelled'}
    return {'state':'done','reply':{'text':text,'session_id':agent['session_id']}}


class BrainTurns:
    def __init__(self,root,spool,policy,model,credentials,turn=native_turn,capacity=TURN_CAPACITY):
        self.root,self.scopes,self.model,self.credentials,self.turn,self.size=Path(root),policy,model,credentials,turn,capacity
        # Not spool/async-runs: the same Telegram attempt has the same run id on both runners.
        self.directory=Path(spool)/'brain-turns'
        self.runs=AsyncRuns(self.directory,self._execute,self._saved)
        self.loop=self.thread=self.capacity=None;self.lanes={}

    def open(self):
        # One loop for every turn, so lanes and capacity are plain asyncio locks.
        loop=asyncio.new_event_loop();running=threading.Event();loop.call_soon(running.set)
        self.capacity=asyncio.Semaphore(self.size)
        self.thread=threading.Thread(target=loop.run_forever,name='nocheh-brain',daemon=True);self.thread.start()
        running.wait(5);self.loop=loop

    def ready(self):
        loop=self.loop
        return loop is not None and loop.is_running()

    def stop(self,wait=30):
        if self.loop is None:return
        # A shutdown is not a cancel: Nocheh reads cancelled as final and never retries it.
        # Turns get the deadline to finish, as the gateway leaves its turns uncancelled.
        deadline=time.monotonic()+wait
        while self.runs.active and time.monotonic()<deadline:time.sleep(.1)
        loop,self.loop=self.loop,None
        loop.call_soon_threadsafe(loop.stop);self.thread.join(5)
        # A turn still running past the deadline stays open; a restart reconciles it.
        if not self.thread.is_alive() and not asyncio.all_tasks(loop):loop.close()

    @staticmethod
    def _channel(body):
        if body.get('channel','telegram')!='telegram':raise ValueError('runtime_channel_unavailable')

    def _admit(self,body):
        # Refused before anything is written, so a malformed turn is a 400 and never an uncertain run.
        self._channel(body)
        if body.get('control_reply') is not None:raise ValueError('control_reply_unavailable')
        continuation_id(body)
        # No bot id is compared: Hermes holds no bot token, and the signed pass binds the event to its source key.
        key=body.get('source_key');payload=body.get('payload') if isinstance(body.get('payload'),dict) else {}
        source=SOURCE.fullmatch(key) if isinstance(key,str) else None
        if (not source or body.get('event_id')!=digest(key) or type(payload.get('update_id')) is not int
                or source.group(2)!=str(payload['update_id'])):
            raise ValueError('invalid_dispatch_identity')

    def _answer(self,state):
        # A closed run's reply and tool names come from its outcome; the receipt on disk never holds them.
        if state.get('state') not in CLOSED:return state
        path=self.directory/(state['run_id']+'.outcome')
        if not path.exists():return state
        saved=json.loads(path.read_bytes())
        if saved.get('state')!=state['state']:return state
        return {**state,**{key:saved[key] for key in ('reply','unexpected_tool_names') if key in saved}}

    def start(self,body):
        self._admit(body)
        if not self.ready():raise RuntimeError('brain_not_ready')
        return self._answer(self.runs.start(body))

    def resume(self,body):
        self._channel(body)
        if body.get('observe_only') is not True and not self.ready():raise RuntimeError('brain_not_ready')
        return self._answer(self.runs.resume(body))

    def cancel(self,body):
        self._channel(body)
        return self._answer(self.runs.cancel(body))

    def events(self,body):
        self._channel(body)
        return self.runs.events(body)

    def _saved(self,body):
        path=self.directory/(identity(body)+'.outcome')
        return json.loads(path.read_bytes()) if path.exists() else None

    def _execute(self,body,progress,cancelled):
        loop=self.loop
        if loop is None or not loop.is_running():raise RuntimeError('brain_not_ready')
        result=asyncio.run_coroutine_threadsafe(self._turn(body,progress,cancelled),loop).result()
        # Kept before the receipt closes the run, so a restart in between still finds the reply.
        immutable_file(self.directory,identity(body)+'.outcome',canonical(result))
        return result

    async def _turn(self,body,progress,cancelled):
        # Group addressing and the delivery check are Nocheh's; the turn itself rechecks its space policy.
        scope=self.scopes.resolve(body['payload'],body['scope'])
        if scope is None:return {'state':'suppressed'}
        claims=verify_capability(body['archive_credential'],secret('SERVICE_TOKEN'),scope,body['event_id'])
        # A private answer runs as the owner's private chat but never as the owner: its own scoped profile, the project's
        # role and read tools only (ADR-0248). Its pass and its framed question must come together.
        answer=claims.get('answer') is not None
        if answer!=isinstance(body.get('private_answer'),dict):raise ValueError('invalid_private_answer')
        if answer:scope=replace(scope,owner=False)
        scope=Scopes.apply_revision(scope,claims)
        # Turns in one conversation keep their arrival order; different chats
        # and topics run side by side, up to the capacity. Lane before capacity, always.
        key=scope.space or scope.chat_id
        lane=self.lanes.setdefault(key,{'lock':asyncio.Lock(),'users':0});lane['users']+=1
        try:
            async with lane['lock']:
                async with self.capacity:
                    if cancelled.is_set():return {'state':'cancelled'}
                    return await self._run(scope,body,progress,cancelled)
        finally:
            lane['users']-=1
            if not lane['users'] and self.lanes.get(key) is lane:del self.lanes[key]

    async def _run(self,scope,body,progress,cancelled):
        agent=None
        try:
            progress('assistant')
            agent=await self.turn(self.root,scope,body,self.model,await asyncio.to_thread(self.credentials),cancelled=cancelled)
            result=outcome(agent,cancelled)
        except Exception as error:
            result={'state':'failed','error_code':'provider_not_configured' if isinstance(error,ProviderNotConfigured) else 'assistant_runtime_unavailable'}
            if result['error_code']=='assistant_runtime_unavailable':
                # The bounded Python type and function, never exception text, so the cause can be diagnosed.
                frames=traceback.extract_tb(error.__traceback__)
                for key,value in (('error_type',type(error).__name__),('error_stage',frames[-1].name if frames else None)):
                    if isinstance(value,str) and BOUNDED.fullmatch(value):result[key]=value
        timings=safe(agent.get('timings') if isinstance(agent,dict) else None)
        if timings:result['timings']=timings
        return result
