"""Native Telegram adapter supervised by committed archive dispatch receipts."""

from services.hermes.environment import parallel, secret as environment_secret
import asyncio
import contextvars
import hashlib
import json
import os
import re
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from .capture import Capture, DISPATCH_KEY, OUTBOUND_CHECK, canonical, digest, immutable_file, captured_adapter_class
from .scopes import Scopes, topic_id, verify_capability
from . import group_trigger

TURN = contextvars.ContextVar('nocheh_committed_turn',default=None)
# Parallel Telegram turns across chats, set by the owner. Each isolated turn takes
# one of the security launcher's NOCHEH_PARALLEL_RUNS slots, which reviews,
# browser and scheduled runs share.
TURN_CAPACITY = parallel('NOCHEH_PARALLEL_REPLIES', 3)
# A native send can fail without any request, e.g. while polling reconnects.
# Nothing reached Telegram, so the dispatcher may retry with a fresh attempt.
NOT_TRANSMITTED = {'state':'failed','error_code':'assistant_runtime_unavailable','error_stage':'telegram_send_not_transmitted'}
SOURCE_CITATION = re.compile(r'\s*【nocheh:event:[a-f0-9]{64}】')
SOURCE_ID = re.compile(r'nocheh:event:[a-f0-9]{64}')
# Telegram shows "typing…" for about five seconds per chat action, so a working
# turn renews it a little sooner.
TYPING_INTERVAL = 4.0
# The reactions Hermes's own Telegram adapter sets on the message a turn
# answers: 👀 while it works, then 👍 when answered or 👎 when it failed.
WORKING_REACTIONS = frozenset(('\U0001f440', '\U0001f44d', '\U0001f44e'))


def owner_switch(name):
    """An on/off owner setting, on by default; a malformed value stops startup rather than guessing."""
    value = os.environ.get(name, '').strip() or 'true'
    if value not in ('true', 'false'): raise ValueError('Invalid ' + name)
    return value == 'true'


def typing_enabled():
    return owner_switch('TELEGRAM_TYPING')


def reactions_enabled():
    return owner_switch('TELEGRAM_REACTIONS')


def render_reply_citations(text):
    """Keep internal archive identifiers out of Telegram-visible prose."""
    return SOURCE_ID.sub('the Archive', SOURCE_CITATION.sub('', text))


def outbound_check(chat_id, space, authorized, cancelled=None, requests=None):
    """Bind every physical send to the authorized conversation, including retries.

    ``requests`` records each message request admitted for transmission, so a
    failed delivery with none admitted is known not to have reached Telegram.
    """
    topic = int(space.split('/topic/', 1)[1]) if '/topic/' in space else None

    def check(method, parameters):
        if (method not in ('sendMessage', 'sendRichMessage', 'sendChatAction') or
                str(parameters.get('chat_id')) != str(chat_id) or
                parameters.get('message_thread_id') not in ((None, 1) if topic == 1 else (topic,)) or
                parameters.get('direct_messages_topic_id') is not None or
                parameters.get('ephemeral_message_parameters') is not None):
            raise RuntimeError('telegram_delivery_audience_changed')
        if cancelled is not None and cancelled.is_set():
            raise RuntimeError('telegram_delivery_cancelled')
        if not authorized():
            raise RuntimeError('telegram_delivery_authority_revoked')
        if requests is not None and method != 'sendChatAction':
            requests.append({'method': method, 'state': None, 'status': None})

    def observe(method, state, status):
        # Record the journal's outcome for the most recent admitted request.
        for entry in reversed(requests or []):
            if entry['method'] == method and entry['state'] is None:
                entry.update(state=state, status=status)
                break
    check.observe = observe
    return check


def reaction_check(chat_id, message_id, authorized):
    """Bind a working reaction to the one message this turn answers.

    Only Hermes's three working reactions, or clearing them, pass. A cancelled
    turn may still clear its 👀, so cancellation does not refuse it; a revoked
    space does.
    """
    def check(method, parameters):
        reaction = parameters.get('reaction', [])
        if (method != 'setMessageReaction' or set(parameters) - {'chat_id', 'message_id', 'reaction'} or
                str(parameters.get('chat_id')) != str(chat_id) or str(parameters.get('message_id')) != str(message_id) or
                not isinstance(reaction, list) or len(reaction) > 1 or
                any(not isinstance(item, dict) or set(item) != {'type', 'emoji'} or item['type'] != 'emoji' or
                    item['emoji'] not in WORKING_REACTIONS for item in reaction)):
            raise RuntimeError('telegram_delivery_audience_changed')
        if not authorized():
            raise RuntimeError('telegram_delivery_authority_revoked')
    return check


def working_outcome(turn):
    """How a turn ended, for Hermes's working reaction.

    Intentional silence, cancellation and an uncertain delivery clear the 👀:
    there is no answer to mark, or the reply may have arrived after all.
    """
    from gateway.platforms.base import ProcessingOutcome
    if turn.get('delivery_skipped'):return ProcessingOutcome.CANCELLED
    if turn.get('delivery_success'):return ProcessingOutcome.SUCCESS
    if (turn.get('agent_result') or {}).get('state') == 'cancelled' or (turn.get('cancelled') and turn['cancelled'].is_set()):
        return ProcessingOutcome.CANCELLED
    if turn.get('delivery_started') and delivery_failure(turn.get('send_requests')) is None:
        return ProcessingOutcome.CANCELLED
    return ProcessingOutcome.FAILURE


def delivery_failure(requests):
    """Classify a failed native send from its admitted requests and their outcomes."""
    if requests == []:
        return dict(NOT_TRANSMITTED)
    if requests and all(entry['state'] == 'rejected' for entry in requests):
        # Telegram answered every attempt with a definite error, so nothing was
        # delivered. A rate limit stays retryable; other errors are terminal.
        # The last answer decides: a native fallback after a formatting
        # rejection that is then rate limited still deserves a retry.
        if requests[-1]['status'] == 429:
            return {**NOT_TRANSMITTED, 'error_stage': 'telegram_rate_limited'}
        return {'state': 'suppressed', 'error_code': 'telegram_rejected'}
    return None


CONTINUATION=re.compile(r'[a-f0-9]{64}')
CONTINUATION_ATTEMPT=re.compile(r'c[1-9]\d{0,2}-[a-f0-9]{40}')


