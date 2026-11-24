"""Read native Hermes schedules through the same authenticated owner adapter. Read-only (ADR-0290): a schedule is set
by asking in a chat and changed on the dashboard's Schedules page, where Nocheh grants each change."""
import argparse,json,re,sys
from urllib.parse import urlencode
from tools.operations.security.native import call

READ_ONLY="cron_read_only: nocheh cron is read-only; change schedules on the dashboard's Schedules page or by asking in chat."
# The old write actions stay accepted only to say they are gone, so a script that still uses them fails loudly.
WRITES=('create','update','pause','resume','trigger','catch-up','cancel','delete')


def main(state,args):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('list','show','runs')+WRITES)
    parser.add_argument('id',nargs='?');parser.add_argument('--profile',default='default')
    options=parser.parse_args(args);action=options.action
    if action in WRITES:
        print(READ_ONLY,file=sys.stderr);return 2
    if action!='list' and not options.id:parser.error('Provide a job ID.')
    if options.id and not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}',options.id):parser.error('Invalid job ID.')
    path='/api/cron/jobs'+('/'+options.id if options.id else '')+('/runs' if action=='runs' else '')
    result=call(state,path+'?'+urlencode({'profile':options.profile}))
    print(json.dumps(result,ensure_ascii=False,indent=2));return 0
