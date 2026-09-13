"""Owner workflow summaries; works while Inngest and the dashboard are stopped."""
import argparse
import json
import re
from urllib.parse import urlencode
from .archive import API


def main(state,args):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('list','show','status','retry','cancel'))
    parser.add_argument('id',nargs='?')
    parser.add_argument('--family');parser.add_argument('--state');parser.add_argument('--after');parser.add_argument('--limit',type=int,default=50)
    parser.add_argument('--revision',type=int)
    options=parser.parse_args(args)
    if options.action in ('show','retry','cancel') and (not options.id or not re.fullmatch('[a-f0-9]{64}',options.id)):parser.error('Provide a workflow ID.')
    if options.action in ('retry','cancel'):
        if options.revision is None or options.revision<1:parser.error('Provide the revision shown by workflows show.')
        print(json.dumps(API().call('/v1/workflows/'+options.id+'/'+options.action,{'revision':options.revision}),ensure_ascii=False,indent=2));return 0
    path='/v1/workflows'+('/'+options.id if options.action=='show' else '/health' if options.action=='status' else '')
    if options.action=='list':path+='?'+urlencode({k:v for k,v in {'family':options.family,'state':options.state,'after':options.after,'limit':options.limit}.items() if v is not None})
    print(json.dumps(API().call(path),ensure_ascii=False,indent=2));return 0
