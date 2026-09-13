"""Owner workflow summaries; works while Inngest and the dashboard are stopped."""
import argparse
import json
import re
import uuid
import hashlib
from urllib.parse import urlencode
from .archive import API


def main(state,args):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('list','show','status','retry','cancel','pause-family','migration','reconcile','switch','abort','host-handoff'))
    parser.add_argument('id',nargs='?')
    parser.add_argument('--family');parser.add_argument('--state');parser.add_argument('--after');parser.add_argument('--limit',type=int,default=50)
    parser.add_argument('--revision',type=int)
    parser.add_argument('--epoch',type=int);parser.add_argument('--owner',choices=('legacy','inngest'))
    parser.add_argument('--migration-id')
    options=parser.parse_args(args)
    if options.action=='host-handoff':
        if not options.id or not re.fullmatch('[a-f0-9]{64}',options.id):parser.error('Provide the paused migration ID.')
        from .workflow_handoff import handoff
        print(json.dumps(handoff(state,options.id),indent=2));return 0
    if options.action=='pause-family':
        if not options.id or not options.owner or not options.epoch:parser.error('Provide the family, --owner and current --epoch from workflows status.')
        identity=options.migration_id or hashlib.sha256(uuid.uuid4().bytes).hexdigest()
        print(json.dumps(API().call('/v1/workflows/migrations',{'id':identity,'family':options.id,'owner':options.owner,'epoch':options.epoch}),indent=2));return 0
    if options.action in ('migration','reconcile','switch','abort'):
        if not options.id or not re.fullmatch('[a-f0-9]{64}',options.id):parser.error('Provide the migration ID returned by pause-family.')
        path='/v1/workflows/migrations/'+options.id
        print(json.dumps(API().call(path if options.action=='migration' else path+'/'+options.action,None if options.action=='migration' else {}),indent=2));return 0
    if options.action in ('show','retry','cancel') and (not options.id or not re.fullmatch('[a-f0-9]{64}',options.id)):parser.error('Provide a workflow ID.')
    if options.action in ('retry','cancel'):
        if options.revision is None or options.revision<1:parser.error('Provide the revision shown by workflows show.')
        print(json.dumps(API().call('/v1/workflows/'+options.id+'/'+options.action,{'revision':options.revision}),ensure_ascii=False,indent=2));return 0
    path='/v1/workflows'+('/'+options.id if options.action=='show' else '/health' if options.action=='status' else '')
    if options.action=='list':path+='?'+urlencode({k:v for k,v in {'family':options.family,'state':options.state,'after':options.after,'limit':options.limit}.items() if v is not None})
    print(json.dumps(API().call(path),ensure_ascii=False,indent=2));return 0
