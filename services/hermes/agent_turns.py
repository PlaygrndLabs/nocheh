"""Telegram turns whose reply goes back to Nocheh, which sends it. Nothing here reaches Telegram.

Receipts stay content-free like every async run. The reply lives only in the run's .outcome file."""
import asyncio
import collections
import contextlib
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
from .scopes import Scopes,check_claims
from .steering import Steering
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
    # Nothing to say is the agent's choice, not a failure; a blank reply cannot be sent either.
    if not text.strip():return {'state':'suppressed','error_code':'intentional_silence'}
    # A cancel that arrives while the answer is written still withdraws it, as the gateway never sends it.
    if cancelled.is_set():return {'state':'cancelled'}
    return {'state':'done','reply':{'text':text,'session_id':agent['session_id']}}


class Arrivals:
    """Launched turns in the order they arrived, one line per lane a turn may join, each turn until it joins its first
    lane or is over. Only the agent's loop touches it: a turn arrives and leaves by a callback the runs' lock puts on the
    loop in order."""
    def __init__(self):self.lines,self.keys,self.ready={},{},{}

    def arrive(self,run,keys):
        self.keys[run]=keys
        for key in keys:self.lines.setdefault(key,{})[run]=None

    def leave(self,run):
        self.ready.pop(run,None)
        for key in self.keys.pop(run,()):
            line=self.lines[key];del line[run]
            if not line:del self.lines[key];continue
            # Only a turn first in its line may go on, so only it is woken; it checks its other lines itself.
            ready=self.ready.get(next(iter(line)))
            if ready is not None and not ready.done():ready.set_result(None)

    def _first(self,run):return all(next(iter(self.lines[key]))==run for key in self.keys[run])

    async def first(self,run):
        """Returns once every turn that arrived before `run` in any of its lines has joined its first lane or is over. A
        turn that never took a place, as when the agent restarted in between, waits for no one."""
        while run in self.keys and not self._first(run):
            ready=self.ready[run]=asyncio.get_running_loop().create_future()
            await ready


