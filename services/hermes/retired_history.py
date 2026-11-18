"""Retired Telegram sources leave the native Hermes history that turns can read.

Hermes keeps its own copy of every turn in the profile's ``state.db`` and
rereads it from several native paths (history replay, compression, session
search), so the stored rows are withheld rather than one read path filtered.
Archive originals are unchanged. Restoring a message makes it available to
retrieval again; the withheld native copy is not rebuilt.

A Telegram turn's stored user row ends with its archive source marker. The
rows after it, until the next user row, are that turn's tool calls, tool
results and answer. A retired message withholds its own row and the turn's
tool work, keeping the delivered answer, which is a separate source. A
retired message the row quotes in Nocheh's own frame before the message's
text (a recent group message or the message the turn replies to) is withheld
from the row the same way: its text goes, and so do the turn's tool work and
the notes written from it, while the row's own text and the delivered answer
stay. A retired delivered answer withholds everything the turn produced. Any other
row that cites a retired source is withheld too, as are compaction summaries
written after the earliest newly withheld row. A withheld row keeps its place
and says which retired message or reply caused it, by archive event ID.

A record of long-term memory a turn read (a recall's answer or facts, or a
fact opened from one) rests on the messages it was learned from. Storage
reports such a record as retired when any of them is (``retired_records``),
so a row that cites the record is withheld as one that cites the message
would be, and its notice names the record by its memory ID.

Hermes native notes (``MEMORY.md``, ``USER.md`` and Hermes' drift backups of
them) are a third copy. An entry is removed when it cites a retired source or
a turn whose delivered answer is retired, or when it is exactly the text a
withheld turn's memory tool call wrote.
"""
import fcntl
import json
import os
import re
import sqlite3
import tempfile
from pathlib import Path

# A retired message's row keeps its event ID in the notice, so later checks still find its turn.
MARKER=re.compile(r'\[(?:Archive source|Retired message): nocheh:event:([a-f0-9]{64})\]')
IDENTIFIER=re.compile(r'(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])')
COMPACTION=('[CONTEXT COMPACTION','[CONTEXT SUMMARY]:')
USER_WITHHELD='[Retired message: {}]'
ANSWER_WITHHELD='[Retired reply: {}]'
CITING_WITHHELD='[Reply withheld; it used a retired source: {}]'
TOOL_WITHHELD='[Tool result withheld; its source was retired: {}]'
QUOTE_WITHHELD='[Quoted message withheld; it was retired: nocheh:event:{}]'
SUMMARY_WITHHELD='[Earlier conversation summary withheld; it may include a retired message.]'
# Every other stored copy of a withheld row's text or the model's reasoning about it.
DERIVED=('api_content','reasoning','reasoning_content','reasoning_details','codex_reasoning_items','codex_message_items','display_metadata')
# Kept in Hermes's own key/value table so it travels and commits with the rows it describes. The value is the retirement
# revision a profile was brought current at, after the version of the rules that did it: a profile checked by older
# rules is planned again once, at the same revision, so a change in what the rules withhold reaches what is already
# stored (ADR-0261: quoted messages retired before that change).
CHECKED_KEY='nocheh_retired_history_revision'
PLAN_VERSION='quoted1'
# A patched span shorter than this would mark unrelated note entries.
SPAN_MINIMUM=4
LOOKUP_BATCH=200
# Hermes' MemoryStore files and their entry delimiter (tools/memory_tool_store.py).
NOTE_FILES=('MEMORY.md','USER.md')
NOTE_DELIMITER='\n§\n'
# The lines of the frame turn_process.py writes before a message's own text. Member text in it reads every opening
# bracket of these words as a parenthesis (turn_process.unframed), so none of these lines comes from what someone wrote.
RECENT_START,RECENT_END='[Recent messages in this group','[End of recent messages]'
SPEAKER='[Group message from '
ITEM=re.compile(r'\[Group message from .*\] \(source nocheh:event:([a-f0-9]{64})\)')
# A quoted message withheld before, which a later withholding of the item around it keeps, so the row still names it.
QUOTE_NOTICE=re.compile(r'\[Quoted message withheld; it was retired: nocheh:event:[a-f0-9]{64}\]')
# A link archive_page adds to a reply whose message is not on the page (ADR-0261), as its JSON result writes it: the
# id is no text the page holds, so it alone makes no tool result cite that message. Inside a message's text in that
# JSON its quotes would be escaped, so no one can write it there.
REPLY_SOURCE=re.compile(r'(?<=[{,])"reply_source":"nocheh:event:[a-f0-9]{64}"')
PART=re.compile(r'\[In reply to, by=[a-z]+: .*\] \(source nocheh:event:([a-f0-9]{64})\)')
REPLY=re.compile(r'\[Replying to, by=[a-z]+: .*\] \(source nocheh:event:([a-f0-9]{64})\)')
REPLY_END='[End of replied-to message]'


