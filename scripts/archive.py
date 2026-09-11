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


class API:
    def __init__(self):
        state=Path(os.environ.get('NOCHEH_STATE_DIR',ROOT/'data/local'))
        try: from .configuration import load
        except ImportError: from configuration import load
        config=load(state)
        port=config['NOCHEH_PORT']
        self.url='http://127.0.0.1:'+str(int(port))
        self.token=config['SERVICE_TOKEN']

    def call(self,path,body=None,binary=False,timeout=120):
        req=urllib.request.Request(self.url+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
                                   headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
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


def upload(api,artifact_id,path,expected=None):
    if path.stat().st_size>50*1024*1024: raise ValueError('attachment_exceeds_50_mib')
    data=path.read_bytes(); checksum=digest(data)
    if expected and checksum!=expected: raise ValueError('artifact_integrity_failed')
    api.call(f'/v1/artifacts/{artifact_id}/bytes',{'bytes_base64':base64.b64encode(data).decode(),'sha256':checksum})


def export_archive(api,directory):
    directory.mkdir(parents=True,exist_ok=False)
    (directory/'files').mkdir()
    manifest={'format':'nocheh-archive-v1','complete':False,'events':0,'files':0}
    (directory/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    after=''
    with (directory/'events.ndjson').open('w') as output:
        while True:
            page=api.call('/v1/export?'+urllib.parse.urlencode({'after':after,'limit':20}))
            for record in page['records']:
                for artifact in record['artifacts']:
                    if artifact['state']!='ready': continue
                    checksum=artifact['file_hash']
                    if len(checksum)!=64 or any(c not in '0123456789abcdef' for c in checksum): raise ValueError('invalid_file_hash')
                    target=directory/'files'/checksum
                    if not target.exists():
                        data=api.call(f"/v1/artifacts/{artifact['id']}/bytes",binary=True)
                        if digest(data)!=checksum: raise ValueError('artifact_integrity_failed')
                        target.write_bytes(data); manifest['files']+=1
                output.write(json.dumps(record,ensure_ascii=False,separators=(',',':'))+'\n'); manifest['events']+=1
            if not page['next']: break
            after=page['next']
    manifest['complete']=True
    (directory/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest


def import_archive(api,directory,restore_guarded=False):
    manifest=json.loads((directory/'manifest.json').read_text())
    if manifest.get('format')!='nocheh-archive-v1' or manifest.get('complete') is not True: raise ValueError('incomplete_export')
    count=0
    with (directory/'events.ndjson').open() as source:
        for line in source:
            record=json.loads(line); api.call('/v1/import'+('?restore_guarded=true' if restore_guarded else ''),record)
            for artifact in record['artifacts']:
                if artifact['state']=='ready':
                    checksum=artifact['file_hash']
                    if len(checksum)!=64 or any(c not in '0123456789abcdef' for c in checksum): raise ValueError('invalid_file_hash')
                    upload(api,artifact['id'],media_path(directory/'files',checksum),checksum)
            count+=1
    return {'imported':count,'telegram_replies':0}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    tg=sub.add_parser('import-telegram');tg.add_argument('file',type=Path);tg.add_argument('--scope');tg.add_argument('--scope-map',type=Path)
    tg.add_argument('--approve-memory-review',action='store_true',help='Explicitly approve a private Hermes memory review after successful import.')
    for name in ('export','import'):
        command=sub.add_parser(name);command.add_argument('directory',type=Path)
        if name=='import':command.add_argument('--restore-guarded',action='store_true',help='Trust and restore guarded revision history from your own export; no re-detection.')
    sub.add_parser('replay').add_argument('event_ids',nargs='+')
    args=parser.parse_args();api=API()
    if args.command=='export': result=export_archive(api,args.directory)
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