def continuation_id(body):
    """The leader action id of a continuation, or None for a message turn. A continuation's attempt names it, so its
    receipt, run and archived result never meet a message turn's; it carries no fixed control reply."""
    attempt,value=body.get('attempt'),body.get('continuation')
    if value is None:
        if type(attempt) is not int or attempt<1:raise ValueError('invalid_dispatch_attempt')
        return None
    if (not isinstance(value,str) or not CONTINUATION.fullmatch(value) or not isinstance(attempt,str)
            or not CONTINUATION_ATTEMPT.fullmatch(attempt) or attempt[-40:]!=value[:40] or body.get('control_reply') is not None):
        raise ValueError('invalid_continuation')
    return value


def adapter_config(token):
    """The native adapter's settings; its own sends and replies carry no link preview."""
    from gateway.config import PlatformConfig
    return PlatformConfig(enabled=True,token=token,typing_indicator=False,gateway_restart_notification=False,extra={'disable_link_previews':True})


def no_preview():
    """Link previews off on every message Nocheh sends or edits itself. Telegram fetches
    an address to preview it, so one placed in a card or reply would be fetched before
    the owner has read it."""
    from telegram import LinkPreviewOptions
    return LinkPreviewOptions(is_disabled=True)


# The formatting an approval card may carry: bold labels, a quote shown whole or one that opens on a tap, such as an
# operation's arguments folded under its summary, and a command as code.
APPROVAL_FORMATS=frozenset({'bold','blockquote','expandable_blockquote','pre'})


def approval_links(links,length):
    """Entities on an approval card's plain text: a group's, topic's or message's t.me address over its name,
    and the formatting of an operation's arguments. Nothing else, and at most Telegram's 100."""
    import re
    if links is None:return None
    from telegram import MessageEntity
    if not isinstance(links,list) or len(links)>100:raise ValueError('invalid_approval')
    entities=[]
    for link in links:
        if not isinstance(link,dict):raise ValueError('invalid_approval')
        offset,size,url,kind=(link.get(key) for key in ('offset','length','url','type'))
        if type(offset) is not int or type(size) is not int or not 0<=offset<offset+size<=length:raise ValueError('invalid_approval')
        if kind is None and isinstance(url,str) and set(link)=={'offset','length','url'} and re.fullmatch(
                r'https://t\.me/(?:c/[1-9]\d{0,15}|[A-Za-z][A-Za-z0-9_]{3,31})(?:/[1-9]\d{0,15}){0,2}',url):
            entities.append(MessageEntity(MessageEntity.TEXT_LINK,offset,size,url=url))
        elif kind in APPROVAL_FORMATS and set(link)=={'offset','length','type'}:
            entities.append(MessageEntity(kind,offset,size))
        else:raise ValueError('invalid_approval')
    # They nest only as Telegram allows: bold inside a quote, such as a label in folded arguments, or around another
    # entity; never a quote in a quote, anything with code, or a partial overlap, which Telegram refuses or reads its own way.
    spans=[(link['offset'],link['offset']+link['length'],link.get('type') or 'text_link') for link in links]
    for index,(start,end,kind) in enumerate(spans):
        for other_start,other_end,other in spans[index+1:]:
            if other_start>=end or start>=other_end:continue
            nested=start<=other_start and other_end<=end or other_start<=start and end<=other_end
            if not nested or 'pre' in (kind,other) or 'bold' not in (kind,other):raise ValueError('invalid_approval')
    return entities or None


def prepare_profile(root,scope,model):
    profile=Path(root)/'profiles'/scope.profile
    profile.mkdir(parents=True,exist_ok=True,mode=0o700)
    from .profile_config import configure_profile
    if (scope.generation or not (profile/'config.yaml').exists()) and (scope.revision or scope.guard_epoch):
        from .profile_config import read, atomic_yaml
        canonical=Path(root)/'profiles'/Scopes.profile(scope.space)
        parent=Path(root)/'profiles'/Scopes.profile(scope.chat_id)
        source=canonical if (canonical/'config.yaml').exists() else parent
        if scope.logical_profile:
            named=Path(root)/'profiles'/scope.logical_profile
            if named.is_symlink():raise ValueError('profile_path_denied')
            if (named/'config.yaml').exists():source=named
        if (source/'config.yaml').exists():atomic_yaml(profile/'config.yaml',read(source/'config.yaml'))
    configure_profile(profile, model)
    from .persona import materialize
    materialize(root, profile, scope.chat_id, scope.project)
    from .native_memory import save_receipt
    save_receipt(profile/'space.json',json.dumps({'space':scope.space or scope.chat_id,'revision':scope.revision,'owner':scope.owner,
        'guard_epoch':scope.guard_epoch,'generation':scope.generation,'purpose':scope.purpose,'logical_profile':scope.logical_profile}))
    plugins=profile/'plugins';plugins.mkdir(exist_ok=True)
    link=plugins/'nocheh';target=Path(__file__).resolve().parent
    if not link.exists():link.symlink_to(target,target_is_directory=True)
    if scope.guard_epoch:
        # A new guard epoch starts a new profile; the chat keeps its conversation
        # and the superseded profiles are removed once idle.
        from .profile_history import carry, prune
        if scope.purpose!='filter':carry(profile)
        prune(profile)
    return profile


async def native_turn(root,scope,body,model,credentials,cancelled=None):
    profile=await asyncio.to_thread(prepare_profile,root,scope,model)
    topic=topic_id(body['payload']['message'])
    thread='main' if topic is None else str(topic)
    logical=digest(scope.chat_id+':'+thread)
    cursor=profile/('active-'+logical+'.json')
    session_id=json.loads(cursor.read_text())['session_id'] if cursor.exists() else 'nocheh-'+logical
    from .turn_process import run_process
    result = await run_process(root, scope, body, model, credentials, session_id,cancelled=cancelled,prepared_profile=profile)
    if result.get('state')=='done':
        def save_cursor():
            temporary=cursor.with_suffix('.tmp')
            with temporary.open('wb') as file:
                file.write(canonical({'session_id':result['session_id']}));file.flush();os.fsync(file.fileno())
            temporary.replace(cursor)
            directory=os.open(profile,os.O_RDONLY)
            try:os.fsync(directory)
            finally:os.close(directory)
        await asyncio.to_thread(save_cursor)
    return result


