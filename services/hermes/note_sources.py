"""Who wrote each native note, recorded by Nocheh's parent process where a turn cannot write (ADR-0257).

A note's text says nothing reliable about where it came from: a notes review or a turn can write anything, a citation
included. So the parent reads a profile's notes before and after every run that can write them, under the notes lock,
and records who wrote each entry the run added or changed: a notes review by its id, or a turn by the message it
answered, its channel, its day and what it read. The record is a file in the profile root (SIDECAR), beside
space.json, outside the folders an isolated turn can write (isolated_profile.DATA_DIRS). Storage turns records into
labels when notes are read (/internal/notes/sources). A note with no record reads "source not recorded", never as the
owner's own.

A new note keeps the origins of the notes it replaced: through the replace and patch operations the run asked for,
through every note it removed when those are not known, and through any earlier note it shares a long run of text or
a distinctive token with, unless that note reads as the owner's own. So rewriting a forward's note in new words does
not wash its source away. Another origin only ever makes a label less trusted.
"""
import hashlib
import json
import os
import re
import sqlite3
import time
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SIDECAR='nocheh-note-sources.json'
TARGETS=(('memory','MEMORY.md'),('user','USER.md'))
# A note keeps at most this many origins, its writer first; the rest are counted, and a count reads as unknown.
ORIGINS=10
CITES=20
READS=('forward','file','recent','archive','web','notion','tools','commands','past','other')
CHANNELS=('telegram','browser','scheduler','background')
FROM=('owner','nocheh','person','forward','file','mixed','turn','turn_read','unknown','unavailable')
UNAVAILABLE={'from':'unavailable','label':'source not available right now'}
LOOKUP_BATCH=50
LOCK_SECONDS=30
# A run of this many characters shared with an earlier note is that note's text carried forward.
RUN=32
IDENTIFIER=re.compile(r'(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])')
FULL=re.compile(r'[a-f0-9]{64}')
DAY=re.compile(r'\d{4}-\d{2}-\d{2}')
# Distinctive tokens: a number of six or more digits, an email address, a web address's host, and a code of 15 or more
# letters and digits with a digit in it.
TOKENS=(re.compile(r'\d{6,}'),re.compile(r'[^\s@<>()"\']+@[^\s@<>()"\']+\.[^\s@<>()"\']+'),re.compile(r'https?://([^/\s:?#<>"\']+)'),
        re.compile(r'(?<![0-9a-z])(?=[0-9a-z]*[0-9])[0-9a-z]{15,}(?![0-9a-z])'))
# What a turn's tools read, as read tokens. A search by meaning returns archived messages as they were sent, with no
# source, so it reads other chats as the archive tools do. Only the notes and long-term memory recall are labelled
# already, and the project's tasks and a job's own to-do list are Nocheh's own records, so they are not outside reads;
# any other tool is.
TOOL_READS={'mcp__nocheh__archive_search':'archive','mcp__nocheh__archive_read':'archive','mcp__nocheh__archive_page':'archive',
            'mcp__nocheh__memory_search':'archive','mcp__nocheh__browser':'web','mcp__nocheh__notion':'notion','mcp__nocheh__mcp':'tools',
            'mcp__nocheh__shell':'commands','session_search':'past'}
NOT_READS=frozenset({'memory','mcp__nocheh__memory_recall','mcp__nocheh__tasks','todo_list'})
# The lines Nocheh puts in a turn's message, which stay in its session until a compaction: what earlier turns read.
MARKERS=(('[Forwarded: ','forward'),('[Archived attachment: ','file'),('[Recent messages in this group','recent'))
# The fixed lines src/forwarded.ts forwardLine puts before a forward of the sender's own earlier message, in the owner's
# private chat and elsewhere: the sender's own words, not something read.
OWN_FORWARDS=('[Forwarded: your own earlier message]',"[Forwarded: the sender's own earlier message]")
# The line Nocheh puts before a group message, and the tag that ends it when the owner sent it (speakerLine in
# src/stores/telegram-dispatch.ts). Message text cannot write either: unframed() shows a look-alike as text.
SPEAKER,OWNER_SPEAKER='[Group message from ','] [the owner]'


def key(target,entry):
    """A note's key: its notes file and its exact text."""
    return hashlib.sha256((target+'\0'+entry).encode()).hexdigest()


def done(kind):
    try:
        from .usage import note_done
        note_done(kind)
    except Exception:pass


def failed(kind):
    try:
        from .usage import note_failed
        note_failed(kind)
    except Exception:pass