def service_lookup(event_ids):
    """Ask storage which recorded turns are retired; only the service token may ask."""
    from urllib.request import Request,urlopen
    from .environment import secret
    request=Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/internal/sources/retired',
        data=json.dumps({'event_ids':list(event_ids)}).encode(),
        headers={'Authorization':'Bearer '+secret('SERVICE_TOKEN'),'Content-Type':'application/json'})
    with urlopen(request,timeout=15) as response:value=json.loads(response.read(1024*1024))
    if (not isinstance(value,dict) or not isinstance(value.get('revision'),str) or not isinstance(value.get('retired'),list)
            or not isinstance(value.get('answered'),dict) or any(not isinstance(replies,list) for replies in value['answered'].values())
            or not isinstance(value.get('retired_records',[]),list)):
        raise RuntimeError('retired_history_unavailable')
    return value


def _columns(connection,table):
    return {row[1] for row in connection.execute('PRAGMA table_info('+table+')')}


def _summary(row):
    return bool(row.get('_compressed_summary')) or isinstance(row['content'],str) and row['content'].lstrip().startswith(COMPACTION)


def _turns(rows):
    """Group each session's rows into [event ID, user row, following rows]."""
    turns=[];session=object()
    for row in rows:
        if row['session_id']!=session:
            session=row['session_id'];turns.append([None,None,[]])
        if row['role']=='user' and not _summary(row):
            found=MARKER.findall(row['content'] if isinstance(row['content'],str) else '')
            turns.append([found[-1] if found else None,row,[]])
        else:turns[-1][2].append(row)
    return turns


def _cites(row):
    return set(IDENTIFIER.findall(REPLY_SOURCE.sub('',' '.join(str(row.get(key) or '') for key in ('content','tool_calls','api_content')))))


def _sources(event_ids,records=frozenset()):
    """The retired sources a notice names: archive events by their event ID, records of long-term memory by their memory ID."""
    return ', '.join(('nocheh:memory:' if event in records else 'nocheh:event:')+event for event in sorted(event_ids))


def _spans(content):
    """The messages a stored user row quotes, as (kind, event ID, first line, last line): a recent group message
    ('item', with its own reply part), a recent message's reply part ('part', one line without text) or the message
    the turn replies to ('reply'). Only the frame Nocheh writes before the message's own text is read, in its fixed
    order, and never past the turn's own archive source marker: a private answer's first line (skipped), the recent
    messages block, the speaker line, then the replied-to block right after it (first in a row without one). Nothing
    after the message's own text starts is read, and a block without its end line is no span."""
    found=list(MARKER.finditer(content)) if isinstance(content,str) else []
    if not found:return []
    # A private answer's row ends with its own marker and its question's, one line apart, and starts with the line the
    # owner's template wrote (turn_process.py); its frame starts at the recent messages or the speaker line.
    answer=len(found)>1 and content[found[-2].end():found[-1].start()]=='\n'
    lines=content[:found[-1].start()].split('\n');spans=[];at=0
    if answer:at=next((n for n,line in enumerate(lines) if line.startswith((RECENT_START,SPEAKER))),len(lines))
    if at<len(lines) and lines[at].startswith(RECENT_START):
        end=next((n for n in range(at+1,len(lines)) if lines[n]==RECENT_END),None)
        if end is None:return []
        items=[n for n in range(at+1,end) if ITEM.fullmatch(lines[n])]
        for index,start in enumerate(items):
            last=(items[index+1] if index+1<len(items) else end)-1
            while last>start and not lines[last]:last-=1
            spans.append(('item',ITEM.fullmatch(lines[start]).group(1),start,last))
            part=PART.fullmatch(lines[start+1]) if start<last else None
            if part:spans.append(('part',part.group(1),start+1,start+1))
        at=end+1
        while at<len(lines) and not lines[at]:at+=1
    if at<len(lines) and lines[at].startswith(SPEAKER):at+=1
    reply=REPLY.fullmatch(lines[at]) if at<len(lines) else None
    end=next((n for n in range(at+1,len(lines)) if lines[n]==REPLY_END),None) if reply else None
    if end is not None:spans.append(('reply',reply.group(1),at,end))
    return spans


