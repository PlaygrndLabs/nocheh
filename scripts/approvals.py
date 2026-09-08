"""Review exact tool operations, decisions and bounded permissions locally."""
import argparse
import json
from .archive import API


def main(state,args):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('list','show','approve','deny','grant','revoke','start','stop','status'))
    parser.add_argument('id',nargs='?');parser.add_argument('--fingerprint')
    parser.add_argument('--uses',type=int,default=3);parser.add_argument('--minutes',type=int,default=60)
    options=parser.parse_args(args)
    if options.action in ('start','stop','status'):
        from .tool_worker import start,stop,running
        result=start(state) if options.action=='start' else stop(state,wait=True) if options.action=='stop' else {'running':running(state),'inactive_restore':(state/'admin/tools/inactive').exists()}
    else:
        api=API()
        if options.action=='revoke':result=api.call('/v1/tools/revoke',{'id':options.id})
        else:
            queue=api.call('/v1/tools/actions')
            if options.action=='list':result=queue
            else:
                row=next((row for row in queue['actions']+queue['telegram'] if row['id']==options.id),None)
                if row is None:parser.error('Action not found in the latest 100 entries of each queue.')
                if options.action=='show':result=row
                else:
                    if not options.fingerprint:parser.error('Review with show, then pass the displayed --fingerprint to bind your decision.')
                    if options.action=='grant':result=api.call('/v1/tools/grant',{'action_id':row['id'],'fingerprint':options.fingerprint,'uses':options.uses,'minutes':options.minutes})
                    else:result=api.call('/v1/tools/'+('telegram-decision' if row['kind']=='telegram_message' else 'decide'),{'id':row['id'],'fingerprint':options.fingerprint,'decision':options.action})
    print(json.dumps(result,ensure_ascii=False,indent=2));return 0
