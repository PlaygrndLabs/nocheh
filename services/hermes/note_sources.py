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
READS=('forward','file','recent','reply','archive','memory','tasks','web','notion','tools','commands','past','other')
CHANNELS=('telegram','browser','scheduler','background')
FROM=('owner','nocheh','person','forward','file','mixed','turn','turn_read','unknown','unavailable')
UNAVAILABLE={'from':'unavailable','label':'source not available right now'}
LOOKUP_BATCH=50
LOCK_SECONDS=30
# A run of this many characters shared with an earlier note is that note's text carried forward.
RUN=32
# The shortest replied-to text a note copies whole that counts as copied, when it is shorter than RUN (_reply_copied).
SHORT_COPY=12
IDENTIFIER=re.compile(r'(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])')
FULL=re.compile(r'[a-f0-9]{64}')
DAY=re.compile(r'\d{4}-\d{2}-\d{2}')
# A note's ref in a turn's evidence: the first 12 hex of its key, which archive_read {note} opens in that turn (ADR-0261).
REF=re.compile(r'[a-f0-9]{12}')
# Distinctive tokens: a number of six or more digits, an email address, a web address's host, and a code of 15 or more
# letters and digits with a digit in it.
TOKENS=(re.compile(r'\d{6,}'),re.compile(r'[^\s@<>()"\']+@[^\s@<>()"\']+\.[^\s@<>()"\']+'),re.compile(r'https?://([^/\s:?#<>"\']+)'),
        re.compile(r'(?<![0-9a-z])(?=[0-9a-z]*[0-9])[0-9a-z]{15,}(?![0-9a-z])'))
# What a turn's tools read, as read tokens. A search by meaning returns archived messages as they were sent, with no
# source, so it reads other chats as the archive tools do. Only the notes are labelled already, and a job's own to-do
# list is Nocheh's own record, so they are not outside reads; any other tool is. Long-term memory recall and the
# project's tasks are outside reads only when they hold other people's words (recall_read, task_read).
TOOL_READS={'mcp__nocheh__archive_search':'archive','mcp__nocheh__archive_read':'archive','mcp__nocheh__archive_page':'archive',
            'mcp__nocheh__memory_search':'archive','mcp__nocheh__browser':'web','mcp__nocheh__notion':'notion','mcp__nocheh__github':'tools','mcp__nocheh__gmail':'tools','mcp__nocheh__mcp':'tools',
            'mcp__nocheh__shell':'commands','session_search':'past'}
NOT_READS=frozenset({'memory','todo_list'})
# Every chat of a project reads its whole task list, but with "Share group chats" off a group does not share what it
# knows with the project's other groups, so storage marks a read that shows their tasks other_groups (ADR-0276). Such a
# read is what those chats wrote, so it reads as other chats' messages do. The mark is looked for escaped too, as a
# result cut to fit or stored inside another holds it; task text cannot hide it, only add a look-alike that counts.
TASKS='mcp__nocheh__tasks'
OTHER_GROUPS=re.compile(r'\\*"other_groups\\*"\s*:\s*true')
# Storage marks a task read others_wrote when a task it shows has a title, notes or comments someone other than the
# owner wrote, such as a member in a group or in the members' app: their words, not the owner's.
OTHERS_WROTE=re.compile(r'\\*"others_wrote\\*"\s*:\s*true')
# A long-term memory recall that answers with memory's own reasoning (memory_inference) or the facts it read reads what
# everyone in the owner's chats said; one that holds only the owner's corrections, or nothing, reads nothing outside.
RECALL='mcp__nocheh__memory_recall'
INFERRED=re.compile(r'\\*"kind\\*"\s*:\s*\\*"memory_inference\\*"')
# The lines Nocheh puts in a turn's message, which stay in its session until a compaction: what earlier turns read.
MARKERS=(('[Forwarded: ','forward'),('[Archived attachment: ','file'),('[Recent messages in this group','recent'))
# The fixed lines src/forwarded.ts forwardLine puts before a forward of the sender's own earlier message, in the owner's
# private chat and elsewhere: the sender's own words, not something read. In the message a turn answers either is the
# words of whoever sent it, as their typed text is, and the turn's label already says where it was. Earlier in a session
# only the first is the owner's: the second, in a group, is a member's words, so there it counts as a forward read.
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
    # A turn's moment (at_time, Unix seconds) goes with its UTC day; a record written before it was has the day alone.
    timed='at_time' in origin
    if timed and not (type(origin['at_time']) is int and 0<=origin['at_time']<=10**11 and isinstance(origin.get('at'),str)
                      and datetime.fromtimestamp(origin['at_time'],timezone.utc).strftime('%Y-%m-%d')==origin['at']):return False
    return (by=='turn' and set(origin)-{'at_time'}=={'by','event','channel','at','reads','complete'} and isinstance(origin['event'],str)
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
    """Storage's labels for these notes; only the agent login may ask."""
    from urllib.request import Request,urlopen
    from .environment import agent_key
    request=Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/internal/notes/sources',data=json.dumps(body).encode(),
        headers={'Authorization':'Bearer '+agent_key(),'Content-Type':'application/json'})
    with urlopen(request,timeout=15) as response:value=json.loads(response.read(1024*1024))
    labels=value.get('labels') if isinstance(value,dict) else None
    if not isinstance(labels,dict):raise RuntimeError('note_sources_unavailable')
    return labels