def _unquoted(content,retired):
    """The row with each retired message it quotes replaced by a notice, and the retired messages whose text it held.
    A recent message's reply part held no text, so a retired one changes only its own line; a retired recent message
    takes its reply part with it."""
    spans=[span for span in _spans(content) if span[1] in retired]
    withheld=[(start,end) for kind,_,start,end in spans if kind=='item']
    spans=[span for span in spans if span[0]!='part' or not any(start<=span[2]<=end for start,end in withheld)]
    if not spans:return content,set()
    # The same lines _spans read: everything before the turn's own marker, which stays as it is. A notice for a message
    # withheld before stays inside the item that now goes, so the row keeps naming every retired message it quoted.
    limit=list(MARKER.finditer(content))[-1].start();lines=content[:limit].split('\n')
    for kind,event,start,end in sorted(spans,key=lambda span:-span[2]):
        lines[start:end+1]=[QUOTE_WITHHELD.format(event)]+[line for line in lines[start+1:end+1] if QUOTE_NOTICE.fullmatch(line)]
    return '\n'.join(lines)+content[limit:],{event for kind,event,_,_ in spans if kind!='part'}


def _withhold(row,content):
    change={key:None for key in DERIVED if key in row and row[key] is not None}
    if row['content']!=content:change['content']=content
    if row.get('tool_calls'):
        try:calls=json.loads(row['tool_calls'])
        except ValueError:calls=[]
        cleared=[{**call,'function':{**call['function'],'arguments':'{}'}} if isinstance(call,dict) and isinstance(call.get('function'),dict) else call
                 for call in calls if isinstance(call,dict)]
        value=json.dumps(cleared,ensure_ascii=False)
        if value!=row['tool_calls']:change['tool_calls']=value
    return change


def _lookup(lookup,event_ids):
    """Retired and answer-retired events among the given IDs, in bounded batches."""
    revision=lookup([])['revision'] if not event_ids else None
    retired,answered=set(),{}
    ordered=sorted(event_ids)
    for start in range(0,len(ordered),LOOKUP_BATCH):
        value=lookup(ordered[start:start+LOOKUP_BATCH])
        revision=revision or value['revision']
        retired.update(value['retired']);answered.update(value['answered'])
    return revision,retired,answered


def _memory_writes(row):
    """(whole entries, patched spans) that a stored memory tool call wrote, as one top-level change or operations[]."""
    try:calls=json.loads(row.get('tool_calls') or '[]')
    except ValueError:return set(),set()
    written,spans=set(),set()
    for call in calls if isinstance(calls,list) else []:
        function=call.get('function') if isinstance(call,dict) else None
        if not isinstance(function,dict) or function.get('name')!='memory':continue
        try:arguments=json.loads(function.get('arguments') or '{}')
        except (TypeError,ValueError):continue
        if not isinstance(arguments,dict):continue
        # Stored arguments are the model's raw ones; Hermes parses JSON strings (the list or each item) and wraps one object.
        operations=_parsed(arguments.get('operations'))
        operations=[operations] if isinstance(operations,dict) else operations if isinstance(operations,list) else []
        for change in [arguments]+[_parsed(item) for item in operations]:
            if not isinstance(change,dict):continue
            text=change.get('content') or change.get('new_text')
            if not isinstance(text,str) or not text.strip():continue
            # A patch swaps one span and keeps the rest of the entry, so the span marks the entry it landed in.
            if change.get('action')=='patch':spans.add(text.strip())
            elif change.get('action')!='remove':written.add(text.strip())
    return written,spans


def memory_ops(row):
    """The memory operations a stored assistant row's tool calls asked for, one by one (a batch's operations each on
    their own), as {action, target, old_text, content}, from the model's raw arguments as Hermes parses them. Whether
    Hermes carried one out is not known here."""
    calls=_parsed(row.get('tool_calls') or '[]')
    found=[]
    for call in calls if isinstance(calls,list) else []:
        function=call.get('function') if isinstance(call,dict) else None
        if not isinstance(function,dict) or function.get('name')!='memory':continue
        arguments=_parsed(function.get('arguments') or '{}')
        if not isinstance(arguments,dict):continue
        operations=_parsed(arguments.get('operations'))
        operations=[operations] if isinstance(operations,dict) else operations if isinstance(operations,list) else []
        for change in [arguments]+[_parsed(item) for item in operations]:
            if not isinstance(change,dict):continue
            target=change.get('target') or arguments.get('target')
            content=change.get('content') if change.get('content') is not None else change.get('new_text')
            found.append({'action':change.get('action') if isinstance(change.get('action'),str) else None,
                          'target':target if target in ('memory','user') else 'memory',
                          'old_text':change.get('old_text') if isinstance(change.get('old_text'),str) else None,
                          'content':content if isinstance(content,str) else None})
    return found


