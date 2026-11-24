"""Carry a chat's Hermes native notes into its profile for a newer guard epoch (ADR-0289).

Each guard epoch gives a chat a new Hermes profile (ADR-0163). Its notes (MEMORY.md, USER.md) come along from the
newest earlier profile of the same chat, once, when storage says every epoch since kept notes for this chat: a change
that takes something away from a chat, such as turning learning off, or a group's sharing or project changing, starts
that chat's notes fresh instead. That earlier profile finishes its own carry first, so it holds the chat's notes as they
stand. Only the owner's private chat and groups carry notes. A member's private chat, a private answer and the owner's
ask about a member have no memory tool; filtering writes none; named and job profiles start fresh each epoch, as their
conversation does (ADR-0163).

A note is left behind when it rests on a retired message (ADR-0129): it cites one, or a turn whose answer is retired;
it is what a turn the earlier profile would withhold wrote; or what it rests on is retired: its writing turns and
notes reviews (its ADR-0257 origins), what those turns read, and the long-term memory they were given
(retired_history.DEPENDENCIES). The writing turns' rows stay behind in the earlier profile, so what each carried note
rests on is worked out from them here and carried on with the note, as is its source record (ADR-0257).

The earlier profile is read while no run holds it, and the new one written while none runs in it. A carry that cannot
finish now (storage or a lock unavailable) is tried again when the profile is next prepared, and until then the earlier
profile is not removed (profile_history.prune). One that cannot ever finish, or has failed for a day, starts the notes
fresh. Drift backups (MEMORY.md.bak.*) and review receipts are never carried.
"""
import fcntl
import json
import logging
import os
import sqlite3
import tempfile
import time
from contextlib import ExitStack, contextmanager
from pathlib import Path


CARRIED='.notes-carried'
TARGETS=(('memory','MEMORY.md'),('user','USER.md'))
# A run still finishing in a profile holds it only briefly here; a carry that cannot wait is tried again later.
LOCK_SECONDS=5
# A carry still failing this long after its first try starts the chat's notes fresh, so earlier profiles do not stay.
GIVE_UP_SECONDS=24*3600
# Failures no retry can fix: the notes or a lock path are not what Nocheh wrote.
FINAL=frozenset({'notes_unreadable','memory_path_denied','profile_lock_path_denied','note_dependencies_path_denied','profile_path_denied',
                 'note_dependencies_unreadable','note_sources_unreadable'})


def carries(receipt):
    """Whether a profile keeps its chat's notes across guard epochs: the owner's private chat's own profile (where
    reviews also write) or a group's. Never a member's private chat, a private answer, the owner's ask about a member,
    filtering or a named or job profile."""
    from .scopes import Scopes
    if not isinstance(receipt,dict) or type(receipt.get('guard_epoch')) is not int or not isinstance(receipt.get('space'),str):return False
    if receipt.get('purpose')=='filter' or any(receipt.get(key) for key in ('answer','member','member_read')):return False
    return receipt.get('logical_profile') in ('',None,Scopes.profile(receipt['space']))


def _marker(profile):
    try:value=json.loads((Path(profile)/CARRIED).read_text())
    except (OSError,ValueError):return None
    return value if isinstance(value,dict) else None


def done(profile):
    """Whether a profile's notes wait on no earlier profile any more: carried, started fresh, or nothing to carry."""
    value=_marker(profile)
    return value is not None and value.get('error') is None


def source(profile):
    """The newest earlier-epoch profile of the same chat that keeps notes, as (epoch, path), or None."""
    from .profile_history import _receipt,_same_chat
    current=_receipt(profile);best=None
    for other in profile.parent.iterdir():
        if other==profile or other.is_symlink() or not other.is_dir():continue
        receipt=_receipt(other);epoch=receipt.get('guard_epoch') if receipt else None
        if type(epoch) is not int or not epoch<current['guard_epoch'] or not _same_chat(current,receipt) or not carries(receipt):continue
        if best and best[0]>=epoch:continue
        best=(epoch,other)
    return best


def service_post(body):
    """Storage's answer whether notes may cross the epochs between two profiles; only the service token may ask."""
    from urllib.request import Request,urlopen
    from .environment import secret
    request=Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/internal/notes/carry',data=json.dumps(body).encode(),
        headers={'Authorization':'Bearer '+secret('SERVICE_TOKEN'),'Content-Type':'application/json'})
    with urlopen(request,timeout=15) as response:value=json.loads(response.read(64*1024))
    if not isinstance(value,dict) or type(value.get('carry')) is not bool:raise RuntimeError('notes_carry_unavailable')
    return value


def allowed(current,earlier,post=None):
    """Whether every epoch after `earlier`'s up to `current`'s kept notes for this chat (the owner's, or every chat's)."""
    body={'generation':str(current.get('generation') or ''),'from':earlier['guard_epoch'],'to':current['guard_epoch'],'owner':current.get('owner') is True}
    return (post or service_post)(body)['carry'] is True