def label_ok(value):
    """A label as storage sends it: a known `from` and a short line without control characters, and for a turn's notes
    the note's ref, 12 hex."""
    return (isinstance(value,dict) and value.get('from') in FROM and isinstance(value.get('label'),str)
            and 0<len(value['label'])<=300 and not any(ord(c)<32 or 0x7f<=ord(c)<0xa0 or c in '  ' for c in value['label'])
            and ('ref' not in value or isinstance(value['ref'],str) and bool(REF.fullmatch(value['ref']))))


def note(records,target,entry):
    """What storage reads to label a note: its key, its origins, how many it dropped, and the events it cites."""
    name=key(target,entry);record=records.get(name);cites=sorted(set(IDENTIFIER.findall(entry)))
    return {'key':name,'origins':record['origins'] if record else [{'by':'unknown'}],'more':record['more'] if record else 0,
            'cites':cites[:CITES],**({'more_cites':True} if len(cites)>CITES else {})}


def notes(found,records):
    return [note(records,target,entry) for target,items in found.items() for entry in items]


def lookup(profile,found,space=None,post=None,turn_event=None):
    """The model's labels for the notes in `found` (entries()), by key: {'from','label'}, and in a turn (`turn_event`,
    the message it answers) each note's `ref`, which opens in that turn the messages it was written from; a ref that is
    not its own note's is left out. A failure labels every note as not available right now, never as anyone's, and
    counts; the turn goes on."""
    if not found:return {}
    items=notes(found,load(profile))
    if not items:return {}
    try:
        labels={}
        for start in range(0,len(items),LOOKUP_BATCH):
            labels.update((post or service_post)({'notes':items[start:start+LOOKUP_BATCH],**({'space':space} if isinstance(space,str) and space else {}),
                                                  **({'turn_event':turn_event} if isinstance(turn_event,str) and FULL.fullmatch(turn_event) else {})}))
    except Exception:
        failed('lookup');return {item['key']:dict(UNAVAILABLE) for item in items}
    done('lookup')
    def shown(name):
        value=labels.get(name)
        if not label_ok(value):return dict(UNAVAILABLE)
        return {'from':value['from'],'label':value['label'],**({'ref':value['ref']} if value.get('ref')==name[:12] else {})}
    return {item['key']:shown(item['key']) for item in items}


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


def task_read(content):
    """The read token of a task result: other chats' words when storage marked it other_groups, else tasks other people
    wrote when it marked it others_wrote, else None."""
    if not isinstance(content,str):return None
    return 'archive' if OTHER_GROUPS.search(content) else 'tasks' if OTHERS_WROTE.search(content) else None


def recall_read(content):
    """The read token of a long-term memory recall: long-term memory when it holds memory's reasoning, else None."""
    return 'memory' if isinstance(content,str) and INFERRED.search(content) else None


def tool_read(row):
    """The read token of a stored tool result, by its tool's name, or None for a tool that is not an outside read. A row
    without a tool name, as an older schema stores it, is another tool."""
    name=row.get('tool_name')
    if name==TASKS:return task_read(row.get('content'))
    if name==RECALL:return recall_read(row.get('content'))
    return None if name in NOT_READS else TOOL_READS.get(name,'other')


