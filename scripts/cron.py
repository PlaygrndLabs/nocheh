"""Manage native Hermes schedules through the same authenticated owner adapter."""
import argparse,json,uuid
from pathlib import Path
from urllib.parse import urlencode
from .native import call


def main(state,args):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('list','show','create','update','pause','resume','trigger','catch-up','cancel','delete','runs'))
    parser.add_argument('id',nargs='?');parser.add_argument('--profile',default='default')
    parser.add_argument('--file',type=Path);parser.add_argument('--revision');parser.add_argument('--request-id')
    options=parser.parse_args(args);action=options.action
    if action not in ('list','create') and not options.id:parser.error('Provide a job ID.')
    import re
    if options.id and not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}',options.id):parser.error('Invalid job ID.')
    path='/api/cron/jobs'+('/'+options.id if options.id else '')
    if action in ('pause','resume','trigger','catch-up','cancel','runs'):path+='/'+action
    query='?'+urlencode({'profile':options.profile})
    body=None;method='GET'
    if action in ('create','update'):
        if not options.file:parser.error('--file JSON_FILE is required.')
        if options.file.stat().st_size>128*1024:parser.error('Job file is too large.')
        body=json.loads(options.file.read_text())
        if not isinstance(body,dict):parser.error('Job file must contain an object.')
        method='POST' if action=='create' else 'PUT'
        if action=='update':
            current=call(state,path+query)
            body={'updates':{**body,'_nocheh_revision':options.revision or current['_nocheh_revision']}}
    elif action in ('pause','resume','trigger','catch-up','cancel'):
        method='POST';body={'request_id':options.request_id or uuid.uuid4().hex}
    elif action=='delete':method='DELETE';body={}
    result=call(state,path+query,body,method)
    print(json.dumps(result,ensure_ascii=False,indent=2));return 0
