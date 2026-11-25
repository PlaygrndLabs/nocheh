"""The agent's side of a Telegram turn: its native profile, the native turn and its session title.

Nocheh decides who a group message addresses and its own Telegram service polls and sends; nothing here reaches Telegram."""

from services.hermes.environment import parallel
import asyncio
import json
import os
import re
import time
from pathlib import Path

from services.durable import canonical, digest
from . import daily_session
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
# The owner's ask about a member (step 4b) runs on the asking message under an attempt that names the ask.
MEMBER_READ_ATTEMPT=re.compile(r'm[1-9]\d{0,2}-[a-f0-9]{32}')


def continuation_id(body):
    """The leader action id of a continuation, or None for a message turn. A continuation's attempt names it, so its
    receipt, run and archived result never meet a message turn's; it carries no fixed control reply."""
    attempt,value=body.get('attempt'),body.get('continuation')
    ask=body.get('member_read')
    if ask is not None:
        # Its attempt names its ask, so it never meets the asking turn's own receipt, run or reply; never a continuation.
        if (value is not None or not isinstance(ask,dict) or not isinstance(attempt,str) or not MEMBER_READ_ATTEMPT.fullmatch(attempt)
                or ask.get('ask')!=attempt[-32:] or body.get('control_reply') is not None):raise ValueError('invalid_member_read')
        return None
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
    configure_profile(profile, model, chat=scope.chat_id)
    from .persona import audience, materialize
    # A private answer runs in the owner's private chat but never loads that chat's own role or skills: it gets the
    # project's, else the groups default (ADR-0249). A member's private chat has no role of its own (step 4): it reads the
    # groups default too. The owner's ask about a member (step 4b) loads none either.
    materialize(root, profile, None if scope.answer or scope.member or scope.member_read else scope.chat_id, scope.project, audience(scope))
    from .native_memory import save_receipt
    # The marker keeps the chat beside its space, so what a topic inherits never comes from the shape of its id (ADR-0252).
    save_receipt(profile/'space.json',json.dumps({'space':scope.space or scope.chat_id,'chat':scope.chat_id,'revision':scope.revision,'owner':scope.owner,
        'guard_epoch':scope.guard_epoch,'generation':scope.generation,'purpose':scope.purpose,'logical_profile':scope.logical_profile,
        **({'answer':scope.answer} if scope.answer else {}),
        # A member's own private chat (step 4) and the owner's ask about a member (step 4b): the owner's recall leaves
        # their notes and sessions out (D7).
        **({'member':scope.member} if scope.member else {}),**({'member_read':scope.member_read} if scope.member_read else {})}))
    plugins=profile/'plugins';plugins.mkdir(exist_ok=True)
    link=plugins/'nocheh';target=Path(__file__).resolve().parent
    if not link.exists():link.symlink_to(target,target_is_directory=True)
    if scope.guard_epoch:
        # A new guard epoch starts a new profile; the chat keeps its conversation and its notes (ADR-0292), and the
        # superseded profiles are removed once idle.
        from .profile_history import carry, prune, prune_answers
        from .profile_notes import carry_notes
        # A private answer starts empty: no earlier answer's conversation, from any group, is carried into it (ADR-0249).
        # Nor is anything carried into the owner's ask about a member (step 4b), and its profile is never carried on: it is
        # not the owner's and no later turn opens it. A member's private chat carries its conversation but has no notes.
        if scope.purpose!='filter' and not scope.answer and not scope.member_read:
            carry(profile);carry_notes(profile)
        prune(profile)
        # No later turn opens a private answer's profile, so any turn removes those no answer can run in any more.
        prune_answers(profile)
    return profile