# What "Do what I ask" counts as reaching a turn besides the owner's typed words (ADR-0293): every read token above but a
# command's own output, and Nocheh's word about a message it was asked to send or a time zone it was asked to set,
# which says only what became of that request.
GATE_IGNORED=frozenset({'mcp__nocheh__shell','mcp__nocheh__action_request','mcp__nocheh__my_time_zone'})
# A voice note's or audio file's transcript in a stored message: words that were not typed.
TRANSCRIPT='[Derived voice transcript'
# A message or answer withheld from the session because its source was retired: what the turn read for it is gone.
RETIRED=('[Retired message: ','[Retired reply: ')
# What carried messages read in the session they came from, by the session they were carried into (ADR-0293). A carry
# keeps typed messages and answers but drops tool results, so an answer that repeats a page would read clean without it.
CARRIED_READS='nocheh-carried-reads.json'
CARRIED_SESSIONS=200


def gate_read(name,content):
    """The read token a tool result counts as for "Do what I ask" (ADR-0293), or None: tool_read's, except for a
    command's own output and the tools in GATE_IGNORED. A task list counts whoever's chat it is: in the owner's chat it
    holds what members and groups wrote too."""
    if name in GATE_IGNORED:return None
    if name==TASKS:return 'archive'
    token=tool_read({'tool_name':name,'content':content})
    return None if token=='commands' else token


def rows_reads(rows):
    """The read tokens a session's stored rows hold (ADR-0293): the lines Nocheh puts in a message, a transcript, a
    reply to anything but the owner's own typed message, a retired message, every tool result gate_read counts, and a
    compaction's summary, which may hold any of them."""
    from .retired_history import _summary
    from .turn_process import REPLY_BY
    reads=[]
    def add(token):
        if token not in reads:reads.append(token)
    for row in rows:
        content=row.get('content') if isinstance(row.get('content'),str) else None
        if _summary({**row,'content':row.get('content')}):add('past');continue
        if content is not None and any(marker in content for marker in RETIRED):add('other')
        if row.get('role')=='user' and content is not None:
            for marker,token in MARKERS:
                if marker in content and (token!='forward' or _forwards(content)):add(token)
            if TRANSCRIPT in content:add('file')
            if any(by!='owner' for by in REPLY_BY.findall(content)):add('reply')
        elif row.get('role')=='tool':
            token=gate_read(row.get('tool_name'),row.get('content'))
            if token:add(token)
    return reads


def carried_reads(profile,session):
    """What the messages carried into `session` read where they came from, or None when the record cannot be read."""
    path=Path(profile)/CARRIED_READS
    if not path.exists() and not path.is_symlink():return []
    try:
        if path.is_symlink():raise ValueError('carried_reads_path_denied')
        value=json.loads(path.read_text(encoding='utf-8'))
        sessions=value.get('sessions') if isinstance(value,dict) and value.get('version')==1 else None
        if not isinstance(sessions,dict):raise ValueError('carried_reads_invalid')
        reads=sessions.get(session,[])
        if not isinstance(reads,list) or not all(token in READS for token in reads):raise ValueError('carried_reads_invalid')
        return reads
    except (OSError,ValueError):return None


def record_carried(profile,session,reads):
    """Keep what messages carried into `session` read, added to what it already holds. Raises when it cannot, so the
    messages are not carried without it."""
    from .native_memory import save_receipt
    path=Path(profile)/CARRIED_READS
    if path.is_symlink():raise ValueError('carried_reads_path_denied')
    known=[] if not path.exists() else carried_reads(profile,session)
    if known is None:raise ValueError('carried_reads_invalid')
    try:sessions=json.loads(path.read_text(encoding='utf-8'))['sessions'] if path.exists() else {}
    except (OSError,ValueError,KeyError,TypeError) as failure:raise ValueError('carried_reads_invalid') from failure
    merged=known+[token for token in dict.fromkeys(reads) if token not in known]
    sessions.pop(session,None);sessions[session]=merged
    sessions=dict(list(sessions.items())[-CARRIED_SESSIONS:])
    save_receipt(path,json.dumps({'version':1,'sessions':sessions},ensure_ascii=False,separators=(',',':')))