def entries(profile):
    """Each notes file's entries as Hermes reads them (strict decoding, a leading byte-order mark dropped, each text
    once), by target; None when a file exists but cannot be read, or is a link."""
    from tools.memory_tool_store import MemoryStore
    notes=Path(profile)/'memories';found={}
    if notes.is_symlink():return None
    for target,name in TARGETS:
        file=notes/name
        if file.is_symlink():return None
        raw,ok=MemoryStore._read_raw_checked(file)
        if not ok:return None
        found[target]=list(dict.fromkeys(MemoryStore._parse_entries(raw)))
    return found


def valid(origin):
    """Whether an origin has one of the three shapes the parent writes."""
    if not isinstance(origin,dict):return False
    by=origin.get('by')
    if by=='unknown':return set(origin)=={'by'}
    if by=='review':return set(origin)=={'by','review'} and isinstance(origin['review'],str) and bool(FULL.fullmatch(origin['review']))
    return (by=='turn' and set(origin)=={'by','event','channel','at','reads','complete'} and isinstance(origin['event'],str)
            and bool(FULL.fullmatch(origin['event'])) and isinstance(origin['channel'],str) and origin['channel'] in CHANNELS
            and isinstance(origin['at'],str) and bool(DAY.fullmatch(origin['at'])) and isinstance(origin['reads'],list)
            and len(origin['reads'])<=12 and all(isinstance(read,str) and read in READS for read in origin['reads'])
            and type(origin['complete']) is bool)


def checked(value):
    """The records of a sidecar, each checked, or None when the value is not a sidecar at all. A record that is not
    well formed is left out, so its note reads as not recorded."""
    if not isinstance(value,dict) or value.get('version')!=1 or not isinstance(value.get('entries'),dict):return None
    records={}
    for name,item in value['entries'].items():
        if not isinstance(name,str) or not FULL.fullmatch(name) or not isinstance(item,dict):continue
        origins,more=item.get('origins'),item.get('more',0)
        if not isinstance(origins,list) or not 0<len(origins)<=ORIGINS or type(more) is not int or more<0 or not all(valid(o) for o in origins):continue
        at=item.get('at')
        records[name]={'origins':origins,'more':more,'at':at if isinstance(at,str) and DAY.fullmatch(at) else None}
    return records


def load(profile):
    """A profile's records by note key. A sidecar that cannot be read, or is not one, reads as no records, and counts."""
    path=Path(profile)/SIDECAR
    if not path.exists() and not path.is_symlink():return {}
    try:
        if path.is_symlink():raise ValueError('note_sources_path_denied')
        records=checked(json.loads(path.read_text(encoding='utf-8')))
        if records is None:raise ValueError('note_sources_invalid')
        return records
    except (OSError,ValueError):
        failed('sidecar');return {}


def save(profile,records):
    from .native_memory import save_receipt
    path=Path(profile)/SIDECAR
    if path.is_symlink():raise ValueError('note_sources_path_denied')
    save_receipt(path,json.dumps({'version':1,'entries':records},ensure_ascii=False,sort_keys=True,separators=(',',':')))


@contextmanager
def held(profile,seconds=LOCK_SECONDS):
    """The notes lock Hermes's writers hold, waited for at most `seconds`; yields whether it was taken."""
    import fcntl
    path=Path(profile)/'.memory.lock'
    if path.is_symlink():
        yield False;return
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('a') as file:
        deadline=time.monotonic()+seconds;taken=False
        while not taken:
            try:fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB);taken=True
            except BlockingIOError:
                if time.monotonic()>=deadline:break
                time.sleep(.1)
        try:yield taken
        finally:
            if taken:fcntl.flock(file,fcntl.LOCK_UN)


def _origins(records,name):
    """A note's origins; a note with no record is unknown, and one that had to drop origins has an unknown one too."""
    record=records.get(name)
    if not record:return [{'by':'unknown'}]
    return record['origins']+([{'by':'unknown'}] if record.get('more') else [])


def _plain(text):
    """Text as the copy check compares it: its compatibility form, without case or event ids, one space between words."""
    return ' '.join(IDENTIFIER.sub(' ',unicodedata.normalize('NFKC',text).casefold()).split())


def _tokens(plain):
    found=set()
    for pattern in TOKENS:
        for match in pattern.finditer(plain):found.add(match.group(match.lastindex or 0))
    return found


def _runs(plain):
    return {plain[start:start+RUN] for start in range(len(plain)-RUN+1)}


def _match(entries,old_text):
    """The one note an operation's old_text selects, as Hermes selects it, or None when it selects none or several."""
    from tools.memory_tool_store import _find_unique_match
    index,ambiguous=_find_unique_match(entries,old_text)
    return None if ambiguous or index is None else entries[index]