async def native_turn(root,scope,body,model,credentials,cancelled=None,steering=None):
    profile=await asyncio.to_thread(prepare_profile,root,scope,model)
    topic=topic_id(body['payload']['message'])
    thread='main' if topic is None else str(topic)
    logical=digest(scope.chat_id+':'+thread)
    cursor=profile/('active-'+logical+'.json')
    # One session per chat per day (ADR-0288); a follow-up after an approval stays in the session that asked.
    place=daily_session.zone(body.get('day_zone'))
    now=time.time()
    session_id,previous,day=daily_session.choose(daily_session.cursor_value(json.loads(cursor.read_text())) if cursor.exists() else None,
        logical,now,place,follow_up=body.get('continuation') is not None)
    if previous is not None:
        def open_day():
            from .native_store import writer
            from .profile_config import preferences, read
            carry=preferences(read(profile/'config.yaml'))['nocheh.carry_messages']
            with writer(profile) as db:daily_session.start(db,session_id,previous,carry,body.get('channel','telegram'),profile)
        await asyncio.to_thread(open_day)
    from .turn_process import run_process
    result = await run_process(root, scope, body, model, credentials, session_id,cancelled=cancelled,prepared_profile=profile,steering=steering)
    if result.get('state')=='done':
        def save_cursor():
            temporary=cursor.with_suffix('.tmp')
            with temporary.open('wb') as file:
                file.write(canonical({'session_id':result['session_id'],'day':day,'last_active':int(now)}));file.flush();os.fsync(file.fileno())
            temporary.replace(cursor)
            directory=os.open(profile,os.O_RDONLY)
            try:os.fsync(directory)
            finally:os.close(directory)
        await asyncio.to_thread(save_cursor)
        try:await asyncio.to_thread(title_session,profile,result['session_id'],body['payload']['message'],scope.owner,bool(scope.answer),bool(scope.member),bool(scope.member_read),day)
        except Exception:pass # A missing title is cosmetic; the next turn tries again.
    return result


def session_title(message,owner,answer=False,member=False,member_read=False,day=None):
    """The chat a Telegram session belongs to, as the dashboard's session list shows it. A private answer's own
    session is named as one, so the owner's private chat keeps its own name (ADR-0249); so is an ask about a member;
    a member's private chat is named as a member's, by the name Telegram shows for them (step 4)."""
    if answer:return 'Private answer'
    if member_read:return 'Ask about a member'
    chat=message.get('chat') if isinstance(message.get('chat'),dict) else {}
    if member:
        name=' '.join(part.strip() for part in (chat.get('first_name'),chat.get('last_name')) if isinstance(part,str) and part.strip())
        return (('Private chat with '+name) if name else "A member's private chat")[:90]
    title=chat.get('title') if isinstance(chat.get('title'),str) else ''
    name='Private chat' if owner else title.strip() or 'Telegram group'
    topic=topic_id(message)
    if topic is not None:
        # A message in a forum topic answers the topic's opening message, which carries the topic's name.
        opening=message.get('reply_to_message') if isinstance(message.get('reply_to_message'),dict) else {}
        created=opening.get('forum_topic_created') if isinstance(opening.get('forum_topic_created'),dict) else {}
        label=created.get('name') if isinstance(created.get('name'),str) and created.get('name').strip() else 'topic '+str(topic)
        name+=' › '+label.strip()
    # Each day's session carries its day (ADR-0288). Hermes allows 100 characters; leave room for its " #2" when
    # another session already has the name.
    dated=daily_session.label(day)
    return (name[:80]+' · '+dated) if dated else name[:90]


def title_session(profile,session_id,message,owner,answer=False,member=False,member_read=False,day=None):
    """Name a Telegram session after its chat. It is Hermes's top automatic title: it replaces a first-message
    title and stays once set, and Hermes keeps a title set by hand over it."""
    from persistence.conversation.sessions import TitleSource
    from .native_store import writer
    title=session_title(message,owner,answer,member,member_read,day)
    with writer(profile) as db:
        record=db.sessions.get(session_id)
        if record is None or record.title_source in (TitleSource.LLM,TitleSource.USER):return
        try:db.sessions.set_auto_title(session_id,title,source=TitleSource.LLM)
        except ValueError:db.sessions.set_auto_title(session_id,db.sessions.next_title_in_lineage(title),source=TitleSource.LLM)


def report_conversation_reads(credential,reads):
    """Tell storage what the conversation a turn runs in holds besides the owner's typed words (ADR-0293). Never fails
    the turn: storage then has no report, and a command in the turn asks first."""
    import urllib.request
    try:
        request=urllib.request.Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/v1/turn/conversation-reads',method='POST',
            data=json.dumps({'reads':list(reads)}).encode(),headers={'Authorization':'Bearer '+credential,'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=10) as response:return json.loads(response.read(1024)).get('recorded') is True
    except Exception:return False


def check_delivery_policy(credential):
    """Whether a turn's pass still holds: storage refuses it once its space's policy changed."""
    import urllib.request
    try:
        request=urllib.request.Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/v1/memory/check',headers={'Authorization':'Bearer '+credential})
        with urllib.request.urlopen(request,timeout=10) as response:return json.loads(response.read(1024)).get('valid') is True
    except Exception:return False

