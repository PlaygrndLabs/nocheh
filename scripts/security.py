"""Owner security configuration and effect evidence; no model-facing admin commands."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode
from .archive import API

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('show');commands.add_parser('plugin')
    save=commands.add_parser('apply');save.add_argument('file',type=Path);save.add_argument('--expected-revision',type=int,required=True)
    preview=commands.add_parser('preview');preview.add_argument('action_id');preview.add_argument('--policy',type=Path)
    logs=commands.add_parser('effects');logs.add_argument('--after',default='0');logs.add_argument('--effect')
    grant=commands.add_parser('grant');grant.add_argument('action_id');grant.add_argument('--fingerprint',required=True);grant.add_argument('--uses',type=int,required=True);grant.add_argument('--minutes',type=int,required=True)
    revoke=commands.add_parser('revoke');revoke.add_argument('permission_id')
    args=parser.parse_args();api=API()
    if args.command=='show':result=api.call('/v1/security/policy')
    elif args.command=='plugin':result=api.call('/v1/security/plugin')
    elif args.command=='apply':result=api.call('/v1/security/policy',{'policy':json.loads(args.file.read_text()),'expected_revision':args.expected_revision})
    elif args.command=='preview':result=api.call('/v1/security/preview',{'action_id':args.action_id,**({'policy':json.loads(args.policy.read_text())} if args.policy else {})})
    elif args.command=='effects':result=api.call('/v1/security/effects?'+urlencode({'after':args.after,**({'effect':args.effect} if args.effect else {})}))
    elif args.command=='grant':result=api.call('/v1/tools/grant',{'action_id':args.action_id,'fingerprint':args.fingerprint,'uses':args.uses,'minutes':args.minutes})
    else:result=api.call('/v1/tools/revoke',{'id':args.permission_id})
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
