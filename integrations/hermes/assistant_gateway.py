"""Native Telegram adapter supervised by committed archive dispatch receipts."""

from integrations.hermes.environment import secret as environment_secret
import asyncio
import contextvars
import hashlib
import json
import os
import sys
import threading
from pathlib import Path

from .capture import Capture, DISPATCH_KEY, canonical, digest, immutable_file, captured_adapter_class
from .scopes import Scopes, verify_capability

TURN = contextvars.ContextVar('nocheh_committed_turn',default=None)


def prepare_profile(root,scope,model):
    profile=Path(root)/'profiles'/scope.profile
    profile.mkdir(parents=True,exist_ok=True,mode=0o700)
    from .profile_config import configure_profile
    if not (profile/'config.yaml').exists() and scope.revision:
        from .profile_config import read, atomic_yaml
        canonical=Path(root)/'profiles'/Scopes.profile(scope.space)
        parent=Path(root)/'profiles'/Scopes.profile(scope.chat_id)
        source=canonical if (canonical/'config.yaml').exists() else parent
        if (source/'config.yaml').exists():atomic_yaml(profile/'config.yaml',read(source/'config.yaml'))
    configure_profile(profile, model)
    from .native_memory import save_receipt
    save_receipt(profile/'space.json',json.dumps({'space':scope.space or scope.chat_id,'revision':scope.revision,'owner':scope.owner}))
    plugins=profile/'plugins';plugins.mkdir(exist_ok=True)
    link=plugins/'nocheh';target=Path(__file__).resolve().parent
    if not link.exists():link.symlink_to(target,target_is_directory=True)
    return profile


async def native_turn(root,scope,body,model,credentials):
    profile=prepare_profile(root,scope,model)
    thread=str(body['payload']['message'].get('message_thread_id','main'))
    logical=digest(scope.chat_id+':'+thread)
    cursor=profile/('active-'+logical+'.json')
    session_id=json.loads(cursor.read_text())['session_id'] if cursor.exists() else 'nocheh-'+logical
    text=body.get('text') or ''
    if body.get('transcripts'):
        text+='\n\n[Derived voice transcript; original audio is separately archived]\n'+'\n'.join(body['transcripts'])
    if not text:text='[An attachment or non-text event was archived. Use its source reference if useful.]'
    text+='\n\n[Archive source: nocheh:event:'+body['event_id']+']'
    request={'text':text,'model':model,'session_id':session_id,'owner':scope.owner,'chat_id':scope.chat_id,
             'user_id':scope.user_id,'archive_credential':body['archive_credential'],'access_token':credentials.access_token}
    env={key:os.environ[key] for key in ('PATH','HOME','LANG','LC_ALL','PYTHONPATH','LD_LIBRARY_PATH',
         'SERVICE_TOKEN','SERVICE_TOKEN_FILE','ARCHIVE_URL','GUARD_URL','GUARD_MODE','GUARD_TRUSTED_ENDPOINTS') if key in os.environ}
    env.update(HERMES_HOME=str(profile),NOCHEH_CAPTURE_ENABLED='0')
    process=await asyncio.create_subprocess_exec(sys.executable,'-m','integrations.hermes.assistant_turn',
        stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL,env=env,
        cwd=Path(__file__).resolve().parents[2])
    try:
        stdout,_=await asyncio.wait_for(process.communicate(canonical(request)),timeout=220)
        if process.returncode or len(stdout)>2*1024*1024:raise RuntimeError('assistant_process_failed')
        result=json.loads(stdout)
        if result.get('state')=='done':
            temporary=cursor.with_suffix('.tmp')
            with temporary.open('wb') as file:
                file.write(canonical({'session_id':result['session_id']}));file.flush();os.fsync(file.fileno())
            temporary.replace(cursor)
            directory=os.open(profile,os.O_RDONLY)
            try:os.fsync(directory)
            finally:os.close(directory)
        return result
    except BaseException:
        if process.returncode is None:process.kill();await process.wait()
        raise