class AgentTurns:
    def __init__(self,root,spool,policy,model,credentials,turn=native_turn,capacity=TURN_CAPACITY):
        self.root,self.scopes,self.model,self.credentials,self.turn,self.size=Path(root),policy,model,credentials,turn,capacity
        # Not spool/async-runs: the same Telegram attempt has the same run id on both runners.
        self.directory=Path(spool)/'agent-turns'
        self.runs=AsyncRuns(self.directory,self._execute,self._saved,self._arrived)
        self.loop=self.thread=self.capacity=self.order=None;self.lanes={};self.steering={};self.offers={}

    def open(self):
        # One loop for every turn, so arrival order, lanes and capacity need no thread locks.
        loop=asyncio.new_event_loop();running=threading.Event();loop.call_soon(running.set)
        self.capacity=asyncio.Semaphore(self.size);self.order=Arrivals();self.lanes={};self.steering={};self.offers={}
        self.thread=threading.Thread(target=loop.run_forever,name='nocheh-agent',daemon=True);self.thread.start()
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
        if not self.ready():raise RuntimeError('agent_not_ready')
        return self._answer(self.runs.start(body))

    def resume(self,body):
        self._channel(body)
        if body.get('observe_only') is not True and not self.ready():raise RuntimeError('agent_not_ready')
        return self._answer(self.runs.resume(body))

    def cancel(self,body):
        self._channel(body)
        return self._answer(self.runs.cancel(body))

    def events(self,body):
        self._channel(body)
        return self.runs.events(body)

    @staticmethod
    def _lines(body):
        """The lanes a turn may join, read before its pass is verified: its member's, if its pass carries a lane, and its
        space, which the scope read takes from the request (the Telegram chat if a request names none). Only for order:
        a wrong guess can cost order, never safety, and every place is given up when its turn joins a lane or ends."""
        try:lane=Scopes.claims(body['archive_credential']).get('lane')
        except Exception:lane=None
        space=body.get('space') if isinstance(body.get('space'),str) else str(body.get('scope'))
        return ('lane:'+lane,space) if isinstance(lane,str) else (space,)

    def _arrived(self,run,body):
        """A launched turn takes its place in arrival order, in the lines of the lanes it may join, so a slow turn holds up
        only turns that may share a lane with it. The runs call this under their lock, so in the order turns arrive and
        before the turn's worker thread starts; that thread, and the scope read before the lanes, may then take any time.
        What it returns is called once the run is over, so a turn that never reached its lanes gives its place up."""
        loop,order=self.loop,self.order
        if loop is None:return None
        def post(step,*values):
            # A loop that stopped meanwhile runs no turn either.
            with contextlib.suppress(RuntimeError):loop.call_soon_threadsafe(step,run,*values)
        post(order.arrive,self._lines(body))
        return lambda:post(order.leave)

    def _saved(self,body):
        path=self.directory/(identity(body)+'.outcome')
        return json.loads(path.read_bytes()) if path.exists() else None

    def _execute(self,body,progress,cancelled):
        loop=self.loop
        if loop is None or not loop.is_running():raise RuntimeError('agent_not_ready')
        result=asyncio.run_coroutine_threadsafe(self._turn(body,progress,cancelled),loop).result()
        # Kept before the receipt closes the run, so a restart in between still finds the reply.
        immutable_file(self.directory,identity(body)+'.outcome',canonical(result))
        return result

    async def _turn(self,body,progress,cancelled):
        run,order=identity(body),self.order
        # Whatever ends the turn before its first lane (no scope, a refused pass) lets the next turn go on.
        try:return await self._ordered(body,progress,cancelled,(order,run))
        finally:order.leave(run)

    async def _ordered(self,body,progress,cancelled,arrival):
        # Group addressing and the delivery check are Nocheh's; the turn itself rechecks its space policy. Its chat, space
        # and app binding come from its pass, read here only to know whose turn it is and checked in full next (ADR-0252).
        # Off the event loop: reading the served list may wait on the app (ADR-0252), and other turns keep running meanwhile.
        scope=await asyncio.to_thread(self.scopes.resolve,body,Scopes.claims(body['archive_credential'])) if self.scopes.enabled else None
        if scope is None:return {'state':'suppressed'}
        claims=check_claims(body['archive_credential'],scope,body['event_id'])
        # A private answer runs as the owner's private chat but never as the owner: its own scoped profile, the project's
        # role and read tools only (ADR-0249). Its pass and its framed question must come together.
        answer=claims.get('answer') is not None
        if answer!=isinstance(body.get('private_answer'),dict):raise ValueError('invalid_private_answer')
        # The owner's ask about a member (step 4b) is the same: never the owner, its pass and its ask come together.
        member_read=claims.get('member_read')
        ask=body.get('member_read')
        if (member_read is not None)!=isinstance(ask,dict) or member_read is not None and ask.get('ask')!=member_read:raise ValueError('invalid_member_read')
        if answer or member_read is not None:scope=replace(scope,owner=False)
        scope=Scopes.apply_revision(scope,claims)
        # Turns in one conversation keep their arrival order: each joins its first lane only after every earlier turn that
        # may share a lane with it joined its own (or is over), whatever order their worker threads and scope reads finished
        # in. Different chats and topics run side by side, up to the capacity. A member's turns, in their own private chat and in groups, run
        # one at a time: their pass's lane names them (step 4). The owner's turns, an answer's and an ask's carry none.
        # Always the member's lane first, then the space's, then capacity. A member's group turn that waits for their
        # running private turn therefore holds no group, so the owner's and other members' turns there go on; Nocheh
        # still sends a group's replies in arrival order. One order for every turn, so no two turns wait on each other.
        lane,space=claims.get('lane'),scope.space or scope.chat_id
        # Talk while it works (ADR-0301): a plain message from the same person in the same conversation joins the turn
        # running in its first lane, and the agent answers both in one reply; one the agent did not read runs on its own.
        steer=self._steer(scope,claims,body,answer,member_read)
        async with self._lane('lane:'+lane if lane else space,arrival,steer) as (joined,steering):
            if joined:return {'state':'suppressed','error_code':'joined_turn'}
            async with self._lane(space) if lane else contextlib.nullcontext():
                async with self.capacity:
                    if cancelled.is_set():return {'state':'cancelled'}
                    return await self._run(scope,body,progress,cancelled,steering)

    @staticmethod
    def _steer(scope,claims,body,answer,member_read):
        """Who a turn is, for joining (ADR-0301): its whole checked scope and its lane, so a message joins only a turn of
        the same person in the same conversation with the same rights; and, when it may join one, its ticket and its text
        as the agent reads a message. Only plain Telegram messages take part: never a private answer, an ask about a
        member, an approval's follow-up or a fixed reply. A message with a photo, or one of the questions a turn answers
        with a fixed reply, may still be joined but never joins (the agent reads only the text of a joined message)."""
        if (body.get('channel','telegram')!='telegram' or answer or member_read is not None or body.get('continuation') is not None
                or body.get('control_reply') is not None):return None
        from .assistant_turn import exact_predecessor_question,retired_content_question
        from .turn_process import message_text
        who=(scope,claims.get('lane'))
        if (any(isinstance(file,dict) and file.get('kind')=='image' for file in body.get('files') or [])
                or exact_predecessor_question(body.get('text')) or retired_content_question(body.get('text'))):return (who,None,None)
        try:text=message_text(body,scope)[0]
        except Exception:return (who,None,None)
        return (who,identity(body),text)

    def _join(self,key,line,steer):
        """Offer a turn to the one running under `key` when it is the same person's, and every turn waiting before it
        was offered to that one too, so replies keep arrival order. The Steering it was offered to, or None."""
        who,ticket,text=steer
        running=self.steering.get(key)
        if ticket is None or running is None or running.identity!=who or not line:return None
        if any(self.offers.get(waiting) is not running for waiting in list(line)[1:]):return None
        return running if running.offer(ticket,text) else None

    @contextlib.asynccontextmanager
    async def _lane(self,key,arrival=None,steer=None):
        """One turn at a time under `key`, in the order turns join it; an idle key leaves nothing behind. Space keys are Nocheh
        chat ids and member keys start with `lane:`, so the two never meet. A turn's first lane takes its `arrival`: the turn
        joins once every earlier arrival in its lines has joined its own, and the next may join only after it has, as no
        await separates joining from giving up its place. With `steer`, the turn may join the one running there (its
        message goes to that turn's agent), and yields whether it did, with its own Steering for later turns."""
        if arrival:await arrival[0].first(arrival[1])
        line=self.lanes.setdefault(key,collections.deque())
        turn=asyncio.get_running_loop().create_future()
        offered=self._join(key,line,steer) if steer else None
        if not line:turn.set_result(None)
        line.append(turn);self.offers[turn]=offered
        if arrival:arrival[0].leave(arrival[1])
        steering=None
        try:
            await turn
            joined=offered is not None and steer[1] in offered.joined
            if steer and not joined:steering=self.steering[key]=Steering(steer[0])
            yield joined,steering
        finally:
            self.offers.pop(turn,None)
            if steering is not None:
                # A turn that ended without its result (an error) was joined by nothing.
                if not steering.closed:steering.close()
                if self.steering.get(key) is steering:del self.steering[key]
            first=line[0] is turn;line.remove(turn)
            if not line:
                if self.lanes.get(key) is line:del self.lanes[key]
            elif first and not line[0].done():line[0].set_result(None)

    async def _run(self,scope,body,progress,cancelled,steering=None):
        agent=None
        try:
            progress('assistant')
            extra={'steering':steering} if steering is not None else {}
            agent=await self.turn(self.root,scope,body,self.model,await asyncio.to_thread(self.credentials),cancelled=cancelled,**extra)
            result=outcome(agent,cancelled)
            # The messages the agent read while it worked are answered by this turn's reply, or by its silence; any other
            # end answers none of them, and each runs on its own.
            if steering is not None:steering.close(agent.get('joined',()) if result['state']=='done' or result.get('error_code')=='intentional_silence' else ())
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
