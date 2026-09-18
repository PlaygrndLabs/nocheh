"""Versioned derivative transfer through the owner API; no runtime activation."""
import json
import re
import sqlite3
import tempfile
import urllib.error
from pathlib import Path
from urllib.parse import urlencode
from .archive import file_digest


def export_derivatives(api,directory):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=False,mode=0o700)
    types=api.call('/v1/exports/derivatives/types')
    if types.get('format')!='nocheh-derivatives-v1' or not isinstance(types.get('types'),list):raise ValueError('derivative_format_unsupported')
    kinds=types['types']
    if len(kinds)!=len(set(kinds)) or any(not re.fullmatch('[a-z_]+',kind) for kind in kinds):raise ValueError('derivative_types_invalid')
    manifest={'format':'nocheh-derivatives-v1','complete':False,'records':0,'types':kinds,'automatic_activation':False}
    metadata=directory/'manifest.json';metadata.write_text(json.dumps(manifest,indent=2)+'\n');metadata.chmod(0o600)
    records=directory/'records.ndjson'
    with records.open('w') as output:
        records.chmod(0o600)
        for kind in [*kinds,None]:
            after=''
            while True:
                route='/v1/exports/derivative-history' if kind is None else '/v1/exports/derivatives'
                query={'after':after,'limit':20}
                if kind is not None:query['type']=kind
                page=api.call(route+'?'+urlencode(query))
                expected='nocheh-derivative-history-v1' if kind is None else 'nocheh-derivatives-v1'
                if page.get('format')!=expected:raise ValueError('derivative_format_unsupported')
                for record in page['records']:
                    if record.get('format')!='nocheh-derivative-record-v1' or record.get('type') not in kinds:raise ValueError('derivative_record_invalid')
                    output.write(json.dumps(record,ensure_ascii=False,separators=(',',':'))+'\n');manifest['records']+=1
                cursor=page.get('next')
                if cursor is None:break
                if not isinstance(cursor,str) or not cursor or len(cursor)>1024 or cursor==after:raise ValueError('derivative_cursor_invalid')
                after=cursor
    manifest.update(complete=True,records_sha256=file_digest(records))
    metadata.write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest


def validate_derivatives(directory):
    directory=Path(directory);metadata=directory/'manifest.json';records=directory/'records.ndjson'
    if metadata.is_symlink() or records.is_symlink():raise ValueError('derivative_path_denied')
    manifest=json.loads(metadata.read_text())
    if manifest.get('format')!='nocheh-derivatives-v1' or manifest.get('complete') is not True:raise ValueError('incomplete_derivative_export')
    if file_digest(records)!=manifest.get('records_sha256'):raise ValueError('derivative_records_integrity_failed')
    kinds=manifest.get('types')
    if not isinstance(kinds,list) or len(kinds)!=len(set(kinds)) or any(not re.fullmatch('[a-z_]+',kind) for kind in kinds):raise ValueError('derivative_types_invalid')
    count=0
    with records.open('rb') as source:
        while line:=source.readline(72*1024*1024+1):
            if len(line)>72*1024*1024:raise ValueError('derivative_record_too_large')
            record=json.loads(line);count+=1
            if record.get('format')!='nocheh-derivative-record-v1' or record.get('type') not in kinds or not isinstance(record.get('value'),dict) or not isinstance(record.get('key'),str) or not re.fullmatch('[a-f0-9]{64}',str(record.get('sha256',''))):raise ValueError('derivative_record_invalid')
    if count!=manifest.get('records'):raise ValueError('derivative_record_count_mismatch')
    return manifest


def import_derivatives(api,directory):
    """Index offsets, not payloads, so large histories do not fill Python memory.

    Immutable parents precede children; a cycle/missing parent cannot be silently
    accepted. Owner API retries are idempotent and retain conflicting history.
    """
    directory=Path(directory);manifest=validate_derivatives(directory)
    available=api.call('/v1/exports/derivatives/types')
    if available.get('format')!='nocheh-derivatives-v1' or any(kind not in available.get('types',[]) for kind in manifest['types']):raise ValueError('derivative_format_unsupported')
    with tempfile.TemporaryDirectory(prefix='nocheh-portable-index-') as temporary:
        index=sqlite3.connect(Path(temporary)/'index.sqlite')
        try:
            index.execute('CREATE TABLE records(hash text PRIMARY KEY,kind text NOT NULL,offset integer NOT NULL,size integer NOT NULL,done integer NOT NULL DEFAULT 0)')
            with (directory/'records.ndjson').open('rb') as source:
                while True:
                    offset=source.tell();line=source.readline()
                    if not line:break
                    record=json.loads(line)
                    previous=index.execute('SELECT offset,size FROM records WHERE hash=?',(record['sha256'],)).fetchone()
                    if previous:
                        position=source.tell();source.seek(previous[0]);old=json.loads(source.read(previous[1]));source.seek(position)
                        if old!=record:raise ValueError('derivative_record_identity_conflict')
                    index.execute('INSERT OR IGNORE INTO records(hash,kind,offset,size) VALUES(?,?,?,?)',(record['sha256'],record['type'],offset,len(line)))
                index.commit()
                for kind in available['types']:
                    while index.execute('SELECT 1 FROM records WHERE kind=? AND done=0 LIMIT 1',(kind,)).fetchone():
                        progress=0;cursor=-1
                        while True:
                            batch=index.execute('SELECT hash,offset,size FROM records WHERE kind=? AND done=0 AND offset>? ORDER BY offset LIMIT 100',(kind,cursor)).fetchall()
                            if not batch:break
                            for checksum,offset,size in batch:
                                cursor=offset;source.seek(offset);record=json.loads(source.read(size))
                                try:api.call('/v1/imports/derivatives',{'records':[record]})
                                except urllib.error.HTTPError as error:
                                    try:code=json.loads(error.read(65536)).get('error')
                                    except (ValueError,AttributeError):code=None
                                    if kind=='derived_artifacts' and error.code==409 and code=='portable_parent_pending':continue
                                    raise RuntimeError('derivative_import_failed:'+str(code or error.code)) from None
                                index.execute('UPDATE records SET done=1 WHERE hash=?',(checksum,));progress+=1
                            index.commit()
                        if not progress:raise ValueError('derivative_parents_missing_or_cyclic')
                # Heads may precede their history during transfer; verify every
                # declaration after all immutable records have been restored.
                cursor=-1;verified=0
                while True:
                    batch=index.execute('SELECT offset,size FROM records WHERE offset>? ORDER BY offset LIMIT 100',(cursor,)).fetchall()
                    if not batch:break
                    for offset,size in batch:
                        cursor=offset;source.seek(offset);record=json.loads(source.read(size))
                        api.call('/v1/imports/derivatives/verify',{'records':[record]});verified+=1
            return {'imported':verified,'automatic_activation':False}
        finally:index.close()