@contextmanager
def _held(path,seconds=None):
    """An exclusive lock on `path`, waited for at most `seconds` (LOCK_SECONDS); yields whether it was taken."""
    if path.is_symlink():raise ValueError('profile_lock_path_denied')
    with path.open('a') as file:
        deadline=time.monotonic()+(LOCK_SECONDS if seconds is None else seconds);taken=False
        while not taken:
            try:fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB);taken=True
            except BlockingIOError:
                if time.monotonic()>=deadline:break
                time.sleep(.1)
        try:yield taken
        finally:
            if taken:fcntl.flock(file,fcntl.LOCK_UN)


def _quiet(locks,profile):
    """Hold a profile's turn lock, then its notes lock, as its runs take them: no run is writing its notes or their records
    meanwhile, and no prune removes it."""
    for name in ('.turn.lock','.memory.lock'):
        if not locks.enter_context(_held(profile/name)):raise BlockingIOError('profile_busy')


def _records(profile):
    """A profile's note source records (ADR-0257), or an error: a carry never goes on without them, nor writes over them.
    A read error is raised as it came, so the carry is tried again; a file that is not one never will be."""
    from . import note_sources
    path=Path(profile)/note_sources.SIDECAR
    if path.is_symlink():raise ValueError('note_sources_unreadable')
    if not path.exists():return {}
    try:records=note_sources.checked(json.loads(path.read_text(encoding='utf-8')))
    except ValueError:records=None
    if records is None:raise ValueError('note_sources_unreadable')
    return records


def _snapshot(earlier):
    """The earlier profile's notes, their source records and dependencies, and its stored rows, read while no run holds
    it; None when its notes cannot be read, so none carry."""
    from . import note_sources
    from .isolated_profile import database_path
    from .retired_history import load_dependencies,stored_rows
    with ExitStack() as locks:
        _quiet(locks,earlier)
        found=note_sources.entries(earlier)
        if found is None:return None
        if not any(found.values()):return {'found':found}
        database=database_path(earlier)
        return {'found':found,'records':_records(earlier),'inherited':load_dependencies(earlier,strict=True)['entries'],
                'database':database,'rows':stored_rows(database)}


def _origins(record):
    """What a note's ADR-0257 record says it rests on: the message each writing turn answered, and each notes review."""
    origins=record.get('origins',[]) if isinstance(record,dict) else []
    return {'turn':{origin['event'] for origin in origins if origin.get('by')=='turn'},
            'sources':{origin['review'] for origin in origins if origin.get('by')=='review'}}


def _filter(snapshot,lookup,owner):
    """The notes of a snapshot that may carry, with their records and dependencies, the retirement revision they were
    checked at, and how many stayed behind. A group's note copied from a fact the owner granted it stays behind once the
    grant has lapsed, as the group can no longer read it; the owner's chat reads everything (`owner`)."""
    from .note_sources import key
    from .retired_history import IDENTIFIER,_lookup,dependent,entry_dependencies,note_dependencies,pending,withheld_note
    found,records=snapshot['found'],snapshot['records']
    # The rows of the turns that wrote these notes stay behind: what each rests on goes with it.
    made=entry_dependencies(note_dependencies(snapshot['rows']),found)
    depends={}
    for target,items in found.items():
        for entry in items:
            name=key(target,entry);parts=[snapshot['inherited'].get(name),made.get(name),_origins(records.get(name))]
            item={part:sorted(set().union(*(set(one[part]) for one in parts if one))) for part in ('turn','sources')}
            if item['turn'] or item['sources']:depends[name]=item
    cited={event for items in found.values() for entry in items for event in IDENTIFIER.findall(entry)}
    every=cited.union(*(set(item['turn'])|set(item['sources']) for item in depends.values()))
    extra={};revision,retired,answered=_lookup(lookup,every,extra)
    if not owner:retired=retired|extra.get('lapsed',set())
    # What the earlier profile's own next turn would withhold, had it one (ADR-0129).
    _,written,spans=pending(snapshot['database'],lookup)
    gone=dependent(depends,retired,answered);hidden=retired|{event for event,replies in answered.items() if replies}
    kept={target:[entry for entry in items if not set(IDENTIFIER.findall(entry))&hidden and not withheld_note(entry,written,spans)
                  and key(target,entry) not in gone] for target,items in found.items()}
    names={key(target,entry) for target,items in kept.items() for entry in items}
    return {'notes':kept,'records':{name:records[name] for name in names if name in records},
            'depends':{name:depends[name] for name in names if name in depends},'revision':revision,
            'dropped':sum(len(items) for items in found.values())-len(names)}