def _result(entry,op):
    """The text a replace or patch made of a note, when it can be told; None otherwise."""
    content=op.get('content')
    if not isinstance(content,str):return None
    if op['action']=='replace':return content.strip()
    from tools.memory_tool_store import _patch_entry
    for old_text,new_text in ((op['old_text'],content),(op['old_text'].strip(),content.strip())):
        if old_text and old_text in entry:
            patched,_,_=_patch_entry(entry,old_text,new_text)
            if patched is not None:return patched.strip()
    return None


def _capped(origins):
    unique=[]
    for origin in origins:
        if origin not in unique:unique.append(origin)
    return unique[:ORIGINS],max(len(unique)-ORIGINS,0)


def inherited(before,after,records,ops=None,trusted=frozenset()):
    """The origins each note that `after` adds to `before` keeps from earlier notes, by its key."""
    old={key(target,entry):(target,entry) for target,items in before.items() for entry in items}
    new={key(target,entry):(target,entry) for target,items in after.items() for entry in items}
    added=[name for name in new if name not in old]
    found={name:[] for name in added}
    if not added:return found
    if ops is None:
        # What the run asked for is not known: each new note keeps every removed note's origins.
        for gone in (name for name in old if name not in new):
            for name in added:found[name]+=_origins(records,gone)
    else:
        for op in ops:
            if not isinstance(op,dict) or op.get('action') not in ('replace','patch') or not isinstance(op.get('old_text'),str) or not op['old_text'].strip():continue
            target=op.get('target') if op.get('target') in ('memory','user') else 'memory'
            entry=_match(before.get(target,[]),op['old_text'].strip()) if op['action']=='replace' else _match(before.get(target,[]),op['old_text'])
            if entry is None:entry=_match(before.get(target,[]),op['old_text'].strip())
            if entry is None:continue
            made=_result(entry,op)
            # A result that cannot be told apart is any new note of that file.
            names=[name for name in added if new[name]==(target,made)] or [name for name in added if new[name][0]==target]
            for name in names:found[name]+=_origins(records,key(target,entry))
    # A new note that carries an earlier note's text keeps its origins, unless that note reads as the owner's own.
    earlier=[(name,_plain(text)) for name,(_,text) in old.items() if name not in trusted]
    if earlier:
        runs={name:_runs(plain) for name,plain in earlier};tokens={name:_tokens(plain) for name,plain in earlier}
        for name in added:
            plain=_plain(new[name][1]);mine=_runs(plain);marks=_tokens(plain)
            for source,text in earlier:
                if plain==text or mine&runs[source] or marks&tokens[source]:found[name]+=_origins(records,source)
    return {name:[origin for index,origin in enumerate(origins) if origin not in origins[:index]] for name,origins in found.items()}


def record(profile,before,after,origin,ops=None,trusted=frozenset(),now=None):
    """Record who wrote the notes a run added or changed: `origin` first, then the origins they keep from earlier notes.
    Records of notes that are gone are dropped. Nothing is recorded unless both reads worked, so such a note reads as
    not recorded, never as anyone's. Returns how many notes got a record."""
    if before is None or after is None:
        failed('read');return 0
    records=load(profile)
    keep=inherited(before,after,records,ops,trusted)
    names={key(target,entry) for target,items in after.items() for entry in items}
    changed=bool(keep) or any(name not in names for name in records)
    records={name:item for name,item in records.items() if name in names}
    day=datetime.fromtimestamp(now or time.time(),timezone.utc).strftime('%Y-%m-%d')
    for name,origins in keep.items():
        kept,more=_capped([origin,*origins])
        records[name]={'origins':kept,'more':more,'at':day}
    if changed:save(profile,records)
    done('record')
    return len(keep)


def service_post(body):
    """Storage's labels for these notes; only the service token may ask."""
    from urllib.request import Request,urlopen
    from .environment import secret
    request=Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/internal/notes/sources',data=json.dumps(body).encode(),
        headers={'Authorization':'Bearer '+secret('SERVICE_TOKEN'),'Content-Type':'application/json'})
    with urlopen(request,timeout=15) as response:value=json.loads(response.read(1024*1024))
    labels=value.get('labels') if isinstance(value,dict) else None
    if not isinstance(labels,dict):raise RuntimeError('note_sources_unavailable')
    return labels


def label_ok(value):
    """A label as storage sends it: a known `from` and a short line without control characters."""
    return (isinstance(value,dict) and value.get('from') in FROM and isinstance(value.get('label'),str)
            and 0<len(value['label'])<=300 and not any(ord(c)<32 or 0x7f<=ord(c)<0xa0 or c in '  ' for c in value['label']))