def validate_references(directory,archive):
    """A complete bundle must contain every declared parent and active revision.

    Paginated exports are not a recovery snapshot. Concurrent append/head changes
    may produce a missing parent; reject that candidate before publishing it as
    complete instead of emitting a package which cannot be restored.
    """
    with tempfile.TemporaryDirectory(prefix='nocheh-portable-refs-') as temporary:
        index=sqlite3.connect(Path(temporary)/'references.sqlite')
        try:
            index.execute('CREATE TABLE refs(kind text,key text,PRIMARY KEY(kind,key))')
            index.execute('CREATE TABLE revisions(kind text,key text,revision integer,PRIMARY KEY(kind,key,revision))')
            def add(kind,key):
                if not isinstance(key,str) or not key:raise ValueError('portable_reference_invalid')
                index.execute('INSERT OR IGNORE INTO refs VALUES(?,?)',(kind,key))
            with (Path(archive)/'events.ndjson').open() as source:
                for line in source:
                    record=json.loads(line);add('events',record['id'])
                    for artifact in record['artifacts']:add('artifacts',artifact['id'])
            with (Path(directory)/'records.ndjson').open() as source:
                for line in source:
                    record=json.loads(line);kind=record['type'];value=record['value'];add(kind,record['key'])
                    parent={'guard_revisions':'source_id','derivative_selection_revisions':'selection_id','learned_versions':'entry_id'}.get(kind)
                    if parent:
                        index.execute('INSERT OR IGNORE INTO revisions VALUES(?,?,?)',(kind,value.get(parent),value.get('revision')))
                    if kind=='guard_revisions':add('guard_revision_operations',value['operation_id'])
            index.commit()
            def require(kind,key):
                if not isinstance(key,str) or not index.execute('SELECT 1 FROM refs WHERE kind=? AND key=?',(kind,key)).fetchone():raise ValueError('portable_reference_incomplete')
            with (Path(directory)/'records.ndjson').open() as source:
                for line in source:
                    record=json.loads(line);kind=record['type'];value=record['value']
                    if kind=='derived_artifacts':
                        if value.get('event_id') is not None:require('events',value['event_id'])
                        else:require('content_operations',(value.get('operation_reference') or {}).get('id'))
                        if value.get('artifact_id') is not None:require('artifacts',value['artifact_id'])
                        for parent in value.get('provenance',{}).get('parents',[]):require('derived_artifacts',parent.get('id'))
                    elif kind=='guard_sources':
                        require(value.get('kind'),value.get('source_id'))
                        if value.get('event_id') is not None:require('events',value['event_id'])
                    elif kind=='guard_revisions':require('guard_sources',value.get('source_id'))
                    elif kind=='guard_activations':require('guard_revision_operations',value.get('operation_id'))
                    elif kind=='derivative_selections':
                        require('events',value.get('event_id'))
                        if value.get('artifact_id') is not None:require('artifacts',value['artifact_id'])
                    elif kind=='derivative_selection_revisions':
                        require('derivative_selections',value.get('selection_id'));require('derived_artifacts',value.get('derived_id'))
                    elif kind=='derivative_activations':require('derivative_selection_revisions',value.get('operation_id'))
                    elif kind=='learned_versions':
                        require('learned_entries',value.get('entry_id'));require('derived_artifacts',value.get('derived_id'))
                        for evidence in value.get('evidence',[]):require('events',evidence.get('id'))
                    elif kind=='learned_activations':require('learned_versions',value.get('operation_id'))
                    revision_kind={'guard_sources':'guard_revisions','derivative_selections':'derivative_selection_revisions','learned_entries':'learned_versions'}.get(kind)
                    if revision_kind and value.get('active_revision') is not None:
                        if not index.execute('SELECT 1 FROM revisions WHERE kind=? AND key=? AND revision=?',(revision_kind,record['key'],value['active_revision'])).fetchone():raise ValueError('portable_history_incomplete')
        finally:index.close()