def carry_reads(profile,session,source_profile,previous,rows):
    """Record what the rows a carry reads from (`rows`, tool results included) and what was carried into `previous`
    read, for `session` (ADR-0293)."""
    inherited=carried_reads(source_profile,previous)
    if inherited is None:inherited=['past']
    reads=inherited+[token for token in rows_reads(rows) if token not in inherited]
    if reads:record_carried(profile,session,reads)


def conversation_reads(database,session,body,profile=None):
    """What reaches a turn besides the owner's typed words before its model starts, as read tokens (ADR-0293): in the
    message it answers, a forward of someone else's, any file, voice note or audio file, other people's recent group
    messages and a reply to anything but the owner's own typed message; anywhere in the session it runs in, what
    rows_reads finds; and what messages carried into it read where they came from (`profile`'s record). None when the
    session or that record could not be read, so the turn stays unreported and a command in it asks first."""
    from .retired_history import _columns,_read_only
    from .turn_process import forwarded,recent_group,reply_block
    reads=[]
    def add(token):
        if token not in reads:reads.append(token)
    if forwarded(body.get('forwarded')) and body['forwarded'] not in OWN_FORWARDS:add('forward')
    if body.get('files') or body.get('transcripts'):add('file')
    if recent_group(body.get('recent_group')):add('recent')
    if reply_block(body.get('reply')) and body['reply']['by']!='owner':add('reply')
    if profile is not None:
        carried=carried_reads(profile,session)
        if carried is None:return None
        for token in carried:add(token)
    database=Path(database)
    if not database.is_file():return reads
    try:
        connection=_read_only(database)
        try:
            available=_columns(connection,'messages')
            if not available:return reads
            selected=['role','content']+[name for name in ('tool_name','_compressed_summary') if name in available]
            connection.row_factory=sqlite3.Row
            rows=[dict(row) for row in connection.execute('SELECT '+','.join(selected)+' FROM messages WHERE session_id=? ORDER BY id',(session,))]
        finally:connection.close()
    except sqlite3.Error:return None
    for token in rows_reads(rows):add(token)
    return reads


def _forwards(text):
    """Whether a stored message holds a forwarded line other than the owner's forward of their own earlier message. A
    sender's own earlier message elsewhere may be a member's words, so it counts."""
    start=text.find('[Forwarded: ')
    while start>=0:
        if not text.startswith(OWN_FORWARDS[0],start):return True
        start=text.find('[Forwarded: ',start+1)
    return False


def _others(text):
    """Whether a stored message holds a group message someone other than the owner sent."""
    return any(line.startswith(SPEAKER) and not line.endswith(OWNER_SPEAKER) for line in text.split('\n'))


def _replied(content):
    """The texts of the replied-to blocks in a stored message whose by= is not the owner's, read where plan() reads them:
    in the frame Nocheh writes before the message's own text (retired_history._spans). The by= stands before any name,
    so no name changes it, and a recent message's reply part holds no text, so it is never one."""
    from .retired_history import REPLY,_spans
    lines=content.split('\n') if isinstance(content,str) else []
    return ['\n'.join(lines[start+1:end]) for kind,_,start,end in _spans(content)
            if kind=='reply' and REPLY.fullmatch(lines[start]) and not lines[start].startswith('[Replying to, by=owner:')]


def _written(ops):
    """What a run's memory operations wrote, as the copy check reads it: the runs of RUN characters and the distinctive
    tokens of each text, and each text whole (_reply_copied)."""
    runs,tokens,plains=set(),set(),[]
    for op in ops:
        if isinstance(op.get('content'),str):
            plain=_plain(op['content']);runs|=_runs(plain);tokens|=_tokens(plain);plains.append(plain)
    return runs,tokens,plains


def _copied(text,written):
    """Whether a stored message shares a run of RUN characters or a distinctive token with what a run wrote, as
    inheritance tells a note's text carried forward. A long message is read once: its runs are looked up in the
    written ones, and the written tokens are looked for in it, never the other way round."""
    runs,tokens=written[0],written[1]
    if not isinstance(text,str) or not runs and not tokens:return False
    plain=_plain(text)
    return any(token in plain for token in tokens) or any(plain[start:start+RUN] in runs for start in range(len(plain)-RUN+1))


def _reply_copied(text,written):
    """_copied for a replied-to block's text, which is at most 200 characters and often shorter than a run: a text of
    at least SHORT_COPY characters that a note holds whole counts as copied too."""
    if _copied(text,written):return True
    plain=_plain(text) if isinstance(text,str) else ''
    return SHORT_COPY<=len(plain)<RUN and any(plain in written_plain for written_plain in written[2])