def note(records,target,entry):
    """What storage reads to label a note: its key, its origins, how many it dropped, and the events it cites."""
    name=key(target,entry);record=records.get(name);cites=sorted(set(IDENTIFIER.findall(entry)))
    return {'key':name,'origins':record['origins'] if record else [{'by':'unknown'}],'more':record['more'] if record else 0,
            'cites':cites[:CITES],**({'more_cites':True} if len(cites)>CITES else {})}


def notes(found,records):
    return [note(records,target,entry) for target,items in found.items() for entry in items]


def lookup(profile,found,space=None,post=None):
    """The model's labels for the notes in `found` (entries()), by key: {'from','label'}. A failure labels every note as
    not available right now, never as anyone's, and counts; the turn goes on."""
    if not found:return {}
    items=notes(found,load(profile))
    if not items:return {}
    try:
        labels={}
        for start in range(0,len(items),LOOKUP_BATCH):
            labels.update((post or service_post)({'notes':items[start:start+LOOKUP_BATCH],**({'space':space} if isinstance(space,str) and space else {})}))
    except Exception:
        failed('lookup');return {item['key']:dict(UNAVAILABLE) for item in items}
    done('lookup')
    return {item['key']:{'from':labels[item['key']]['from'],'label':labels[item['key']]['label']} if label_ok(labels.get(item['key'])) else dict(UNAVAILABLE)
            for item in items}


def last_message(database):
    """The newest stored message's id: 0 before the first one, None when it cannot be read."""
    from .retired_history import _read_only
    database=Path(database)
    if not database.is_file():return 0
    try:
        connection=_read_only(database)
        try:return connection.execute('SELECT coalesce(max(id),0) FROM messages').fetchone()[0]
        finally:connection.close()
    except sqlite3.Error:return None


def _called(row):
    try:calls=json.loads(row.get('tool_calls') or '[]') if isinstance(row.get('tool_calls'),str) else row.get('tool_calls') or []
    except ValueError:return set()
    return {call['function'].get('name') for call in calls if isinstance(call,dict) and isinstance(call.get('function'),dict)} if isinstance(calls,list) else set()


def tool_read(row):
    """The read token of a stored tool result, by its tool's name, or None for a tool that is not an outside read. A row
    without a tool name, as an older schema stores it, is another tool."""
    name=row.get('tool_name')
    return None if name in NOT_READS else TOOL_READS.get(name,'other')


def _forwards(text):
    """Whether a stored message holds a forwarded line other than one of the sender's own earlier message."""
    start=text.find('[Forwarded: ')
    while start>=0:
        if not any(text.startswith(own,start) for own in OWN_FORWARDS):return True
        start=text.find('[Forwarded: ',start+1)
    return False


def _others(text):
    """Whether a stored message holds a group message someone other than the owner sent."""
    return any(line.startswith(SPEAKER) and not line.endswith(OWNER_SPEAKER) for line in text.split('\n'))


def _written(ops):
    """What a run's memory operations wrote, as the copy check reads it: the runs of RUN characters and the distinctive
    tokens of each text."""
    runs,tokens=set(),set()
    for op in ops:
        if isinstance(op.get('content'),str):
            plain=_plain(op['content']);runs|=_runs(plain);tokens|=_tokens(plain)
    return runs,tokens


def _copied(text,written):
    """Whether a stored message shares a run of RUN characters or a distinctive token with what a run wrote, as
    inheritance tells a note's text carried forward. A long message is read once: its runs are looked up in the
    written ones, and the written tokens are looked for in it, never the other way round."""
    runs,tokens=written
    if not isinstance(text,str) or not runs and not tokens:return False
    plain=_plain(text)
    return any(token in plain for token in tokens) or any(plain[start:start+RUN] in runs for start in range(len(plain)-RUN+1))