def committed_adapter_class():
    class CommittedAdapter(captured_adapter_class()):
        # This adapter is the one that connects. Of the native housekeeping it
        # keeps only the menu, which it clears; no status or DM topics.
        # Native typing stays off: it would re-arm after the final reply. A
        # committed turn shows its own, see _turn_typing.
        turn_typing=False
        # Hermes's own working reactions, run around a committed turn; see _turn_reaction.
        turn_reactions=False
        def _reactions_enabled(self):return self.turn_reactions
        async def _run_post_connect_housekeeping(self):await self._register_command_menu()
        async def _ensure_forum_commands(self,msg):pass
        def _is_user_authorized_from_message(self,msg):return TURN.get() is not None
        def _should_process_message(self,msg,**kwargs):return TURN.get() is not None
        def _claim_tasks(self,field,enqueue):
            # Native batching flushes later in its own task. Record the tasks
            # this turn created so its dispatch waits for them and only them;
            # enqueueing is synchronous, so no other turn can interleave.
            before={id(task) for task in getattr(self,field,{}).values()}
            enqueue()
            turn=TURN.get()
            if turn is not None:turn['tasks'].update(task for task in getattr(self,field,{}).values() if id(task) not in before)
        def _enqueue_text_event(self,event):
            self._claim_tasks('_pending_text_batch_tasks',lambda:super(CommittedAdapter,self)._enqueue_text_event(event))
        def _enqueue_photo_event(self,batch_key,event):
            self._claim_tasks('_pending_photo_batch_tasks',lambda:super(CommittedAdapter,self)._enqueue_photo_event(batch_key,event))
        def _register_handlers(self,app):
            from telegram import Update
            from telegram.ext import TypeHandler, ApplicationHandlerStop, MessageHandler, filters
            super()._register_handlers(app)
            async def command_as_text(update,context):
                msg=update.effective_message
                if msg and msg.text and msg.text.startswith('/'):
                    await self._handle_text_message(update,context)
                    raise ApplicationHandlerStop
            # Native administrative command/callback menus are not an
            # authority boundary for a shared group. Commands are data.
            app.add_handler(TypeHandler(Update,command_as_text),group=-90)
            # The pinned native handler's media filter omits round video notes.
            app.add_handler(MessageHandler(filters.VIDEO_NOTE,self._handle_media_message))
        async def _handle_media_message(self,update,context):
            if TURN.get() is None:raise RuntimeError('uncommitted_media')
            msg=update.effective_message
            if msg is None:return
            from gateway.platforms.base import MessageType
            kind=MessageType.VIDEO if msg.video_note else self._media_message_type(msg)
            event=self._build_message_event(msg,kind,update_id=update.update_id)
            event.text=msg.caption or ''
            # Original bytes and transcripts are already committed by Nocheh.
            # Native media preprocessing would re-download files and can invoke
            # a global sticker vision/cache path outside this conversation.
            await self.handle_message(event)
        async def _turn_typing(self,event,turn):
            """Show "typing…" in this turn's chat or topic until its reply is ready.

            Each chat action passes the same audience and authority check as the
            reply, so it never reaches another chat, topic or a revoked space.
            """
            from gateway.platforms.base import _thread_metadata_for_event
            scope=turn['scope'];cancelled=turn.get('cancelled')
            check=OUTBOUND_CHECK.set(outbound_check(scope.chat_id,scope.space,
                lambda:check_delivery_policy(turn['body']['archive_credential']),cancelled))
            try:
                while not (cancelled and cancelled.is_set()):
                    try:await asyncio.wait_for(self.send_typing(event.source.chat_id,metadata=_thread_metadata_for_event(event)),TYPING_INTERVAL)
                    except Exception:pass # A missed status is cosmetic; the next tick tries again.
                    await asyncio.sleep(TYPING_INTERVAL)
            finally:OUTBOUND_CHECK.reset(check)
        async def _turn_reaction(self,event,turn,hook,*outcome):
            """Run Hermes's own working-reaction hook on the message this turn answers.

            Its request passes a check bound to that exact message and the
            space's current permission. A missed reaction is cosmetic: the
            native hook logs it and the turn goes on.
            """
            scope=turn['scope']
            check=OUTBOUND_CHECK.set(reaction_check(scope.chat_id,event.message_id,
                lambda:check_delivery_policy(turn['body']['archive_credential'])))
            try:await self._run_processing_hook(hook,event,*outcome)
            finally:OUTBOUND_CHECK.reset(check)
        async def handle_message(self,event):
            turn=TURN.get()
            if turn is None:raise RuntimeError('uncommitted_message')
            # A fixed control reply needs no model, so there is no work to show.
            if not self.turn_reactions or turn['body'].get('control_reply') is not None:return await self._answer(event,turn)
            await self._turn_reaction(event,turn,'on_processing_start')
            try:return await self._answer(event,turn)
            finally:await self._turn_reaction(event,turn,'on_processing_complete',working_outcome(turn))
        async def _answer(self,event,turn):
            # A fixed control reply needs no model, so there is nothing to wait for.
            typing=asyncio.create_task(self._turn_typing(event,turn)) if self.turn_typing and turn['body'].get('control_reply') is None else None
            try:response=await self._message_handler(event)
            finally:
                # Stop before delivery: a status sent after the reply would show again.
                if typing:typing.cancel();await asyncio.wait([typing])
            # A failed assistant turn is not intentional silence. Keep the
            # pre-delivery failure visible to the dispatcher so it can retry
            # under a fresh attempt identity without sending anything here.
            if turn.get('agent_result',{}).get('state') not in (None,'done'):return
            if not response:turn['delivery_success']=True;turn['delivery_skipped']=True;return
            if turn.get('cancelled') and turn['cancelled'].is_set():
                turn['agent_result']={'state':'cancelled'};return
            if not await asyncio.to_thread(check_delivery_policy,turn['body']['archive_credential']):
                turn['agent_result']={'state':'failed','error_code':'space_policy_changed'}
                return
            from gateway.platforms.base import _mark_notify_metadata,_thread_metadata_for_event
            if turn.get('progress'):turn['progress']('delivery')
            # Use native Telegram formatting/splitting and the durable
            # outbound journal, without implicit MEDIA/file/TTS delivery.
            turn['delivery_started']=True
            turn['send_requests']=[]
            scope=turn['scope']
            check=OUTBOUND_CHECK.set(outbound_check(scope.chat_id,scope.space,
                lambda:check_delivery_policy(turn['body']['archive_credential']),turn.get('cancelled'),turn['send_requests']))
            from time import perf_counter
            sending=perf_counter()
            try:
                # A follow-up arrives when nobody watches the typing, so it alerts as Hermes's own final replies do (session_ingress.deliver_response).
                metadata=_thread_metadata_for_event(event)
                if turn['body'].get('continuation'):metadata=_mark_notify_metadata(metadata)
                delivered=await self.send(event.source.chat_id,response,reply_to=event.message_id,metadata=metadata)
            finally:
                OUTBOUND_CHECK.reset(check)
                # A failed or uncertain send still waited on Telegram for this long.
                turn['telegram_send_ms']=turn.get('telegram_send_ms',0)+max(0,round((perf_counter()-sending)*1000))
                turn['telegram_sends']=turn.get('telegram_sends',0)+1
            turn['delivery_success']=bool(delivered.success)
    return CommittedAdapter


