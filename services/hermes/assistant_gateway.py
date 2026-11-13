"""The brain's side of a Telegram turn: its native profile, the native turn and its session title.

Nocheh decides who a group message addresses and its own Telegram service polls and sends; nothing here reaches Telegram."""

from services.hermes.environment import parallel
import asyncio
import json
import os
import re
from pathlib import Path

from services.durable import canonical, digest
from .scopes import Scopes, topic_id

# Parallel Telegram turns across chats, set by the owner. Each isolated turn takes
# one of the security launcher's NOCHEH_PARALLEL_RUNS slots, which reviews,
# browser and scheduled runs share.
TURN_CAPACITY = parallel('NOCHEH_PARALLEL_REPLIES', 3)
SOURCE_CITATION = re.compile(r'\s*【nocheh:event:[a-f0-9]{64}】')
SOURCE_ID = re.compile(r'nocheh:event:[a-f0-9]{64}')


def render_reply_citations(text):
    """Keep internal archive identifiers out of Telegram-visible prose."""
    return SOURCE_ID.sub('the Archive', SOURCE_CITATION.sub('', text))


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
    from .persona import audience, materialize
    # A private answer runs in the owner's private chat but never loads that chat's own role or skills: it gets the
    # project's, else the groups default (ADR-0248).
    materialize(root, profile, None if scope.answer else scope.chat_id, scope.project, audience(scope))
    from .native_memory import save_receipt
    save_receipt(profile/'space.json',json.dumps({'space':scope.space or scope.chat_id,'revision':scope.revision,'owner':scope.owner,
        'guard_epoch':scope.guard_epoch,'generation':scope.generation,'purpose':scope.purpose,'logical_profile':scope.logical_profile,
        **({'answer':scope.answer} if scope.answer else {})}))
    plugins=profile/'plugins';plugins.mkdir(exist_ok=True)
    link=plugins/'nocheh';target=Path(__file__).resolve().parent
    if not link.exists():link.symlink_to(target,target_is_directory=True)
    if scope.guard_epoch:
        # A new guard epoch starts a new profile; the chat keeps its conversation
        # and the superseded profiles are removed once idle.
        from .profile_history import carry, prune
        # A private answer starts empty: no earlier answer's conversation, from any group, is carried into it (ADR-0248).
        if scope.purpose!='filter' and not scope.answer:carry(profile)
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
        try:await asyncio.to_thread(title_session,profile,result['session_id'],body['payload']['message'],scope.owner,bool(scope.answer))
        except Exception:pass # A missing title is cosmetic; the next turn tries again.
    return result


def session_title(message,owner,answer=False):
    """The chat a Telegram session belongs to, as the dashboard's session list shows it. A private answer's own
    session is named as one, so the owner's private chat keeps its own name (ADR-0248)."""
    if answer:return 'Private answer'
    chat=message.get('chat') if isinstance(message.get('chat'),dict) else {}
    title=chat.get('title') if isinstance(chat.get('title'),str) else ''
    name='Private chat' if owner else title.strip() or 'Telegram group'
    topic=topic_id(message)
    if topic is not None:
        # A message in a forum topic answers the topic's opening message, which carries the topic's name.
        opening=message.get('reply_to_message') if isinstance(message.get('reply_to_message'),dict) else {}
        created=opening.get('forum_topic_created') if isinstance(opening.get('forum_topic_created'),dict) else {}
        label=created.get('name') if isinstance(created.get('name'),str) and created.get('name').strip() else 'topic '+str(topic)
        name+=' › '+label.strip()
    # Hermes allows 100 characters; leave room for its " #2" when another session already has the name.
    return name[:90]


def title_session(profile,session_id,message,owner,answer=False):
    """Name a Telegram session after its chat. It is Hermes's top automatic title: it replaces a first-message
    title and stays once set, and Hermes keeps a title set by hand over it."""
    from hermes_state import SessionDB
    from .isolated_profile import database_path
    title=session_title(message,owner,answer)
    db=SessionDB(database_path(profile))
    try:
        if not db.get_session(session_id) or db.get_session_title_source(session_id) in (SessionDB.TITLE_SOURCE_LLM,SessionDB.TITLE_SOURCE_USER):return
        try:db.set_auto_title(session_id,title,source=SessionDB.TITLE_SOURCE_LLM)
        except ValueError:db.set_auto_title(session_id,db.get_next_title_in_lineage(title),source=SessionDB.TITLE_SOURCE_LLM)
    finally:db.close()


def check_delivery_policy(credential):
    """Whether a turn's pass still holds: storage refuses it once its space's policy changed."""
    import urllib.request
    try:
        request=urllib.request.Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/v1/memory/check',headers={'Authorization':'Bearer '+credential})
        with urllib.request.urlopen(request,timeout=10) as response:return json.loads(response.read(1024)).get('valid') is True
    except Exception:return False