def committed_adapter_class():
    class CommittedAdapter(captured_adapter_class()):
        async def _run_post_connect_housekeeping(self):pass
        async def _ensure_forum_commands(self,msg):pass
        def _is_user_authorized_from_message(self,msg):return TURN.get() is not None
        def _should_process_message(self,msg,**kwargs):return TURN.get() is not None
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
        async def handle_message(self,event):
            turn=TURN.get()
            if turn is None:raise RuntimeError('uncommitted_message')
            response=await self._message_handler(event)
            if not response:turn['delivery_success']=True;return
            if not await asyncio.to_thread(check_delivery_policy,turn['body']['archive_credential']):
                turn['agent_result']={'state':'failed','error_code':'space_policy_changed'}
                return
            from gateway.platforms.base import _thread_metadata_for_event
            # Use native Telegram formatting/splitting and the durable
            # outbound journal, without implicit MEDIA/file/TTS delivery.
            delivered=await self.send(event.source.chat_id,response,reply_to=event.message_id,metadata=_thread_metadata_for_event(event))
            turn['delivery_success']=bool(delivered.success)
    return CommittedAdapter


class AssistantGateway:
    def __init__(self,root,spool,policy,token,model,credentials):
        self.root,self.spool,self.scopes,self.token,self.model,self.credentials=Path(root),Path(spool),policy,token,model,credentials
        self.status='disabled' if not policy.enabled else 'starting'
        self.loop=None;self.adapter=None;self.lock=None;self.action_lock=None
        self.receipts=self.spool/'dispatch';self.receipts.mkdir(parents=True,exist_ok=True)
        for intent in self.receipts.glob('*.intent'):
            result=intent.with_suffix('.result')
            if not result.exists():immutable_file(self.receipts,result.name,canonical({'state':'ambiguous','error_code':'runtime_restart_during_dispatch'}))

    def start(self):
        if not self.scopes.enabled:return
        if not self.token:self.status='credentials_missing';return
        threading.Thread(target=self._serve,name='nocheh-telegram',daemon=True).start()

    def _serve(self):
        async def run():
            from gateway.config import PlatformConfig
            self.loop=asyncio.get_running_loop();self.lock=asyncio.Lock();self.action_lock=asyncio.Lock()
            config=PlatformConfig(enabled=True,token=self.token,typing_indicator=False,gateway_restart_notification=False)
            self.adapter=committed_adapter_class()(config)
            async def message(event):
                turn=TURN.get()
                if turn is None:raise RuntimeError('uncommitted_turn')
                result={'state':'done','text':turn['body']['control_reply'],'session_id':'owner-control'} if turn['body'].get('control_reply') is not None else await native_turn(self.root,turn['scope'],turn['body'],self.model,await asyncio.to_thread(self.credentials))
                turn['agent_result']=result
                if result['state']!='done':raise RuntimeError('assistant_turn_failed')
                self.adapter.capture.enqueue(self.adapter.capture.event('assistant:'+turn['body']['event_id']+':'+str(turn['body']['attempt']),
                    'assistant_result',{'event_id':turn['body']['event_id'],'session_id':result['session_id']},turn['scope'].chat_id,result['text']))
                return result['text']
            self.adapter.set_message_handler(message)
            self.status='connected' if await self.adapter.connect() else 'connection_failed'
            await asyncio.Event().wait()
        try:asyncio.run(run())
        except Exception:self.status='runtime_failed'

    async def dispatch(self,body):
        from telegram import Update
        if self.status!='connected' or not self.adapter:raise RuntimeError('telegram_not_connected')
        scope=self.scopes.resolve(body['payload'],body['scope'])
        if scope is None:return {'state':'suppressed'}
        claims=verify_capability(body['archive_credential'],environment_secret('SERVICE_TOKEN'),scope,body['event_id'])
        scope=Scopes.apply_revision(scope,claims)
        if body['event_id']!=digest(body['source_key']) or body['source_key']!=f"telegram:{self.token.split(':',1)[0]}:update:{body['payload']['update_id']}":raise ValueError('invalid_dispatch_identity')
        name=digest(body['event_id']+':'+str(body['attempt']))
        async with self.lock:
            receipt=self.receipts/(name+'.result')
            if receipt.exists():return json.loads(receipt.read_bytes())
            immutable_file(self.receipts,name+'.intent',canonical({'event_id':body['event_id'],'attempt':body['attempt']}))
            turn={'scope':scope,'body':body};token=TURN.set(turn);dispatch=DISPATCH_KEY.set(body['source_key'])
            try:
                await self.adapter._app.process_update(Update.de_json(body['payload'],self.adapter._bot))
                # Native text/album batching uses delayed tasks. Keep the durable
                # dispatch open until those tasks and their native delivery finish.
                for _ in range(4):
                    tasks=set()
                    for field in ('_pending_text_batch_tasks','_pending_photo_batch_tasks','_media_group_tasks','_session_tasks'):
                        tasks.update(t for t in getattr(self.adapter,field,{}).values() if isinstance(t,asyncio.Task) and not t.done())
                    if not tasks:break
                    await asyncio.gather(*tasks)
                agent=turn.get('agent_result')
                if not agent:result={'state':'suppressed','error_code':'unsupported_message'}
                elif agent['state']!='done':result={'state':'failed','error_code':agent.get('error_code','model_unavailable')}
                elif turn.get('delivery_success'):result={'state':'done'}
                else:result={'state':'ambiguous','error_code':'delivery_unconfirmed'}
            except Exception:result={'state':'ambiguous','error_code':'dispatch_interrupted'}
            finally:TURN.reset(token);DISPATCH_KEY.reset(dispatch)
            immutable_file(self.receipts,name+'.result',canonical(result))
            return result

    def call(self,body):
        if self.loop is None:raise RuntimeError('telegram_not_ready')
        return asyncio.run_coroutine_threadsafe(self.dispatch(body),self.loop).result(timeout=250)

    async def send_action(self,body):
        import re
        if self.status!='connected' or not self.adapter:raise RuntimeError('telegram_not_connected')
        if not re.fullmatch('[a-f0-9]{64}',body['id']) or not re.fullmatch(r'-?[1-9]\d{0,18}',body['destination']) or not isinstance(body['text'],str) or not 0<len(body['text'])<=3500:raise ValueError('invalid_action')
        name='action-'+body['id']
        async with self.action_lock:
            receipt=self.receipts/(name+'.result')
            if receipt.exists():return json.loads(receipt.read_bytes())
            immutable_file(self.receipts,name+'.intent',canonical({'action_id':body['id']}))
            token=DISPATCH_KEY.set('action:'+body['id'])
            try:
                sent=await self.adapter.send(body['destination'],body['text'],metadata={'notify':True})
                result={'state':'done' if sent.success else 'ambiguous'}
            except Exception:result={'state':'ambiguous'}
            finally:DISPATCH_KEY.reset(token)
            immutable_file(self.receipts,name+'.result',canonical(result))
            return result

    def action(self,body):
        if self.loop is None:raise RuntimeError('telegram_not_ready')
        return asyncio.run_coroutine_threadsafe(self.send_action(body),self.loop).result(timeout=55)

    def stop(self):
        if self.loop and self.adapter:
            try:asyncio.run_coroutine_threadsafe(self.adapter.disconnect(),self.loop).result(timeout=20)
            except Exception:pass


def check_delivery_policy(credential):
    import urllib.request
    try:
        request=urllib.request.Request(os.environ.get('ARCHIVE_URL','http://archive:8780')+'/v1/memory/check',headers={'Authorization':'Bearer '+credential})
        with urllib.request.urlopen(request,timeout=10) as response:return json.loads(response.read(1024)).get('valid') is True
    except Exception:return False