class AssistantGateway:
    def __init__(self,root,spool,policy,token,model,credentials,on_failure=None):
        self.root,self.spool,self.scopes,self.token,self.model,self.credentials=Path(root),Path(spool),policy,token,model,credentials
        self.status='disabled' if not policy.enabled else 'starting'
        self.loop=None;self.adapter=None;self.lanes={};self.capacity=None;self.action_lock=None
        self.on_failure=on_failure
        self.group_replies,self.group_names=group_trigger.reply_mode(),group_trigger.names()
        self.stopping=False
        self.failure_reported=False
        self.receipts=self.spool/'dispatch';self.receipts.mkdir(parents=True,exist_ok=True)
        for intent in self.receipts.glob('*.intent'):
            result=intent.with_suffix('.result')
            if not result.exists():immutable_file(self.receipts,result.name,canonical({'state':'ambiguous','error_code':'runtime_restart_during_dispatch'}))
        from .async_runs import AsyncRuns
        self.runs=AsyncRuns(self.spool/'async-runs',self._execute_run,self._reconcile_run)

    def _execute_run(self,body,progress,cancelled):
        if self.loop is None:raise RuntimeError('telegram_not_ready')
        return asyncio.run_coroutine_threadsafe(self.dispatch(body,progress,cancelled),self.loop).result()

    def _reconcile_run(self,body):
        name=digest(body['event_id']+':'+str(body['attempt']))
        result=self.receipts/(name+'.result')
        return json.loads(result.read_bytes()) if result.exists() else None

    def start(self):
        if not self.scopes.enabled:return
        if not self.token:self.status='credentials_missing';return
        threading.Thread(target=self._serve,name='nocheh-telegram',daemon=True).start()

    def health(self):
        adapter=self.adapter
        polling=dict(getattr(getattr(adapter,'capture',None),'polling',{}))
        state=self.status
        code=polling.get('error_code')
        if adapter and getattr(adapter,'has_fatal_error',False):
            state='failed'
            # Upstream messages may contain URLs or credentials; only allow codes.
            native=getattr(adapter,'fatal_error_code',None)
            code=native if native in ('telegram_network_error','telegram_polling_conflict','invalid_token','missing_credentials','telegram-bot-token_lock') else 'telegram_adapter_failed'
        elif state=='connected':
            last=polling.get('last_poll_at')
            age=(datetime.now(timezone.utc)-datetime.fromisoformat(last)).total_seconds() if last else None
            updater=getattr(getattr(adapter,'_app',None),'updater',None)
            if not updater or not updater.running or getattr(adapter,'send_path_degraded',False) or age is None or age>120:
                state='recovering'
        return {**polling,'state':state,'error_code':code}

    def failed(self):
        if self.stopping or self.failure_reported:return
        self.failure_reported=True
        info=self.health()
        self.status='failed'
        # Persist a content-free incident across the supervised process restart.
        path=self.root/'telegram-incident.json';temporary=path.with_suffix('.tmp')
        try:
            temporary.write_bytes(canonical({**info,'state':'failed','recorded_at':datetime.now(timezone.utc).isoformat()}))
            temporary.chmod(0o600);temporary.replace(path)
        except OSError:pass # Failed diagnostics must not prevent recovery.
        if self.on_failure and (not self.adapter or getattr(self.adapter,'fatal_error_retryable',True)):
            self.on_failure()

    async def supervise(self):
        while not self.stopping:
            if self.adapter.has_fatal_error:
                self.failed()
                return
            await asyncio.sleep(1)

    def _serve(self):
        async def run():
            self.loop=asyncio.get_running_loop();self.capacity=asyncio.Semaphore(TURN_CAPACITY);self.action_lock=asyncio.Lock()
            self.adapter=committed_adapter_class()(adapter_config(self.token))
            self.adapter.turn_typing,self.adapter.turn_reactions=typing_enabled(),reactions_enabled()
            async def message(event):
                turn=TURN.get()
                if turn is None:raise RuntimeError('uncommitted_turn')
                result={'state':'done','text':turn['body']['control_reply'],'session_id':'owner-control'} if turn['body'].get('control_reply') is not None else await native_turn(self.root,turn['scope'],turn['body'],self.model,await asyncio.to_thread(self.credentials),cancelled=turn.get('cancelled'))
                turn['agent_result']=result
                if result['state']=='cancelled':return None
                if result['state']!='done':return None
                result['text']=render_reply_citations(result['text'])
                await asyncio.to_thread(self.adapter.capture.enqueue,self.adapter.capture.event('assistant:'+turn['body']['event_id']+':'+str(turn['body']['attempt']),
                    'assistant_result',{'event_id':turn['body']['event_id'],'session_id':result['session_id']},turn['scope'].chat_id,result['text']))
                return result['text']
            self.adapter.set_message_handler(message)
            self.status='connected' if await self.adapter.connect() else 'connection_failed'
            if self.status=='connection_failed':self.failed();return
            await self.supervise()
        try:asyncio.run(run())
        except Exception:
            self.status='runtime_failed'
            self.failed()

    async def dispatch(self,body,progress=None,cancelled=None):
        if self.status!='connected' or not self.adapter:raise RuntimeError('telegram_not_connected')
        continuation=continuation_id(body)
        scope=self.scopes.resolve(body['payload'],body['scope'])
        if scope is None:return {'state':'suppressed'}
        claims=verify_capability(body['archive_credential'],environment_secret('SERVICE_TOKEN'),scope,body['event_id'])
        scope=Scopes.apply_revision(scope,claims)
        if body['event_id']!=digest(body['source_key']) or body['source_key']!=f"telegram:{self.token.split(':',1)[0]}:update:{body['payload']['update_id']}":raise ValueError('invalid_dispatch_identity')
        # A group message nobody addressed to the bot stays archived without a turn.
        # The asking turn was already admitted; its follow-up answers it.
        if not scope.owner and continuation is None and not self.group_turn(body):return {'state':'suppressed','error_code':'not_addressed'}
        name=digest(body['event_id']+':'+str(body['attempt']))
        # Turns in one conversation keep their arrival order; different chats
        # and different topics of one group run side by side, up to
        # TURN_CAPACITY at once. Lane before capacity, always.
        key=scope.space or scope.chat_id
        lane=self.lanes.setdefault(key,{'lock':asyncio.Lock(),'users':0});lane['users']+=1
        try:
            async with lane['lock']:
                receipt=self.receipts/(name+'.result')
                if receipt.exists():return json.loads(receipt.read_bytes())
                async with self.capacity:
                    if cancelled and cancelled.is_set():
                        result={'state':'cancelled'};await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical(result));return result
                    return await (self._run_turn if continuation is None else self._run_continuation)(scope,body,name,progress,cancelled)
        finally:
            lane['users']-=1
            if not lane['users'] and self.lanes.get(key) is lane:del self.lanes[key]

    def group_turn(self,body,addressed_only=False):
        if self.group_replies=='all' and not addressed_only:return True
        # Native connect loads the bot's own identity; its display name addresses it too.
        try:username,first=self.adapter._bot.username,self.adapter._bot.first_name
        except Exception:username=first=None # An unloaded identity still honors replies and set names.
        return group_trigger.addressed(body.get('group_addressing'),body.get('text'),username,
                                       self.group_names+([first] if isinstance(first,str) else []))

    async def _run_turn(self,scope,body,name,progress,cancelled):
        from telegram import Update
        from telegram.ext import Application
        # Native replay admission already claimed this update when polling
        # met the committed-only gate, and it would drop the committed turn
        # as a redelivery. Dispatch receipts own exactly-once turns, so the
        # committed update enters PTB's dispatch beneath that admission.
        return await self._run(scope,body,name,progress,cancelled,body['source_key'],
            lambda:Application.process_update(self.adapter._app,Update.de_json(body['payload'],self.adapter._bot)))

    async def _run_continuation(self,scope,body,name,progress,cancelled):
        # Hermes resumes a session the same way: an internal event into handle_message (hermes:gateway/wake.py:96-104).
        # Not replayed through PTB, so committed_only, media downloads and album batching never see it; its sends get their own journal key.
        return await self._run(scope,body,name,progress,cancelled,body['source_key']+':continuation:'+body['continuation'],
            lambda:self._continue(body))

    async def _continue(self,body):
        from telegram import Message
        from gateway.platforms.base import MessageType
        event=self.adapter._build_message_event(Message.de_json(body['payload']['message'],self.adapter._bot),MessageType.TEXT,
                                                update_id=body['payload']['update_id'])
        # Synthetic and never a gateway command; the reply still anchors on the asking message (_answer passes reply_to).
        event.internal=True;event.allow_gateway_control=False
        await self.adapter.handle_message(event)

    async def _run(self,scope,body,name,progress,cancelled,key,enter):
        await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'event_id':body['event_id'],'attempt':body['attempt']}))
        turn={'scope':scope,'body':body,'progress':progress,'cancelled':cancelled,'tasks':set()};token=TURN.set(turn);dispatch=DISPATCH_KEY.set(key)
        try:
            if progress:progress('assistant')
            await enter()
            # Native text/album batching uses delayed tasks. Keep the durable
            # dispatch open until those tasks and their native delivery finish.
            for _ in range(4):
                tasks={t for t in turn['tasks'] if not t.done()}
                if not tasks:break
                await asyncio.gather(*tasks)
            agent=turn.get('agent_result')
            if not agent:result={'state':'suppressed','error_code':'unsupported_message'}
            elif agent['state']=='cancelled':result={'state':'cancelled'}
            elif agent['state']!='done':
                result={'state':'failed','error_code':agent.get('error_code','model_unavailable')}
                if result['error_code']=='assistant_runtime_unavailable':
                    # The child emits only Python type/function identifiers.
                    # Preserve those bounded identifiers, never exception text,
                    # so a failed turn can be diagnosed from its receipt.
                    for key in ('error_type','error_stage'):
                        value=agent.get(key)
                        if isinstance(value,str) and re.fullmatch(r'[A-Za-z_]{1,64}',value):
                            result[key]=value
                if result['error_code']=='unexpected_profile_tool':
                    names=agent.get('unexpected_tool_names')
                    if isinstance(names,list):
                        result['unexpected_tool_names']=[name for name in names[:16]
                            if isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9_]{1,64}',name)]
            elif turn.get('delivery_skipped'):result={'state':'suppressed','error_code':'intentional_silence'}
            elif turn.get('delivery_success'):result={'state':'done'}
            elif (failure:=delivery_failure(turn.get('send_requests'))) is not None:
                result={'state':'cancelled'} if failure['state']=='failed' and cancelled and cancelled.is_set() else failure
            else:result={'state':'ambiguous','error_code':'delivery_unconfirmed'}
        except Exception as error:
            import traceback
            from .subscription import ProviderNotConfigured
            # Before native delivery starts, another attempt cannot
            # duplicate a Telegram effect. Once sending has started, only
            # reconciliation is safe because the remote outcome is unknown,
            # unless the outbound boundary admitted no message request.
            failure=delivery_failure(turn.get('send_requests')) if turn.get('delivery_started') else None
            result=failure if failure is not None else {'state':'ambiguous','error_code':'dispatch_interrupted'} if turn.get('delivery_started') else \
                {'state':'failed','error_code':'provider_not_configured' if isinstance(error,ProviderNotConfigured) else 'assistant_runtime_unavailable'}
            # The bounded Python type and function, never exception text, so the cause can be diagnosed.
            if result.get('error_code') in ('assistant_runtime_unavailable','dispatch_interrupted') and 'error_type' not in result:
                frames=traceback.extract_tb(error.__traceback__)
                for key,value in (('error_type',type(error).__name__),('error_stage',frames[-1].name if frames else None)):
                    if isinstance(value,str) and re.fullmatch(r'[A-Za-z_]{1,64}',value) and key not in result:result[key]=value
        finally:TURN.reset(token);DISPATCH_KEY.reset(dispatch)
        from .timing import safe
        timings=safe((turn.get('agent_result') or {}).get('timings'))
        if 'telegram_send_ms' in turn:
            timings.update(safe({'telegram_send':{'ms':min(turn['telegram_send_ms'],86400000),'calls':turn['telegram_sends']}}))
        if timings:result['timings']=timings
        await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical(result))
        return result

    def call(self,body):
        if self.loop is None:raise RuntimeError('telegram_not_ready')
        return asyncio.run_coroutine_threadsafe(self.dispatch(body),self.loop).result(timeout=250)

    async def send_action(self,body):
        import re
        destination=re.fullmatch(r'(-?[1-9]\d{0,18})(?:/topic/([1-9]\d{0,15}))?',body['destination'])
        if not re.fullmatch('[a-f0-9]{64}',body['id']) or not destination or not isinstance(body['text'],str) or not 0<len(body['text'].encode('utf-16-le'))//2<=12000:raise ValueError('invalid_action')
        chat_id,topic=destination.groups()
        if topic and int(topic)>9007199254740991:raise ValueError('invalid_action')
        name='action-'+body['id']
        async with self.action_lock:
            receipt=self.receipts/(name+'.result')
            if receipt.exists():return json.loads(receipt.read_bytes())
            if (self.receipts/(name+'.intent')).exists():return {'state':'ambiguous'}
            # No intent exists for this action, so a refusal now proves that no
            # send was attempted. The caller may retry while approval is current.
            if self.status!='connected' or not self.adapter:return {'state':'not_started','error_code':'telegram_not_connected'}
            if os.environ.get('NOCHEH_STORAGE_LAYOUT')=='original-only-v1' and not await asyncio.to_thread(check_action_policy,body):
                result={'state':'denied'}
                await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical(result))
                return result
            await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'action_id':body['id']}))
            token=DISPATCH_KEY.set('action:'+body['id'])
            check=OUTBOUND_CHECK.set(outbound_check(chat_id,body['destination'],
                lambda:os.environ.get('NOCHEH_STORAGE_LAYOUT')!='original-only-v1' or check_action_policy(body)))
            try:
                sent=await self.adapter.send(chat_id,body['text'],metadata={'notify':True,**({'thread_id':topic} if topic else {})})
                result={'state':'done' if sent.success else 'ambiguous'}
            except Exception:result={'state':'ambiguous'}
            finally:OUTBOUND_CHECK.reset(check);DISPATCH_KEY.reset(token)
            await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical(result))
            return result

    def action(self,body):
        if body.get('observe_only') is True:
            import re
            if not re.fullmatch('[a-f0-9]{64}',body.get('id','')):raise ValueError('invalid_action')
            path=self.receipts/('action-'+body['id']+'.result')
            return json.loads(path.read_bytes()) if path.exists() else {'state':'ambiguous' if (self.receipts/('action-'+body['id']+'.intent')).exists() else 'not_found'}
        if self.loop is None:raise RuntimeError('telegram_not_ready')
        return asyncio.run_coroutine_threadsafe(self.send_action(body),self.loop).result(timeout=55)

    def approval(self,body):
        if self.loop is None:raise RuntimeError('telegram_not_ready')
        return asyncio.run_coroutine_threadsafe(self.send_approval(body),self.loop).result(timeout=55)

    async def send_approval(self,body):
        """Approve and Reject buttons on an exact pending action, in the owner's
        private chat or, for a message its requester reviews, in an allowed
        group and topic where it was asked.

        Pressing one is captured like any update; storage verifies who pressed
        it and decides. These calls only show the card and the decision on it.
        """
        import re
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        chat,topic=str(body.get('chat_id','')),str(body.get('topic') or '')
        owner=bool(self.scopes.owner) and chat==str(self.scopes.owner) and re.fullmatch(r'[1-9]\d{0,18}',chat)
        if not owner and chat not in (self.scopes.groups or []) or topic and (owner or not re.fullmatch(r'[1-9]\d{0,15}',topic)):raise ValueError('approval_chat_not_allowed')
        text=body.get('text')
        if not isinstance(text,str) or not 0<len(text.encode('utf-16-le'))//2<=4096:raise ValueError('invalid_approval')
        entities=approval_links(body.get('links'),len(text.encode('utf-16-le'))//2)
        reply=str(body.get('reply_to') or '')
        if reply and not re.fullmatch(r'[1-9]\d{0,15}',reply):raise ValueError('invalid_approval')
        if self.status!='connected' or not self.adapter:return {'state':'not_started','error_code':'telegram_not_connected'}
        bot=self.adapter._bot
        if body.get('kind')=='card':
            if not re.fullmatch('[a-f0-9]{64}',body.get('id','')):raise ValueError('invalid_approval')
            pairs=list(body.get('buttons') or [])
            for pair in pairs:
                if not isinstance(pair,(list,tuple)) or len(pair)!=2:raise ValueError('invalid_approval')
                label,data=pair
                if not isinstance(label,str) or not 0<len(label)<=40 or not isinstance(data,str) or not re.fullmatch(r'n[adcw][a-f0-9]{56}',data):raise ValueError('invalid_approval')
            choices=[data for _,data in pairs]
            # Approve first and Reject last, for one action; an operation may also offer Allow where asked and Always allow (ADR-0214).
            if (not 2<=len(choices)<=4 or choices[0][1]!='a' or choices[-1][1]!='d'
                    or len({data[1] for data in choices})!=len(choices) or len({data[2:] for data in choices})!=1):raise ValueError('invalid_approval')
            buttons=[InlineKeyboardButton(label,callback_data=data) for label,data in pairs]
            # Approve and Reject share a row; longer allow buttons get one row each, so every label shows in full.
            rows=[buttons] if len(buttons)==2 else [[button] for button in buttons]
            name='approval-'+body['id']
            async with self.action_lock:
                receipt=self.receipts/(name+'.result')
                if receipt.exists():return json.loads(receipt.read_bytes())
                if (self.receipts/(name+'.intent')).exists():return {'state':'ambiguous'}
                await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'action_id':body['id'],'chat_id':chat}))
                token=DISPATCH_KEY.set('approval:'+body['id'])
                check=OUTBOUND_CHECK.set(outbound_check(chat,chat+('/topic/'+topic if topic else ''),lambda:True))
                try:
                    # In the chat where it was asked, the card is the reply to the request.
                    # Links are entities over plain text, so no default formatting applies.
                    sent=await bot.send_message(int(chat),text,message_thread_id=int(topic) if topic else None,reply_markup=InlineKeyboardMarkup(rows),
                                                entities=entities,parse_mode=None,reply_to_message_id=int(reply) if reply else None,allow_sending_without_reply=True,
                                                link_preview_options=no_preview())
                    result={'state':'done','chat_id':chat,'message_id':str(sent.message_id)}
                except Exception:result={'state':'ambiguous'}
                finally:OUTBOUND_CHECK.reset(check);DISPATCH_KEY.reset(token)
                await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical(result))
                return result
        if body.get('kind')=='settle':
            if not re.fullmatch('[a-f0-9]{64}',body.get('id','')):raise ValueError('invalid_approval')
            name='approval-'+body['id'];receipt=self.receipts/(name+'.result')
            card=json.loads(receipt.read_bytes()) if receipt.exists() else {}
            seen=str(body.get('message_id') or '')
            if seen and not re.fullmatch(r'[1-9]\d{0,15}',seen):raise ValueError('invalid_approval')
            if card.get('state')!='done':
                # A send whose answer was lost may still have reached the chat. A press on that card names its message
                # (storage passes only a pressed message that carries this card's button), and it is kept at once, so
                # later edits find it even if this edit's own answer is lost. Only a card this runtime tried to send to
                # this chat is edited, and Telegram lets a bot edit only its own messages.
                found=self.receipts/(name+'.seen')
                if found.exists():card=json.loads(found.read_bytes())
                elif seen and (self.receipts/(name+'.intent')).exists() and json.loads((self.receipts/(name+'.intent')).read_bytes()).get('chat_id')==chat:
                    card={'state':'done','chat_id':chat,'message_id':seen}
                    # Best effort: without it a later edit needs another press.
                    try:await asyncio.to_thread(immutable_file,self.receipts,name+'.seen',canonical(card))
                    except Exception:pass
            # Only a card this runtime sent, in the chat it was sent to, is edited.
            # A running background job's card keeps one Stop button; every other decided card loses its buttons.
            stop=body.get('buttons')
            if stop is not None:
                if (not isinstance(stop,list) or len(stop)!=1 or not isinstance(stop[0],(list,tuple)) or len(stop[0])!=2 or not isinstance(stop[0][0],str)
                        or not 0<len(stop[0][0])<=40 or not isinstance(stop[0][1],str) or not re.fullmatch(r'ns[a-f0-9]{56}',stop[0][1])):raise ValueError('invalid_approval')
                stop=InlineKeyboardMarkup([[InlineKeyboardButton(stop[0][0],callback_data=stop[0][1])]])
            if card.get('state')!='done' or card.get('chat_id')!=chat:return {'state':'done','edited':False}
            token=DISPATCH_KEY.set('approval-settle:'+body['id'])
            # The decided card keeps its text with the outcome.
            # Telegram refuses a repeated identical edit, which changes nothing.
            try:return {'state':'done','edited':bool(await bot.edit_message_text(text,chat_id=int(chat),message_id=int(card['message_id']),entities=entities,parse_mode=None,reply_markup=stop,
                                                                             link_preview_options=no_preview()))}
            except Exception:return {'state':'done','edited':False}
            finally:DISPATCH_KEY.reset(token)
        if body.get('kind')=='answer':
            query=body.get('callback_query_id')
            if not isinstance(query,str) or not 0<len(query)<=64 or len(text)>200:raise ValueError('invalid_approval')
            token=DISPATCH_KEY.set('approval-answer:'+query)
            # Stops the button's spinner; an expired or repeated answer is refused and changes nothing.
            try:return {'state':'done','answered':bool(await bot.answer_callback_query(query,text=text))}
            except Exception:return {'state':'done','answered':False}
            finally:DISPATCH_KEY.reset(token)
        raise ValueError('invalid_approval')

    def refusal(self,body):
        if self.loop is None:raise RuntimeError('telegram_not_ready')
        return asyncio.run_coroutine_threadsafe(self.send_refusal(body),self.loop).result(timeout=55)

    async def send_refusal(self,body):
        """The owner's fixed reply to someone not allowed in an allowed group who
        addressed Nocheh, or to anyone but the owner who writes to it privately,
        there at most once a UTC day per person. No model runs and nothing else
        about the chat is sent."""
        import re
        from datetime import datetime, timezone
        chat,user,message,topic=(str(body.get(key) or '') for key in ('chat_id','user_id','message_id','topic'))
        personal=body.get('private') is True
        if (not re.fullmatch('[a-f0-9]{64}',body.get('event_id','')) or (chat!=user or topic if personal else chat not in (self.scopes.groups or [])) or
                not re.fullmatch(r'[1-9]\d{0,18}',user) or not re.fullmatch(r'[1-9]\d{0,18}',message) or topic and not re.fullmatch(r'[1-9]\d{0,15}',topic)):
            raise ValueError('invalid_refusal')
        reply=body.get('reply')
        if not isinstance(reply,str) or not reply.strip() or len(reply)>1000:raise ValueError('invalid_refusal')
        if user==str(self.scopes.owner):return {'state':'skipped'}
        if not personal:
            access=(getattr(self.scopes,'group_access',None) or {}).get(chat,{})
            if user in access.get('granted',[]) and user not in access.get('denied',[]):return {'state':'skipped'}
            if not self.group_turn({'group_addressing':body.get('group_addressing'),'text':body.get('text')},addressed_only=True):return {'state':'skipped'}
        if self.status!='connected' or not self.adapter:return {'state':'not_started','error_code':'telegram_not_connected'}
        # One private reply a day: a stranger who keeps writing can't make the bot keep answering.
        name='refusal-private-'+user+'-'+datetime.now(timezone.utc).strftime('%Y%m%d') if personal else 'refusal-'+body['event_id']
        async with self.action_lock:
            receipt=self.receipts/(name+'.result')
            if receipt.exists():return json.loads(receipt.read_bytes())
            if (self.receipts/(name+'.intent')).exists():return {'state':'ambiguous'}
            await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'event_id':body['event_id']}))
            token=DISPATCH_KEY.set('refusal:'+body['event_id'])
            check=OUTBOUND_CHECK.set(outbound_check(chat,chat+('/topic/'+topic if topic else ''),lambda:True))
            try:
                await self.adapter._bot.send_message(int(chat),reply,message_thread_id=int(topic) if topic else None,
                                                     reply_to_message_id=int(message),allow_sending_without_reply=True,link_preview_options=no_preview())
                result={'state':'done'}
            except Exception:result={'state':'ambiguous'}
            finally:OUTBOUND_CHECK.reset(check);DISPATCH_KEY.reset(token)
            await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical(result))
            return result

    def notice(self,body):
        if self.loop is None:raise RuntimeError('telegram_not_ready')
        return asyncio.run_coroutine_threadsafe(self.send_notice(body),self.loop).result(timeout=55)

    async def send_notice(self,body):
        """A task reminder or a problem notice in the owner's private chat. No model runs;
        the text is the owner's template filled in by storage, sent at most once.
        With edit, a notice this runtime sent is edited in place instead, such as to mark a cleared problem."""
        import re
        chat=str(body.get('chat_id') or '')
        if not re.fullmatch('[a-f0-9]{64}',body.get('id','')) or not self.scopes.owner or chat!=str(self.scopes.owner) or not re.fullmatch(r'[1-9]\d{0,18}',chat):
            raise ValueError('notice_chat_not_allowed')
        text=body.get('text')
        if not isinstance(text,str) or not text.strip() or not 0<len(text.encode('utf-16-le'))//2<=4096:raise ValueError('invalid_notice')
        markup=notice_buttons(body.get('buttons'))
        if body.get('edit') not in (None,True):raise ValueError('invalid_notice')
        if self.status!='connected' or not self.adapter:return {'state':'not_started','error_code':'telegram_not_connected'}
        name='notice-'+body['id']
        if body.get('edit'):return await self.edit_notice(name,chat,text,markup)
        async with self.action_lock:
            receipt=self.receipts/(name+'.result')
            if receipt.exists():return {key:value for key,value in json.loads(receipt.read_bytes()).items() if key!='message_id'}
            if (self.receipts/(name+'.intent')).exists():return {'state':'ambiguous'}
            await asyncio.to_thread(immutable_file,self.receipts,name+'.intent',canonical({'notice_id':body['id']}))
            token=DISPATCH_KEY.set('notice:'+body['id'])
            check=OUTBOUND_CHECK.set(outbound_check(chat,chat,lambda:True))
            try:
                from telegram.error import BadRequest
                try:sent=await self.adapter._bot.send_message(int(chat),text,parse_mode=None,reply_markup=markup,link_preview_options=no_preview())
                except BadRequest:
                    # Telegram refused a button, such as a dashboard address it does not accept;
                    # nothing was sent, so the notice goes without buttons.
                    if markup is None:raise
                    sent=await self.adapter._bot.send_message(int(chat),text,parse_mode=None,link_preview_options=no_preview())
                result={'state':'done'}
            except Exception:result={'state':'ambiguous'}
            finally:OUTBOUND_CHECK.reset(check);DISPATCH_KEY.reset(token)
            # The receipt keeps which message it was, so the notice can be edited later; callers get only the state.
            message=getattr(sent,'message_id',None) if result['state']=='done' else None
            await asyncio.to_thread(immutable_file,self.receipts,name+'.result',canonical({**result,**({'message_id':message} if isinstance(message,int) else {})}))
            return result

    async def edit_notice(self,name,chat,text,markup):
        """Edits a notice this runtime sent to the owner, found by its receipt. Without buttons, the notice loses them.
        Telegram refusing the edit, such as for unchanged text, a message the owner deleted or a bot the owner blocked,
        changes nothing and is not tried again; an edit that could not reach Telegram is. Repeating an edit that went through changes
        nothing, so each attempt gets its own journal entry: one lost in transit never blocks the next."""
        import uuid
        try:sent=json.loads((self.receipts/(name+'.result')).read_bytes())
        except (OSError,ValueError):sent={}
        message=sent.get('message_id') if isinstance(sent,dict) and sent.get('state')=='done' else None
        if not isinstance(message,int):return {'state':'not_found'}
        from telegram.error import BadRequest, Forbidden
        token=DISPATCH_KEY.set('notice-edit:'+name+':'+uuid.uuid4().hex)
        edit=lambda reply_markup:self.adapter._bot.edit_message_text(text,chat_id=int(chat),message_id=message,parse_mode=None,
                                                                     reply_markup=reply_markup,link_preview_options=no_preview())
        try:
            try:return {'state':'done','edited':bool(await edit(markup))}
            except BadRequest as error:
                # A button Telegram does not accept: the notice was sent without buttons, so it is edited without them.
                if markup is None or 'not modified' in str(error).lower():return {'state':'done','edited':False}
                try:return {'state':'done','edited':bool(await edit(None))}
                except BadRequest:return {'state':'done','edited':False}
        except Forbidden:return {'state':'done','edited':False}
        except Exception:return {'state':'not_started','error_code':'telegram_edit_failed'}
        finally:DISPATCH_KEY.reset(token)

    def stop(self):
        self.stopping=True
        if self.loop and self.adapter:
            try:asyncio.run_coroutine_threadsafe(self.adapter.disconnect(),self.loop).result(timeout=20)
            except Exception:pass