def turn_reads(database,session,last,body,context=None):
    """What a turn read besides the message it answered, as read tokens, the memory operations it asked for, and whether
    its stored rows could be read: the forward, files and recent group messages it was given; the tools it called
    before its last memory call; the forwards, files and recent group messages earlier in its session since the last
    compaction; and, from there too, a tool result or another person's group message that what the turn wrote copies
    a run of text or a distinctive token from. An earlier read the turn did not copy from leaves its notes alone, so a
    note the owner dictates later in a long session stays the turn's own; a full paraphrase escapes, as in a review.
    A forward of the sender's own earlier message in the message it answered is their own words, not a read; earlier in
    the session only the owner's is (OWN_FORWARDS).

    The message the turn's own message replies to is a read too, unless the owner typed it: Nocheh's own message
    counts, since it may carry what others said. Earlier in the session such a block counts only when what the turn
    wrote copies from its text (_replied), as other people's recent messages do, or, for a text shorter than a run,
    holds it whole (_reply_copied).

    The long-term memory context the turn was given before it started (`context`, as the turn's process read it) holds
    what memory learned from everyone in the owner's chats, so it is a read too when what the turn wrote copies from it,
    as earlier reads are."""
    from .retired_history import _columns,_read_only,_summary,memory_ops
    from .turn_process import forwarded,recent_group,reply_block
    reads=[]
    def add(token):
        if token not in reads:reads.append(token)
    if forwarded(body.get('forwarded')) and body['forwarded'] not in OWN_FORWARDS:add('forward')
    if body.get('files'):add('file')
    if recent_group(body.get('recent_group')):add('recent')
    if reply_block(body.get('reply')) and body['reply']['by']!='owner':add('reply')
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
    if isinstance(context,str) and _copied(context,written):add('memory')
    start=max((index+1 for index,row in enumerate(earlier) if _summary(row)),default=0)
    for row in earlier[start:]:
        content=row['content'] if isinstance(row['content'],str) else None
        if row['role']=='user' and content is not None:
            for marker,token in MARKERS:
                if marker in content and (token!='forward' or _forwards(content)):add(token)
            if 'recent' not in reads and _others(content) and _copied(content,written):add('recent')
            if 'reply' not in reads and any(_reply_copied(text,written) for text in _replied(content)):add('reply')
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


def before(profile,space=None,database=None,turn_event=None):
    """The notes before a run, read under the notes lock, the newest stored message, and the labels the run shows its
    notes with; a turn's (`turn_event`) carry each note's ref. A run whose notes could not be read under the lock records
    nothing after it."""
    with held(profile) as locked:
        found=entries(profile)
        last=last_message(database) if database is not None else None
    if not locked:failed('lock')
    labels=lookup(profile,found,space if space is not None else space_of(profile),turn_event=turn_event) if found is not None else {}
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
    """A turn's origin: the message it answered, its channel, its UTC day and its moment (at_time, Unix seconds), which
    storage shows as a day in the reader's zone, and what it read."""
    channel=body.get('channel','telegram');event=body.get('event_id')
    if channel not in CHANNELS or not isinstance(event,str) or not FULL.fullmatch(event):return {'by':'unknown'}
    moment=int(now or time.time())
    return {'by':'turn','event':event,'channel':channel,'at':datetime.fromtimestamp(moment,timezone.utc).strftime('%Y-%m-%d'),'at_time':moment,
            'reads':[read for read in reads if read in READS][:12],'complete':bool(complete)}


def after_turn(profile,body,session,watch,result,context=None):
    """Record the notes a turn wrote, with what it read; reads it could not read in full are incomplete. A turn whose
    stored messages could not be read counts once, when it added or changed a note, whose label that made less exact.
    `context`: the long-term memory context the turn read before it started."""
    try:
        from .isolated_profile import database_path
        reads,ops,ok=turn_reads(database_path(profile),session,watch['last'],body,context)
    except Exception:
        reads,ops,ok=[],None,False
    complete=ok and isinstance(result,dict) and result.get('state')=='done'
    recorded=after(profile,watch,turn_origin(body,reads,complete),ops)
    if not ok and recorded:failed('read')
    return recorded
