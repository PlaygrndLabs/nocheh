"""Carry a chat's conversation into its profile for a newer guard epoch.

Each guard epoch gives a chat a new Hermes profile, so without this the chat
would start empty whenever memory changes, including automatic learning. A new
profile's sessions are seeded once, from the newest earlier-epoch profile of the
same chat that has any, with only the stored user messages and delivered
answers. Tool calls, tool results, reasoning and compaction summaries stay
behind. Rows already withheld for retired sources keep their placeholders, and
the profile's first turn withholds anything retired since, before its history
is prepared again for the new epoch.

Once a newer profile exists, earlier-epoch profiles of the same chat are
removed after they have been idle for a while, so hidden or corrected content
does not stay behind in conversations that are no longer used.
"""
import fcntl
import json
import logging
import re
import shutil
import time
from pathlib import Path

from .isolated_profile import database_path

CURSOR=re.compile(r'active-[0-9a-f]{64}\.json')
CARRIED='.history-carried'
# Enough recent conversation for continuity; older context stays searchable in the archive.
MESSAGES=120
# A superseded profile may still finish a turn or review that started before
# the epoch changed; it is removed only after this long without any change.
IDLE_SECONDS=15*60
COMPACTION=('[CONTEXT COMPACTION','[CONTEXT SUMMARY]:')


def _receipt(profile):
    try:value=json.loads((profile/'space.json').read_text())
    except (OSError,ValueError):return None
    return value if isinstance(value,dict) else None


def _same_chat(current,other):
    """Same chat, owner flag, installation and logical profile; reviews share the assistant profile, filtering does not."""
    keys=('space','owner','generation','logical_profile')+(() if current.get('generation') else ('revision',))
    kind=lambda value:'filter' if value.get('purpose')=='filter' else 'assistant'
    return all(current.get(key)==other.get(key) for key in keys) and kind(current)==kind(other)


def _cursors(profile):
    found={}
    for path in profile.glob('active-*.json'):
        if not CURSOR.fullmatch(path.name) or path.is_symlink():continue
        try:session=json.loads(path.read_text()).get('session_id')
        except (OSError,ValueError,AttributeError):continue
        if isinstance(session,str) and 0<len(session)<=256:found[path.name]=session
    return found


def predecessor(profile):
    """The newest earlier-epoch profile of the same chat that holds a conversation."""
    from .scopes import Scopes
    current=_receipt(profile)
    if not current or type(current.get('guard_epoch')) is not int or not isinstance(current.get('space'),str):return None
    # Named runtime profiles keep their own sessions; only a chat's own profile carries its conversation.
    if current.get('logical_profile') not in ('',None,Scopes.profile(current['space'])):return None
    best=None
    for other in profile.parent.iterdir():
        if other==profile or other.is_symlink() or not other.is_dir():continue
        receipt=_receipt(other)
        epoch=receipt.get('guard_epoch') if receipt else None
        if type(epoch) is not int or not epoch<current['guard_epoch'] or not _same_chat(current,receipt):continue
        if not _cursors(other) or best and best[0]>=epoch:continue
        best=(epoch,other)
    return best[1] if best else None


def _conversation(messages):
    kept=[]
    for message in messages:
        content=message.get('content')
        if message.get('_compressed_summary') or not isinstance(content,str) or not content.strip():continue
        if content.lstrip().startswith(COMPACTION):continue
        if message.get('role')=='user' or message.get('role')=='assistant' and not message.get('tool_calls'):
            kept.append({'role':message['role'],'content':content})
    while kept and kept[0]['role']!='user':kept.pop(0)
    return kept


def _copy(source,profile):
    from hermes_state import SessionDB
    old=SessionDB(database_path(source),read_only=True)
    try:
        found={}
        for name,session in _cursors(source).items():
            stored=old.get_session(session)
            messages=_conversation(old.get_messages(session,latest=True,limit=MESSAGES*3))[-MESSAGES:] if stored else []
            if messages:found[name]=(session,str(stored.get('source') or 'telegram'),messages)
    finally:old.close()
    if not found:return 0
    # Isolated turns keep the database in native-state/; a fresh profile starts in that layout.
    if not (profile/'state.db').exists():(profile/'native-state').mkdir(exist_ok=True,mode=0o700)
    new=SessionDB(database_path(profile));copied=0
    try:
        for name,(session,origin,messages) in found.items():
            if new.get_session(session):continue
            new.create_session(session,source=origin)
            new.append_messages_batch(session,messages)
            copied+=len(messages)
            cursor=profile/name;temporary=cursor.with_suffix('.tmp')
            temporary.write_text(json.dumps({'session_id':session}));temporary.replace(cursor)
    finally:new.close()
    return copied


def carry(profile):
    """Seed a new profile's chat sessions from its predecessor once; return the number of messages copied."""
    profile=Path(profile)
    if profile.is_symlink():raise ValueError('profile_path_denied')
    with (profile/'.carry.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if (profile/CARRIED).exists() or _cursors(profile):return 0
        source,copied,error=predecessor(profile),0,None
        try:
            if source is not None:copied=_copy(source,profile)
        except Exception as failure:
            # Carrying is continuity, not a gate: the turn still runs, as before, on an empty conversation.
            error=type(failure).__name__
            logging.getLogger(__name__).warning('profile_history_not_carried: %s',error)
        (profile/CARRIED).write_text(json.dumps({'from':source.name if source else None,'messages':copied,'error':error}))
        return copied


def _last_change(profile):
    """The newest change to a profile's own files and its isolated state."""
    newest=profile.stat().st_mtime
    for folder in (profile,profile/'native-state',profile/'memories',profile/'sessions'):
        if folder.is_dir() and not folder.is_symlink():
            for entry in folder.iterdir():
                try:newest=max(newest,entry.lstat().st_mtime)
                except OSError:continue
    return newest


def prune(profile,now=None):
    """Remove idle earlier-epoch profiles of the same chat; return their names."""
    profile=Path(profile)
    current=_receipt(profile)
    if not current or type(current.get('guard_epoch')) is not int:return []
    if current.get('purpose')!='filter':
        # Never remove the conversation a chat's profile could not carry over yet.
        try:carried=json.loads((profile/CARRIED).read_text())
        except (OSError,ValueError):carried=None
        if not (isinstance(carried,dict) and carried.get('error') is None or _cursors(profile)):return []
    now=time.time() if now is None else now
    removed=[]
    for other in profile.parent.iterdir():
        if other==profile or other.is_symlink() or not other.is_dir():continue
        receipt=_receipt(other)
        epoch=receipt.get('guard_epoch') if receipt else None
        if type(epoch) is not int or not epoch<current['guard_epoch'] or not _same_chat(current,receipt):continue
        try:
            if now-_last_change(other)<IDLE_SECONDS:continue
            # A profile whose memory or carry lock is held is still in use.
            with (other/'.memory.lock').open('a') as memory,(other/'.carry.lock').open('a') as carrying:
                fcntl.flock(memory,fcntl.LOCK_EX|fcntl.LOCK_NB);fcntl.flock(carrying,fcntl.LOCK_EX|fcntl.LOCK_NB)
                shutil.rmtree(other)
            removed.append(other.name)
        except (OSError,BlockingIOError) as failure:
            logging.getLogger(__name__).warning('profile_not_pruned: %s',type(failure).__name__)
    return removed
