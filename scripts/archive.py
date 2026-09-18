#!/usr/bin/env python3
"""Portable archive operations over the authenticated loopback API."""
import argparse
import base64
import hashlib
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def digest(value):
    return hashlib.sha256(value.encode() if isinstance(value,str) else value).hexdigest()


def canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))


def file_digest(path):
    with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()


class API:
    def __init__(self, import_job=None, import_lease=None, import_owner='inngest'):
        state=Path(os.environ.get('NOCHEH_STATE_DIR',ROOT/'data/local'))
        try: from .configuration import load, archive_url
        except ImportError: from configuration import load, archive_url
        config=load(state)
        port=config['NOCHEH_PORT']
        self.url=archive_url(state)
        self.token=config['SERVICE_TOKEN']
        self.storage_layout=config.get('NOCHEH_STORAGE_LAYOUT','legacy')
        self.import_headers={} if import_job is None else {'X-Nocheh-Import-Job':import_job,'X-Nocheh-Import-Owner':import_owner}
        if import_lease is not None:self.import_headers['X-Nocheh-Import-Lease']=import_lease

    def call(self,path,body=None,binary=False,timeout=120):
        req=urllib.request.Request(self.url+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
                                   headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json',**self.import_headers})
        with urllib.request.urlopen(req,timeout=timeout) as response:
            return response.read() if binary else json.load(response)


def message_text(value):
    if isinstance(value,str):
        return value
    if isinstance(value,list):
        result=[]
        for item in value:
            if isinstance(item,str): result.append(item)
            elif isinstance(item,dict) and isinstance(item.get('text'),str): result.append(item['text'])
            else: raise ValueError('unsupported_telegram_text_entity')
        return ''.join(result)
    if value is None: return None
    raise ValueError('unsupported_telegram_text')


def media_path(root,relative):
    if not isinstance(relative,str) or Path(relative).is_absolute():
        raise ValueError('media_path_must_be_relative')
    path=(root/relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('media_path_escapes_export')
    return path


def desktop_records(document,root,scope=None,scope_map=None):
    chats=document.get('chats',{}).get('list') if isinstance(document.get('chats'),dict) else None
    if chats is None: chats=[document]
    if scope is not None and len(chats)!=1: raise ValueError('use_scope_map_for_multiple_chats')
    for chat in chats:
        if 'id' not in chat or not isinstance(chat.get('messages'),list): raise ValueError('expected_telegram_desktop_json')
        chat_id=str(chat['id']); chat_type=str(chat.get('type','unknown'))
        mapped=scope or (scope_map or {}).get(chat_id) or f'desktop:{chat_type}:{chat_id}'
        metadata={k:v for k,v in chat.items() if k!='messages'}
        for message in chat['messages']:
            revision=digest(canonical(message))
            key=f"telegram-desktop:{chat_type}:{chat_id}:{message['id']}:{revision}"
            event_id=digest(key)
            event={'version':1,'key':key,'bot_id':'desktop-export','origin':'import','scope':str(mapped),
                   'kind':'telegram_desktop_'+str(message.get('type','message')),'source_id':str(message['id']),
                   'revision':revision,'occurred_at':str(message.get('date_unixtime',message.get('date'))) if message.get('date') else None,
                   'text':message_text(message.get('text')),'payload':{'chat':metadata,'message':message}}
            artifacts=[]; uploads=[]
            for field in ('photo','file','thumbnail'):
                relative=message.get(field)
                if not isinstance(relative,str): continue
                ref=f'desktop:{field}:{relative}'; artifact_id=digest(f'{event_id}:{ref}')
                # Telegram uses human-readable placeholders when files were excluded.
                path=media_path(root,relative)
                supplied=path.is_file()
                artifact={'id':artifact_id,'source_ref':ref,'kind':str(message.get('media_type',field)),
                          'state':'pending' if supplied else 'failed',
                          'metadata':{'relative_path':relative,'mime_type':message.get('mime_type')}}
                artifacts.append(artifact)
                if supplied: uploads.append((artifact_id,path))
            yield {'event':event,'artifacts':artifacts,'derived':[]},uploads


def upload(api,artifact_id,path,expected=None,source_only=False):
    if path.stat().st_size>50*1024*1024: raise ValueError('attachment_exceeds_50_mib')
    data=path.read_bytes(); checksum=digest(data)
    if expected and checksum!=expected: raise ValueError('artifact_integrity_failed')
    route='original-files' if source_only else 'artifacts'
    api.call(f'/v1/{route}/{artifact_id}/bytes',{'bytes_base64':base64.b64encode(data).decode(),'sha256':checksum})


def export_archive(api,directory,source_only=False):
    directory.mkdir(parents=True,exist_ok=False,mode=0o700)
    (directory/'files').mkdir(mode=0o700)
    manifest={'format':'nocheh-sources-v1' if source_only else 'nocheh-archive-v1','complete':False,'events':0,'files':0}
    if source_only:manifest.update(derivatives_included=False,credentials_included=False,
        consistency='Paginated immutable observations; use coordinated backup for a single recovery point.')
    (directory/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (directory/'manifest.json').chmod(0o600)
    after=''
    with (directory/'events.ndjson').open('w') as output:
        (directory/'events.ndjson').chmod(0o600)
        while True:
            page=api.call(('/v1/exports/sources?' if source_only else '/v1/export?')+urllib.parse.urlencode({'after':after,'limit':20}))
            if source_only and page.get('format')!='nocheh-sources-v1':raise ValueError('unexpected_source_export_format')
            for record in page['records']:
                if source_only and ('derived' in record or 'guarded' in record or record['event']['origin']=='generated'):
                    raise ValueError('original_source_required')
                for artifact in record['artifacts']:
                    if artifact['state']!='ready': continue
                    checksum=artifact['file_hash']
                    if len(checksum)!=64 or any(c not in '0123456789abcdef' for c in checksum): raise ValueError('invalid_file_hash')
                    target=directory/'files'/checksum
                    if not target.exists():
                        route='original-files' if source_only else 'artifacts'
                        data=api.call(f"/v1/{route}/{artifact['id']}/bytes",binary=True)
                        if digest(data)!=checksum: raise ValueError('artifact_integrity_failed')
                        if source_only and len(data)!=artifact['byte_size']:raise ValueError('artifact_size_conflict')
                        target.write_bytes(data); target.chmod(0o600); manifest['files']+=1
                output.write(json.dumps(record,ensure_ascii=False,separators=(',',':'))+'\n'); manifest['events']+=1
            if not page['next']: break
            if source_only and (page['next']==after or len(page['next'])!=64 or any(c not in '0123456789abcdef' for c in page['next'])):
                raise ValueError('invalid_export_cursor')
            after=page['next']
    if source_only:manifest['records_sha256']=file_digest(directory/'events.ndjson')
    manifest['complete']=True
    (directory/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest


def validate_archive(directory,restore_guarded=False):
    directory=Path(directory)
    if directory.is_symlink() or (directory/'manifest.json').is_symlink() or (directory/'events.ndjson').is_symlink():raise ValueError('archive_path_denied')
    manifest=json.loads((directory/'manifest.json').read_text())
    if manifest.get('format') not in ('nocheh-archive-v1','nocheh-sources-v1') or manifest.get('complete') is not True: raise ValueError('incomplete_export')
    source_only=manifest['format']=='nocheh-sources-v1'
    if source_only and restore_guarded:raise ValueError('source_export_has_no_guarded_versions')
    if source_only:
        # Validate the full package before sending any record to an installation.
        if file_digest(directory/'events.ndjson')!=manifest.get('records_sha256'):raise ValueError('source_records_integrity_failed')
        checked=0
        with (directory/'events.ndjson').open() as source:
            for line in source:
                record=json.loads(line);checked+=1
                if 'derived' in record or 'guarded' in record or record['event']['origin']=='generated':raise ValueError('original_source_required')
                for artifact in record['artifacts']:
                    if artifact['state']!='ready':continue
                    checksum=artifact['file_hash']
                    if len(checksum)!=64 or any(c not in '0123456789abcdef' for c in checksum):raise ValueError('invalid_file_hash')
                    file=media_path(directory/'files',checksum)
                    if not file.is_file() or file.stat().st_size>50*1024*1024:raise ValueError('original_file_unavailable')
                    data=file.read_bytes()
                    if digest(data)!=checksum or len(data)!=artifact['byte_size']:raise ValueError('artifact_integrity_failed')
        if checked!=manifest.get('events'):raise ValueError('source_record_count_mismatch')
    return manifest


def import_archive(api,directory,restore_guarded=False):
    directory=Path(directory);manifest=validate_archive(directory,restore_guarded)
    source_only=manifest['format']=='nocheh-sources-v1'
    count=0
    with (directory/'events.ndjson').open() as source:
        for line in source:
            record=json.loads(line)
            api.call('/v1/imports/sources' if source_only else '/v1/import'+('?restore_guarded=true' if restore_guarded else ''),record)
            for artifact in record['artifacts']:
                if artifact['state']=='ready':
                    checksum=artifact['file_hash']
                    if len(checksum)!=64 or any(c not in '0123456789abcdef' for c in checksum): raise ValueError('invalid_file_hash')
                    upload(api,artifact['id'],media_path(directory/'files',checksum),checksum,source_only)
            count+=1
    return {'imported':count,'telegram_replies':0}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    tg=sub.add_parser('import-telegram');tg.add_argument('file',type=Path);tg.add_argument('--scope');tg.add_argument('--scope-map',type=Path)
    tg.add_argument('--approve-memory-review',action='store_true',help='Explicitly approve a private Hermes memory review after successful import.')
    for name in ('export','import'):
        command=sub.add_parser(name);command.add_argument('directory',type=Path)
        if name=='export':command.add_argument('--sources-only',action='store_true')
        if name=='import':command.add_argument('--restore-guarded',action='store_true',help='Trust and restore guarded revision history from your own export; no re-detection.')
    sub.add_parser('replay').add_argument('event_ids',nargs='+')
    args=parser.parse_args();api=API()
    if args.command=='export': result=export_archive(api,args.directory,args.sources_only)
    elif args.command=='import': result=import_archive(api,args.directory,args.restore_guarded)
    elif args.command=='replay': result=api.call('/v1/replay',{'event_ids':args.event_ids})
    else:
        document=json.loads(args.file.read_text());count=missing=0;review_ids=[]
        mapping=json.loads(args.scope_map.read_text()) if args.scope_map else None
        for record,uploads in desktop_records(document,args.file.parent,args.scope,mapping):
            api.call('/v1/import',record)
            review_ids.append(digest(record['event']['key']))
            for artifact_id,path in uploads: upload(api,artifact_id,path)
            count+=1;missing+=sum(a['state']=='failed' for a in record['artifacts'])
        if args.approve_memory_review:
            for start in range(0,len(review_ids),500):api.call('/v1/memory/reviews',{'event_ids':review_ids[start:start+500],'approved':True,'batch':'cli:'+digest(args.file.read_bytes())})
        result={'imported':count,'missing_files':missing,'telegram_replies':0,'review_approved':args.approve_memory_review}
    print(json.dumps(result))


if __name__=='__main__': main()
