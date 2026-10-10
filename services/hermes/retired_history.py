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
retired delivered answer withholds everything the turn produced. Any other
row that cites a retired source is withheld too, as are compaction summaries
written after the earliest newly withheld row.
"""
import json
import os
import re
import sqlite3
from pathlib import Path

MARKER=re.compile(r'\[Archive source: nocheh:event:([a-f0-9]{64})\]')
IDENTIFIER=re.compile(r'(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])')
COMPACTION=('[CONTEXT COMPACTION','[CONTEXT SUMMARY]:')
USER_WITHHELD='[Retired message withheld; its content is unavailable.]'
ANSWER_WITHHELD='[Retired reply withheld; its content is unavailable.]'
TOOL_WITHHELD='[Tool result withheld; it came from a retired message.]'
SUMMARY_WITHHELD='[Earlier conversation summary withheld; it may include a retired message.]'
# Every other stored copy of a withheld row's text or the model's reasoning about it.
DERIVED=('api_content','reasoning','reasoning_content','reasoning_details','codex_reasoning_items','codex_message_items','display_metadata')
# Kept in Hermes's own key/value table so it travels and commits with the rows it describes.
CHECKED_KEY='nocheh_retired_history_revision'
LOOKUP_BATCH=200


def service_lookup(event_ids):
    """Ask storage which recorded turns are retired; only the service token may ask."""
    from urllib.request import Request,urlopen
    from .environment import secret
    request=Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/internal/sources/retired',
        data=json.dumps({'event_ids':list(event_ids)}).encode(),
        headers={'Authorization':'Bearer '+secret('SERVICE_TOKEN'),'Content-Type':'application/json'})
    with urlopen(request,timeout=15) as response:value=json.loads(response.read(1024*1024))
    if (not isinstance(value,dict) or not isinstance(value.get('revision'),str)
            or any(not isinstance(value.get(key),list) for key in ('retired','answered'))):
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
    return set(IDENTIFIER.findall(' '.join(str(row.get(key) or '') for key in ('content','tool_calls','api_content'))))


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


def plan(rows,lookup):
    """Return (revision, {row id: column changes}) without writing anything."""
    revision=lookup([])['revision']
    turns=_turns(rows)
    cited=set()
    for event,user,following in turns:
        if event:cited.add(event)
        for row in following:cited|=_cites(row)
    retired,answered=set(),set()
    ordered=sorted(cited)
    for start in range(0,len(ordered),LOOKUP_BATCH):
        value=lookup(ordered[start:start+LOOKUP_BATCH])
        retired.update(value['retired']);answered.update(value['answered'])
    changes={}
    def withhold(row,content):
        change=_withhold(row,content)
        if change:changes[row['id']]=change
    def placeholder(row):
        if row['role']=='tool':return TOOL_WITHHELD
        return '' if row.get('tool_calls') else ANSWER_WITHHELD
    for event,user,following in turns:
        if event in retired:
            withhold(user,USER_WITHHELD+'\n\n[Archive source: nocheh:event:'+event+']')
        if event in answered:
            for row in following:
                if not _summary(row):withhold(row,placeholder(row))
            continue
        answer=next((row for row in reversed(following) if row['role']=='assistant' and not row.get('tool_calls')
                     and isinstance(row['content'],str) and row['content'].strip() and not _summary(row)),None)
        for row in following:
            if _summary(row):continue
            if event in retired and row is not answer or _cites(row)&retired:
                withhold(row,placeholder(row))
            elif event in retired:
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
    selected=['id','session_id','role','content','timestamp','tool_calls']+[key for key in ('_compressed_summary',*DERIVED) if key in available]
    connection.row_factory=sqlite3.Row
    return [dict(row) for row in connection.execute('SELECT '+','.join(selected)+' FROM messages ORDER BY session_id,id')]


def _checked(connection):
    if 'value' not in _columns(connection,'state_meta'):return None
    row=connection.execute('SELECT value FROM state_meta WHERE key=?',(CHECKED_KEY,)).fetchone()
    return row[0] if row else None


def _read_only(database):
    return sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro',uri=True,timeout=30)


def withheld_ids(database,lookup):
    """Rows a read-only native search must skip in a profile not yet brought current."""
    database=Path(database)
    if not database.is_file():return set()
    connection=_read_only(database)
    try:
        if _checked(connection)==lookup([])['revision']:return set()
        return set(plan(_rows(connection),lookup)[1])
    finally:connection.close()


def withhold_retired(database,lookup):
    """Bring one profile's stored native history current; run only while its turn lock is held."""
    database=Path(database)
    if not database.is_file():return 0
    connection=_read_only(database)
    try:
        if _checked(connection)==lookup([])['revision']:return 0
    finally:connection.close()
    connection=sqlite3.connect(database,timeout=30,isolation_level=None)
    try:
        connection.execute('BEGIN IMMEDIATE')
        try:
            rows=_rows(connection)
            revision,changes=plan(rows,lookup)
            for row_id,change in changes.items():
                keys=sorted(change)
                connection.execute('UPDATE messages SET '+','.join(key+'=?' for key in keys)+' WHERE id=?',[change[key] for key in keys]+[row_id])
            sessions=sorted({row['session_id'] for row in rows if row['id'] in changes})
            if sessions and {'title','title_source'}<=_columns(connection,'sessions'):
                # Generated titles summarize the transcript; an owner-set title stays.
                connection.execute("UPDATE sessions SET title=NULL,title_source=NULL WHERE id IN ("+','.join('?'*len(sessions))+
                                   ") AND title IS NOT NULL AND coalesce(title_source,'')<>'user'",sessions)
            connection.execute('CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT)')
            connection.execute('INSERT INTO state_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(CHECKED_KEY,revision))
            connection.execute('COMMIT')
        except BaseException:
            connection.execute('ROLLBACK');raise
    finally:connection.close()
    return len(changes)
