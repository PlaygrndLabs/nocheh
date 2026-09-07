"""Owner memory policies and native-learning controls; JSON output for scripting."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode
from .archive import API


def main(arguments):
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='action',required=True)
    spaces=commands.add_parser('spaces');spaces.add_argument('--after',default='')
    for name in ('policy','shares','preview'):
        command=commands.add_parser(name);command.add_argument('--space',required=True)
        if name=='policy':command.add_argument('--set',type=Path);command.add_argument('--revision',type=int)
        if name=='preview':command.add_argument('--query',default='')
    share=commands.add_parser('share');share.add_argument('--space',required=True);share.add_argument('--file',type=Path,required=True);share.add_argument('--source',action='append',default=[]);share.add_argument('--revision',type=int,required=True)
    revoke=commands.add_parser('revoke');revoke.add_argument('id');revoke.add_argument('--revision',type=int,required=True)
    recall=commands.add_parser('recall');recall.add_argument('query');recall.add_argument('--profile');recall.add_argument('--after-profile');recall.add_argument('--limit',type=int,default=10)
    reviews=commands.add_parser('reviews');reviews.add_argument('--after',default='')
    for name in ('pause','resume'):
        commands.add_parser(name).add_argument('id')
    review=commands.add_parser('review');review.add_argument('event_ids',nargs='+');review.add_argument('--approve',action='store_true',required=True)
    arguments=list(arguments)
    if '--space' in arguments:
        position=arguments.index('--space')
        if position+1<len(arguments) and arguments[position+1].startswith('-') and not arguments[position+1].startswith('--'):
            arguments[position:position+2]=['--space='+arguments[position+1]]
    args=parser.parse_args(arguments);api=API();prefix='/v1/memory/'
    if args.action=='spaces':result=api.call(prefix+'spaces?'+urlencode({'after':args.after}))
    elif args.action=='policy':
        if args.set:
            if args.revision is None:parser.error('--revision is required with --set')
            result=api.call(prefix+'spaces',{'id':args.space,'overrides':json.loads(args.set.read_text()),'revision':args.revision})
        else:result=api.call(prefix+'spaces?'+urlencode({'id':args.space}))
    elif args.action=='shares':result=api.call(prefix+'shares?'+urlencode({'space':args.space}))
    elif args.action=='share':result=api.call(prefix+'shares',{'destination':args.space,'content':args.file.read_text(),'source_ids':args.source,'revision':args.revision})
    elif args.action=='revoke':result=api.call(prefix+'shares/revoke',{'id':args.id,'revision':args.revision})
    elif args.action=='preview':result=api.call(prefix+'preview?'+urlencode({'space':args.space,'q':args.query}))
    elif args.action=='recall':result=api.call(prefix+'recall',{'query':args.query,'limit':args.limit,**({'profile':args.profile} if args.profile else {}),**({'after_profile':args.after_profile} if args.after_profile else {})})
    elif args.action=='reviews':result=api.call(prefix+'reviews?'+urlencode({'after':args.after}))
    elif args.action=='review':result=api.call(prefix+'reviews',{'event_ids':args.event_ids,'approved':args.approve})
    else:result=api.call(prefix+'reviews/control',{'id':args.id,'action':args.action})
    print(json.dumps(result,ensure_ascii=False,indent=2));return 0