def notice_buttons(buttons):
    """One row of buttons under a problem notice: open a page in the mini app or a browser, or
    the Retry failed press that storage handles. Anything else is refused."""
    import re
    if buttons is None:return None
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
    if not isinstance(buttons,list) or not 0<len(buttons)<=3:raise ValueError('invalid_notice')
    row=[]
    for button in buttons:
        label=button.get('text') if isinstance(button,dict) else None
        if not isinstance(label,str) or not 0<len(label)<=40 or len(button)!=2:raise ValueError('invalid_notice')
        web,url,callback=button.get('web_app'),button.get('url'),button.get('callback')
        if isinstance(web,str) and len(web)<=512 and re.fullmatch(r'https://\S+',web):row.append(InlineKeyboardButton(label,web_app=WebAppInfo(web)))
        elif isinstance(url,str) and len(url)<=512 and re.fullmatch(r'https?://\S+',url):row.append(InlineKeyboardButton(label,url=url))
        elif callback=='nr':row.append(InlineKeyboardButton(label,callback_data=callback))
        else:raise ValueError('invalid_notice')
    return InlineKeyboardMarkup([row])


def check_delivery_policy(credential):
    import urllib.request
    try:
        request=urllib.request.Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/v1/memory/check',headers={'Authorization':'Bearer '+credential})
        with urllib.request.urlopen(request,timeout=10) as response:return json.loads(response.read(1024)).get('valid') is True
    except Exception:return False


def check_action_policy(body):
    import urllib.request
    try:
        request=urllib.request.Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/internal/actions/authorize',
            data=canonical({key:body[key] for key in ('id','destination','text')}),
            headers={'Authorization':'Bearer '+environment_secret('SERVICE_TOKEN'),'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=10) as response:return json.loads(response.read(1024)).get('valid') is True
    except Exception:return False