def _write_file(file,entries):
    """Replace a notes file as Hermes does: a temporary file beside it, synced, then moved into place."""
    with tempfile.NamedTemporaryFile('w',encoding='utf-8',dir=file.parent,prefix='.mem_',suffix='.tmp',delete=False) as output:
        output.write('\n§\n'.join(entries));output.flush();os.fsync(output.fileno())
    os.chmod(output.name,0o600);os.replace(output.name,file)
    directory=os.open(file.parent,os.O_RDONLY)
    try:os.fsync(directory)
    finally:os.close(directory)


@contextmanager
def _file_lock(file):
    """The lock Hermes's own notes writers take for this file (tools/memory_tool_store.py)."""
    descriptor=os.open(file.with_name(file.name+'.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(descriptor,fcntl.LOCK_EX)
        yield
    finally:os.close(descriptor)


def _write(profile,carried):
    """Put the carried notes first in the new profile's notes, its own after them. Their records and dependencies are
    saved first, so a note never stands here without what it rests on."""
    from . import note_sources
    from .note_sources import key
    from .retired_history import load_dependencies,save_dependencies
    notes=profile/'memories'
    if notes.is_symlink():raise ValueError('memory_path_denied')
    notes.mkdir(mode=0o700,exist_ok=True)
    if not notes.resolve().is_relative_to(profile.resolve()):raise ValueError('memory_path_denied')
    with ExitStack() as locks:
        # A run that already started here (a retried carry) finishes first, so it never records these notes as its own.
        _quiet(locks,profile)
        own=note_sources.entries(profile)
        if own is None:raise ValueError('notes_unreadable')
        merged={target:list(dict.fromkeys(carried['notes'].get(target,[])+own.get(target,[]))) for target,_ in TARGETS}
        present={key(target,entry) for target,items in merged.items() for entry in items}
        records=_records(profile)
        missing={name:record for name,record in carried['records'].items() if name not in records}
        if missing:note_sources.save(profile,{**records,**missing})
        mine=load_dependencies(profile,strict=True)
        entries={name:item for name,item in mine['entries'].items() if name in present}
        for name,item in carried['depends'].items():
            before=entries.get(name,{'turn':[],'sources':[]})
            entries[name]={part:sorted(set(before[part])|set(item[part])) for part in ('turn','sources')}
        if entries or mine['entries']:
            # Dependencies already here were checked at their own revision; all are checked again when it differs.
            checked=carried['revision'] if not mine['entries'] or mine['checked']==carried['revision'] else None
            save_dependencies(profile,checked,entries)
        for target,name in TARGETS:
            if merged[target]!=own.get(target,[]):
                with _file_lock(notes/name):_write_file(notes/name,merged[target])


def _final(failure):
    """Whether a carry failed in a way no retry fixes: notes or paths that are not what Nocheh wrote, or a damaged database."""
    return (isinstance(failure,ValueError) and str(failure) in FINAL
            or isinstance(failure,sqlite3.DatabaseError) and not isinstance(failure,sqlite3.OperationalError))


def carry_notes(profile,lookup=None,post=None):
    """Bring a new profile its chat's notes from the newest earlier profile, once; return how many."""
    from .native_memory import save_receipt
    from .profile_history import _receipt
    profile=Path(profile)
    if profile.is_symlink():raise ValueError('profile_path_denied')
    current=_receipt(profile)
    if not carries(current):return 0
    with (profile/'.carry.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if done(profile):return 0
        previous=_marker(profile) or {}
        found=source(profile);result={'from':found[1].name if found else None,'notes':0,'error':None}
        try:
            if found is not None:
                # The earlier profile holds the chat's notes as they stand only once its own carry has finished. Locks are
                # always taken newer profile first, so carries running from both ends never wait on each other.
                if not done(found[1]):carry_notes(found[1],lookup,post)
                if not done(found[1]):raise BlockingIOError('earlier_notes_not_carried')
                snapshot=_snapshot(found[1])
                if snapshot is None:result['unreadable']=True
                # A chat with no notes yet has nothing to carry, and nothing to ask storage.
                elif not any(snapshot['found'].values()):pass
                elif not allowed(current,_receipt(found[1]),post):result['fresh']=True
                else:
                    from .retired_history import service_lookup
                    carried=_filter(snapshot,lookup or service_lookup,current.get('owner') is True)
                    _write(profile,carried)
                    result.update(notes=sum(len(items) for items in carried['notes'].values()),dropped=carried['dropped'])
        except Exception as failure:
            since=previous.get('since') if type(previous.get('since')) in (int,float) else time.time()
            if _final(failure) or time.time()-since>=GIVE_UP_SECONDS:
                # It would fail the same way every time: the notes start fresh, and the earlier profile can go.
                result.update(notes=0,fresh=True,failed=type(failure).__name__)
            else:
                # Not carried yet: tried again when this profile is next prepared, and the earlier one is kept until then.
                result.update(error=type(failure).__name__,since=since)
            logging.getLogger(__name__).warning('profile_notes_not_carried: %s',type(failure).__name__)
        save_receipt(profile/CARRIED,json.dumps(result))
        return result['notes']