def _parsed(value):
    if not isinstance(value,str):return value
    try:return json.loads(value)
    except ValueError:return None


def _note_files(notes):
    if notes is None:return []
    notes=Path(notes)
    if notes.is_symlink():raise ValueError('memory_path_denied')
    if not notes.is_dir():return []
    files=[notes/name for name in NOTE_FILES]+sorted(path for name in NOTE_FILES for path in notes.glob(name+'.bak.*'))
    for file in files:
        if file.is_symlink() or file.exists() and not file.resolve().is_relative_to(notes.resolve()):raise ValueError('memory_path_denied')
    return [file for file in files if file.is_file()]


def _note_entries(file):
    with file.open('rb') as source:raw=source.read(1024*1024)
    return [entry for entry in (part.strip() for part in raw.decode('utf-8',errors='replace').split(NOTE_DELIMITER)) if entry]


def note_citations(notes):
    """Event IDs cited by the native notes in one profile's memories folder."""
    cited=set()
    for file in _note_files(notes):
        for entry in _note_entries(file):cited|=set(IDENTIFIER.findall(entry))
    return cited


def withhold_notes(notes,retired,written=(),spans=()):
    """Remove native note entries derived from retired sources; return how many."""
    # A very short span would match unrelated entries; such a patch is left to the entry's own citation (withheld_note).
    removed=0
    for file in _note_files(notes):
        # Hermes' own writers lock this sibling file and replace the note atomically.
        with file.with_name(file.name.split('.bak.')[0]+'.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            entries=_note_entries(file)
            kept=[entry for entry in entries if not set(IDENTIFIER.findall(entry))&retired and not withheld_note(entry,written,spans)]
            if len(kept)==len(entries):continue
            with tempfile.NamedTemporaryFile('w',encoding='utf-8',dir=file.parent,prefix='.mem_',delete=False) as output:
                output.write(NOTE_DELIMITER.join(kept));output.flush();os.fsync(output.fileno())
            os.replace(output.name,file)
            removed+=len(entries)-len(kept)
    return removed


def plan(rows,lookup):
    """Return (revision, {row id: column changes}) without writing anything."""
    revision=lookup([])['revision']
    turns=_turns(rows)
    cited=set()
    for event,user,following in turns:
        if event:cited.add(event)
        if user:cited|={span[1] for span in _spans(user['content'])}
        for row in following:cited|=_cites(row)
    retired,answered,records=set(),{},set()
    ordered=sorted(cited)
    for start in range(0,len(ordered),LOOKUP_BATCH):
        value=lookup(ordered[start:start+LOOKUP_BATCH])
        retired.update(value['retired']);answered.update(value['answered']);records.update(value.get('retired_records') or ())
    changes={}
    def withhold(row,content):
        change=_withhold(row,content)
        if change:changes[row['id']]=change
    def placeholder(row,causes,replies):
        """Name the retired messages or replies that withhold this row."""
        if row['role']=='tool':return TOOL_WITHHELD.format(_sources(causes|replies,records))
        if row.get('tool_calls') and not row['content']:return ''
        return ANSWER_WITHHELD.format(_sources(replies)) if replies else CITING_WITHHELD.format(_sources(causes,records))
    for event,user,following in turns:
        quoted=set();carried=set()
        if event in retired:
            withhold(user,USER_WITHHELD.format(_sources([event])))
        elif user:
            # A retired message the row quoted counts like a retired turn message for the rows after it: the turn's
            # tool work, and with it the notes it wrote, is withheld, and the delivered answer loses only its reasoning.
            content,quoted=_unquoted(user['content'],retired)
            if content!=user['content']:withhold(user,content)
        replies=set(answered.get(event,()))
        answer=next((row for row in reversed(following) if row['role']=='assistant' and not row.get('tool_calls')
                     and isinstance(row['content'],str) and row['content'].strip() and not _summary(row)),None)
        for row in following:
            if _summary(row):continue
            causes=_cites(row)&retired|{event}&retired|quoted|carried
            if replies or causes and (row is not answer or _cites(row)&retired):
                withhold(row,placeholder(row,causes,replies))
                # A tool result that held a retired message's text counts for the rest of the turn as a quoted one
                # does: what the turn copied from it, its notes too, goes with it.
                if row['role']=='tool':carried|=_cites(row)&retired
            elif event in retired or quoted or carried:
                # The delivered answer stays; reasoning about the retired message does not.
                change={key:None for key in DERIVED if key!='api_content' and key in row and row[key] is not None}
                if change:changes[row['id']]=change
    withheld=[row['timestamp'] for row in rows if row['id'] in changes and row['timestamp'] is not None]
    if withheld:
        earliest=min(withheld)
        for row in rows:
            if _summary(row) and row['timestamp'] is not None and row['timestamp']>=earliest:withhold(row,SUMMARY_WITHHELD)
    return revision,changes


def _rows(connection):
    available=_columns(connection,'messages')
    selected=['id','session_id','role','content','timestamp','tool_calls']+[key for key in ('tool_name','_compressed_summary',*DERIVED) if key in available]
    connection.row_factory=sqlite3.Row
    return [dict(row) for row in connection.execute('SELECT '+','.join(selected)+' FROM messages ORDER BY session_id,id')]


def _checked(connection):
    if 'value' not in _columns(connection,'state_meta'):return None
    row=connection.execute('SELECT value FROM state_meta WHERE key=?',(CHECKED_KEY,)).fetchone()
    return row[0] if row else None


def _read_only(database):
    return sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro',uri=True,timeout=30)


def _checked_value(revision):
    return PLAN_VERSION+':'+revision


def pending(database,lookup):
    """What a profile not yet brought current will withhold at its next turn, for a read-only reader to skip now: the
    rows (by id), and the notes the withheld turns wrote, as withhold_notes takes them (whole entries, patched spans).
    Nothing for a profile already current."""
    database=Path(database)
    if not database.is_file():return set(),set(),set()
    connection=_read_only(database)
    try:
        if _checked(connection)==_checked_value(lookup([])['revision']):return set(),set(),set()
        rows=_rows(connection)
    finally:connection.close()
    changes=plan(rows,lookup)[1]
    writes=[_memory_writes(row) for row in rows if 'tool_calls' in changes.get(row['id'],{})]
    return set(changes),set().union(*(entries for entries,_ in writes)),set().union(*(patched for _,patched in writes))


def withheld_ids(database,lookup):
    """Rows a read-only native search must skip in a profile not yet brought current."""
    return pending(database,lookup)[0]


def withheld_note(entry,written,spans):
    """Whether a note entry is one withhold_notes will remove for being what a withheld turn wrote."""
    return entry in written or any(span in entry for span in spans if len(span)>=SPAN_MINIMUM)


def withhold_retired(database,lookup,notes=None):
    """Bring one profile's stored native history and notes current; run only while its turn lock is held."""
    database=Path(database);cited=note_citations(notes)
    if not database.is_file() and not cited:return 0
    # Notes are checked on every turn: a note written after the last check can cite a source retired before it.
    revision,retired,answered=_lookup(lookup,cited)
    removed=withhold_notes(notes,retired|set(answered))
    if not database.is_file():return removed
    connection=_read_only(database)
    try:
        if _checked(connection)==_checked_value(revision):return removed
    finally:connection.close()
    connection=sqlite3.connect(database,timeout=30,isolation_level=None)
    try:
        connection.execute('BEGIN IMMEDIATE')
        try:
            rows=_rows(connection)
            revision,changes=plan(rows,lookup)
            writes=[_memory_writes(row) for row in rows if 'tool_calls' in changes.get(row['id'],{})]
            written=set().union(*(entries for entries,_ in writes));spans=set().union(*(patched for _,patched in writes))
            for row_id,change in changes.items():
                keys=sorted(change)
                connection.execute('UPDATE messages SET '+','.join(key+'=?' for key in keys)+' WHERE id=?',[change[key] for key in keys]+[row_id])
            sessions=sorted({row['session_id'] for row in rows if row['id'] in changes})
            if sessions and {'title','title_source'}<=_columns(connection,'sessions'):
                # Generated titles summarize the transcript; an owner-set title stays.
                connection.execute("UPDATE sessions SET title=NULL,title_source=NULL WHERE id IN ("+','.join('?'*len(sessions))+
                                   ") AND title IS NOT NULL AND coalesce(title_source,'')<>'user'",sessions)
            connection.execute('CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT)')
            connection.execute('INSERT INTO state_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(CHECKED_KEY,_checked_value(revision)))
            # Notes first: if this fails the revision stays unchecked and the next turn retries.
            removed+=withhold_notes(notes,set(),written,spans)
            connection.execute('COMMIT')
        except BaseException:
            connection.execute('ROLLBACK');raise
    finally:connection.close()
    return len(changes)+removed