def turn_reads(database,session,last,body):
    """What a turn read besides the message it answered, as read tokens, the memory operations it asked for, and whether
    its stored rows could be read: the forward, files and recent group messages it was given; the tools it called
    before its last memory call; the forwards, files and recent group messages earlier in its session since the last
    compaction; and, from there too, a tool result or another person's group message that what the turn wrote copies
    a run of text or a distinctive token from. An earlier read the turn did not copy from leaves its notes alone, so a
    note the owner dictates later in a long session stays the turn's own; a full paraphrase escapes, as in a review.
    A forward of the sender's own earlier message is their own words, not a read."""
    from .retired_history import _columns,_read_only,_summary,memory_ops
    from .turn_process import forwarded,recent_group
    reads=[]
    def add(token):
        if token not in reads:reads.append(token)
    if forwarded(body.get('forwarded')) and body['forwarded'] not in OWN_FORWARDS:add('forward')
    if body.get('files'):add('file')
    if recent_group(body.get('recent_group')):add('recent')
    database=Path(database)
    if last is None:return reads,None,False
    if not database.is_file():return reads,[],True
    try:
        connection=_read_only(database)
        try:
            available=_columns(connection,'messages')
            selected=['id','session_id','role','content','tool_calls']+[name for name in ('tool_name','_compressed_summary') if name in available]
            connection.row_factory=sqlite3.Row
            new=[dict(row) for row in connection.execute('SELECT '+','.join(selected)+' FROM messages WHERE id>? ORDER BY id',(last,))]
            earlier=[dict(row) for row in connection.execute('SELECT '+','.join(selected)+' FROM messages WHERE session_id=? AND id<=? ORDER BY id',(session,last))]
        finally:connection.close()
    except sqlite3.Error:return reads,None,False
    ops=[op for row in new if row['role']=='assistant' for op in memory_ops(row)]
    written=_written(ops)
    start=max((index+1 for index,row in enumerate(earlier) if _summary(row)),default=0)
    for row in earlier[start:]:
        content=row['content'] if isinstance(row['content'],str) else None
        if row['role']=='user' and content is not None:
            for marker,token in MARKERS:
                if marker in content and (token!='forward' or _forwards(content)):add(token)
            if 'recent' not in reads and _others(content) and _copied(content,written):add('recent')
        elif row['role']=='tool':
            token=tool_read(row)
            if token and token not in reads and _copied(content,written):add(token)
    # Only what came back before the turn's last memory call can be in a note it wrote.
    cut=max((row['id'] for row in new if row['role']=='assistant' and 'memory' in _called(row)),default=None)
    for row in new:
        if cut is None or row['id']>=cut:break
        token=tool_read(row) if row['role']=='tool' else None
        if token:add(token)
    return reads,ops,True


def space_of(profile):
    """The chat a profile's turns ran in, as its parent-written space.json names it."""
    marker=Path(profile)/'space.json'
    try:
        if marker.is_symlink() or not marker.is_file():return None
        value=json.loads(marker.read_text())
    except (OSError,ValueError):return None
    space=value.get('space') if isinstance(value,dict) else None
    return space if isinstance(space,str) and 0<len(space)<=200 else None


def before(profile,space=None,database=None):
    """The notes before a run, read under the notes lock, the newest stored message, and the labels the run shows its
    notes with. A run whose notes could not be read under the lock records nothing after it."""
    with held(profile) as locked:
        found=entries(profile)
        last=last_message(database) if database is not None else None
    if not locked:failed('lock')
    labels=lookup(profile,found,space if space is not None else space_of(profile)) if found is not None else {}
    return {'before':found if locked else None,'last':last,'sources':labels,
            'trusted':frozenset(name for name,label in labels.items() if label.get('from')=='owner')}


def after(profile,watch,origin,ops=None):
    """Record who wrote the notes a run added or changed. Notes changed while the lock could not be had are recorded
    as unknown. Never fails the run."""
    try:
        with held(profile) as locked:
            found=entries(profile)
        if not locked:failed('lock');origin={'by':'unknown'}
        return record(profile,watch['before'],found,origin,ops,watch['trusted'])
    except Exception:
        failed('record');return 0


def turn_origin(body,reads,complete,now=None):
    """A turn's origin: the message it answered, its channel, its day, and what it read."""
    channel=body.get('channel','telegram');event=body.get('event_id')
    if channel not in CHANNELS or not isinstance(event,str) or not FULL.fullmatch(event):return {'by':'unknown'}
    return {'by':'turn','event':event,'channel':channel,'at':datetime.fromtimestamp(now or time.time(),timezone.utc).strftime('%Y-%m-%d'),
            'reads':[read for read in reads if read in READS][:12],'complete':bool(complete)}


def after_turn(profile,body,session,watch,result):
    """Record the notes a turn wrote, with what it read; reads it could not read in full are incomplete. A turn whose
    stored messages could not be read counts once, when it added or changed a note, whose label that made less exact."""
    try:
        from .isolated_profile import database_path
        reads,ops,ok=turn_reads(database_path(profile),session,watch['last'],body)
    except Exception:
        reads,ops,ok=[],None,False
    complete=ok and isinstance(result,dict) and result.get('state')=='done'
    recorded=after(profile,watch,turn_origin(body,reads,complete),ops)
    if not ok and recorded:failed('read')
    return recorded
