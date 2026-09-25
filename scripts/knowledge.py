"""Owner source versions, learned interpretations, projects and sharing controls."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from .archive import API


def allowed_path(path):
    parsed=urlsplit(path)
    if parsed.scheme or parsed.netloc or parsed.fragment:return False
    return bool(re.fullmatch(r'/v1/(?:projects(?:/assignments|/effective)?|sharing/(?:rules|preview|previews(?:/[a-f0-9]{64}(?:/approve)?)?|releases(?:/[a-f0-9]{64}/revoke)?)|learned(?:/[a-f0-9]{64}(?:/history|/correct)?)?|sources/[a-f0-9]{64}/(?:derivatives|reprocess|prepare|learning-consent|retirement)|derivatives/[a-f0-9]{64}(?:/activate)?|derivation-engines|reprocessing/[a-f0-9]{64}|guards/(?:events|artifacts|derived_artifacts)/[a-f0-9]{64}(?:/history|/revisions/\d+)?|memory/provenance)',parsed.path))


def parse(command,arguments):
    parser=argparse.ArgumentParser(prog='nocheh '+command,description=__doc__)
    commands=parser.add_subparsers(dest='action',required=True)
    def change(name):
        item=commands.add_parser(name);item.add_argument('id');item.add_argument('--revision',type=int,required=True);item.add_argument('--operation-id',required=True);return item
    if command=='sources':
        commands.add_parser('engines')
        for name in ('versions','derivative','job','prepare','learning-consent'):
            item=commands.add_parser(name);item.add_argument('id')
            if name=='versions':item.add_argument('--after',default='')
        item=commands.add_parser('reprocess');item.add_argument('id');item.add_argument('--artifact',required=True);item.add_argument('--input-hash',required=True)
        item.add_argument('--engine',required=True);item.add_argument('--version',required=True);item.add_argument('--configuration',type=Path);item.add_argument('--operation-id',required=True)
        change('activate')
        change('set-learning').add_argument('--enabled',choices=('true','false'),required=True)
        for name in ('guard','guard-history'):
            item=commands.add_parser(name);item.add_argument('kind',choices=('events','artifacts','derived_artifacts'));item.add_argument('id')
        for name in ('edit-guard','restore-guard'):
            item=change(name);item.add_argument('--kind',choices=('events','artifacts','derived_artifacts'),required=True)
            if name=='edit-guard':item.add_argument('--file',type=Path,required=True)
            else:item.add_argument('--from-revision',type=int,required=True)
    elif command=='projects':
        for name in ('list','assignments'):
            commands.add_parser(name).add_argument('--after',default='')
        commands.add_parser('effective').add_argument('--space',required=True)
        for name in ('save','assign'):commands.add_parser(name).add_argument('--file',type=Path,required=True)
    elif command=='learned':
        item=commands.add_parser('list');item.add_argument('--after',default='');item.add_argument('--scope-kind',choices=('conversation','project'));item.add_argument('--scope-id')
        for name in ('show','history'):commands.add_parser(name).add_argument('id')
        change('correct').add_argument('--text-file',type=Path,required=True);change('retire')
    elif command=='sharing':
        for name in ('list','previews','releases'):commands.add_parser(name).add_argument('--after',default='')
        for name in ('save','preview'):commands.add_parser(name).add_argument('--file',type=Path,required=True)
        commands.add_parser('show-preview').add_argument('id')
        item=change('approve');item.add_argument('--guard-revision',type=int,required=True);item.add_argument('--text-hash',required=True)
        change('revoke')
    else:raise ValueError('unknown_knowledge_command')
    arguments=list(arguments)
    for flag in ('--space','--scope-id'):
        if flag in arguments:
            position=arguments.index(flag)
            if position+1<len(arguments) and arguments[position+1].startswith('-') and not arguments[position+1].startswith('--'):
                arguments[position:position+2]=[flag+'='+arguments[position+1]]
    args=parser.parse_args(arguments)
    if hasattr(args,'id') and not re.fullmatch('[a-f0-9]{64}',args.id):parser.error('id must be a source, derivative, job or interpretation identifier')
    if hasattr(args,'revision') and args.revision<0:parser.error('--revision must be non-negative; zero means no active version')
    return args


def operation(command,args):
    action=args.action;body=None
    mutation=lambda:{'expected_revision':args.revision,'operation_id':args.operation_id}
    if command=='sources':
        if action=='engines':path='/v1/derivation-engines'
        elif action=='versions':path='/v1/sources/'+args.id+'/derivatives?'+urlencode({'after':args.after})
        elif action=='derivative':path='/v1/derivatives/'+args.id
        elif action=='job':path='/v1/reprocessing/'+args.id
        elif action=='prepare':path='/v1/sources/'+args.id+'/prepare';body={}
        elif action=='learning-consent':path='/v1/sources/'+args.id+'/learning-consent'
        elif action=='set-learning':path='/v1/sources/'+args.id+'/learning-consent';body={**mutation(),'enabled':args.enabled=='true'}
        elif action=='reprocess':
            path='/v1/sources/'+args.id+'/reprocess';body={'artifact_id':args.artifact,'input_hash':args.input_hash,'producer':args.engine,
                'producer_version':args.version,'configuration':json.loads(args.configuration.read_text()) if args.configuration else {},'operation_id':args.operation_id}
        elif action=='activate':path='/v1/derivatives/'+args.id+'/activate';body={**mutation(),'expected_revision':args.revision or None}
        else:
            path='/v1/guards/'+args.kind+'/'+args.id
            if action=='guard-history':path+='/history'
            if action in ('edit-guard','restore-guard'):
                body={**mutation(),'expected_revision':args.revision or None}
                body.update({'content':json.loads(args.file.read_text())} if action=='edit-guard' else {'restore_revision':args.from_revision})
    elif command=='projects':
        if action in ('save','assign'):path='/v1/projects'+('/assignments' if action=='assign' else '');body=json.loads(args.file.read_text())
        elif action=='effective':path='/v1/projects/effective?'+urlencode({'space':args.space})
        else:path='/v1/projects'+('/assignments' if action=='assignments' else '')+'?'+urlencode({'after':args.after})
    elif command=='learned':
        if action=='list':path='/v1/learned?'+urlencode({k:v for k,v in {'after':args.after,'scope_kind':args.scope_kind,'scope_id':args.scope_id}.items() if v is not None})
        else:
            path='/v1/learned/'+args.id+('/history' if action=='history' else '/correct' if action in ('correct','retire') else '')
            if action in ('correct','retire'):
                body={**mutation(),'retired':action=='retire',**({'text':args.text_file.read_text()} if action=='correct' else {})}
    else:
        if action in ('list','previews','releases'):path='/v1/sharing/'+('rules' if action=='list' else action)+'?'+urlencode({'after':args.after})
        elif action in ('save','preview'):path='/v1/sharing/'+('rules' if action=='save' else 'preview');body=json.loads(args.file.read_text())
        elif action=='show-preview':path='/v1/sharing/previews/'+args.id
        elif action=='approve':
            path='/v1/sharing/previews/'+args.id+'/approve';body={**mutation(),'guard_revision':args.guard_revision or None,'text_hash':args.text_hash}
        else:path='/v1/sharing/releases/'+args.id+'/revoke';body=mutation()
    if not allowed_path(path):raise ValueError('knowledge_route_denied')
    return path,body


def main(command,arguments):
    args=parse(command,arguments);path,body=operation(command,args)
    print(json.dumps(API().call(path,body),ensure_ascii=False,indent=2));return 0
