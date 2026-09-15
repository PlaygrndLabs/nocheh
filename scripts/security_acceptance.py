"""Synthetic, local acceptance using the installed subscription refresh authority.

Requires candidate images and the isolated PostgreSQL fixture. Never switches the
active runtime or imports real user history. Output contains scores, not credentials.
"""
import base64
import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from integrations.hermes.security_launcher import docker,container_spec,attach
from integrations.hermes.isolated_profile import prepare
from integrations.hermes.security_transport import scoped_transport
from .configuration import ROOT,load

def credentials():
    config=load(ROOT/'data/local');owner=config['TELEGRAM_OWNER_ID'];secret=config['SERVICE_TOKEN']
    if not owner:raise ValueError('owner_configuration_required')
    source='e'*64
    claims=dict(scope=None,expires=int(time.time()*1000)+600000,event_id=source,audience='nocheh-assistant',space=owner,revision=1)
    encoded=base64.urlsafe_b64encode(json.dumps(claims,separators=(',',':')).encode()).decode().rstrip('=')
    signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),encoded.encode(),hashlib.sha256).digest()).decode().rstrip('=')
    body={'profile':'nocheh-'+hashlib.sha256(owner.encode()).hexdigest()[:24],'scope':owner,'event_id':source,'archive_credential':'turn.'+encoded+'.'+signature}
    code='''import os,json,sys,urllib.request
body=json.load(sys.stdin)
request=urllib.request.Request('http://127.0.0.1:8781/internal/browser-credentials',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+os.environ['SERVICE_TOKEN'],'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=20) as response:result=json.load(response)
from agent.codex_headers import codex_cloudflare_headers
result['headers']=codex_cloudflare_headers(result['api_key']) if result['api_mode']=='codex_responses' else {}
from agent.model_metadata import get_model_context_length
result['model_context_length']=get_model_context_length(result['model'],base_url=result['base_url'],api_key=result['api_key'],provider=result['provider'])
sys.stdout.write(json.dumps(result))
'''
    from .provider import compose
    command,env=compose(ROOT/'data/local')
    result=subprocess.run(command+['exec','-T','hermes-runtime','python','-c',code],env=env,input=json.dumps(body).encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=120)
    if result.returncode:raise RuntimeError('live_subscription_unavailable')
    return json.loads(result.stdout)

def quality_gate(results):
    """Candidate must pass every fixture. Baseline failures stay visible."""
    counts={placement:sum(item['passed'] for item in results if item['placement']==placement) for placement in ('legacy','evidence')}
    complete=len(results)==12 and all(item['state']=='done' for item in results)
    return {'cases_per_placement':6,'strict_passes':counts,'passed':complete and counts['evidence']==6 and counts['evidence']>=counts['legacy'],
            'limit':'Small synthetic corpus; this is observed parity, not a universal accuracy guarantee.'}

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--smoke-only',action='store_true');args=parser.parse_args()
    report={'synthetic_only':True,'status':'pending','checks':{},'quality':[],'active_runtime_changed':False}
    output=ROOT/'compatibility/results'/('security-service-launcher-acceptance.json' if args.smoke_only else 'security-service-acceptance.json')
    identifiers=[];networks=[]
    with tempfile.TemporaryDirectory(prefix='security-acceptance-',dir=ROOT/'data') as folder:
        root=Path(folder);os.chmod(root,0o700)
        try:
            provider=credentials();report['model']=provider['model']
            report['model_context_length']=provider['model_context_length']
            private=root/'provider.json';private.write_text(json.dumps(provider));private.chmod(0o600)
            public='nocheh-security-acceptance';internal='nocheh-security-acceptance-agent'
            for name,isolated in [(public,False),(internal,True)]:docker('POST','/networks/create',{'Name':name,'Internal':isolated});networks.append(name)
            docker('POST','/networks/'+public+'/connect',{'Container':'nocheh-security-test-postgres','EndpointConfig':{'Aliases':['fixture-postgres']}})
            images={name:docker('GET','/images/'+name+':security-candidate/json')['Id'] for name in ['nocheh-hermes','nocheh-services']}
            report['images']=images
            service={'Image':images['nocheh-services'],'User':f'{os.getuid()}:{os.getgid()}',
              'NetworkingConfig':{'EndpointsConfig':{public:{'Aliases':['nocheh-security']}}},
              'Cmd':['node','dist/test/security-fixture-server.js'],
              'Env':['NOCHEH_SECURITY_FIXTURE=synthetic-only','PGHOST=fixture-postgres','PGUSER=nocheh','PGDATABASE=nocheh','PGPASSWORD=security-synthetic-database-password',
                     'SERVICE_TOKEN=synthetic-security-fixture-token'],
              'HostConfig':{'NetworkMode':public,'Binds':[str(root)+':/fixture:rw'],'ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],'LogConfig':{'Type':'none'}}}
            identifier=docker('POST','/containers/create',service)['Id'];identifiers.append(identifier)
            docker('POST','/networks/'+internal+'/connect',{'Container':identifier,'EndpointConfig':{'Aliases':['nocheh-security']}})
            docker('POST','/containers/'+identifier+'/start')
            deadline=time.monotonic()+20
            while not (root/'ready.json').exists():
                if time.monotonic()>deadline:raise RuntimeError('acceptance_broker_unavailable')
                time.sleep(.1)
            binding=json.loads((root/'ready.json').read_text());name=binding['profile']
            native='Cedar native note: The project code is amber-71. Preferred answer language: English.\nThe earlier budget estimate was 300 credits; check the archive for the current value.\n'
            prompts=[
              ('recall','What is Cedar\'s project code, owner, and backup owner? Return only a JSON object with keys project_code, owner, backup_owner.',
                {'project_code':'amber-71','owner':'Mina','backup_owner':'Jules'}),
              ('grounding','Read archive source '+binding['source']+'. Return only JSON with current_budget (number), previous_budget (number), launch_date (day month, no year), source (exact archive reference).',
                {'current_budget':420,'previous_budget':300,'launch_date':'18 October','source':binding['source']}),
              ('reasoning','Using native and retrieved memory plus archive source '+binding['source']+', return only JSON with owner, project_code, budget_increase (number), source (exact archive reference).',
                {'owner':'Mina','project_code':'amber-71','budget_increase':120,'source':binding['source']}),
            ]
            for repetition in range(0 if args.smoke_only else 2):
                for placement in ['legacy','evidence']:
                    for case,prompt,expected in prompts:
                        profiles=root/f'{placement}-{repetition}-{case}';profile=profiles/name;profile.mkdir(parents=True)
                        from integrations.hermes.profile_config import resolved
                        (profile/'config.yaml').write_text(json.dumps(resolved({},provider['model'])));prepare(profile)
                        (profile/'memories'/'MEMORY.md').write_text(native)
                        (profile/'memories'/'USER.md').write_text('The owner prefers concise answers with source citations.\n')
                        spec=container_spec(name,str(profiles),images['nocheh-hermes'],internal,os.getuid(),os.getgid())
                        identifier=docker('POST','/containers/create',spec)['Id'];identifiers.append(identifier)
                        body={'text':prompt,'source_text':prompt,'channel':'browser','model':provider['model'],'session_id':'synthetic-'+case,
                              'model_context_length':provider['model_context_length'],
                              'owner':True,'chat_id':'1','user_id':'1','archive_credential':binding['credential'],'memory_context':placement,
                              **scoped_transport(binding['credential'],provider['api_mode'])}
                        started=time.monotonic();raw=b''.join(attach(identifier,body));result=json.loads(raw)
                        text=result.get('text','')
                        try:answer=json.loads(re.sub(r'^```(?:json)?\s*|\s*```$','',text.strip()))
                        except ValueError:answer=None
                        passed=result.get('state')=='done' and answer==expected
                        report['quality'].append({'case':case,'placement':placement,'repetition':repetition,'passed':passed,'state':result.get('state'),
                          'error_type':result.get('error_type'),'error_code':result.get('error_code'),'error_stage':result.get('error_stage'),'seconds':round(time.monotonic()-started,2),
                          'correct_fields':[key for key,value in expected.items() if isinstance(answer,dict) and answer.get(key)==value],
                          'answer':text.replace(provider['api_key'],'[redacted credential]').replace(binding['credential'],'[redacted capability]')})
                        output.write_text(json.dumps(report,indent=2)+'\n')
                        print(json.dumps(report['quality'][-1]),flush=True)
                        docker('DELETE','/containers/'+identifier+'?force=true');identifiers.remove(identifier)
                        if result.get('state')!='done':raise RuntimeError('live_turn_failed')
            # Exercise the actual trusted launcher HTTP path, not just its container spec.
            profiles=root/'supervised';profile=profiles/name;profile.mkdir(parents=True)
            from integrations.hermes.profile_config import resolved
            (profile/'config.yaml').write_text(json.dumps(resolved({},provider['model'])));prepare(profile)
            (profile/'memories'/'MEMORY.md').write_text(native)
            spec={'Image':images['nocheh-hermes'],'User':'0:0','Cmd':['python','-m','integrations.hermes.security_launcher'],
              'Env':['SERVICE_TOKEN=synthetic-security-fixture-token','NOCHEH_AGENT_NETWORK='+internal,'NOCHEH_TURN_IMAGE=nocheh-hermes:security-candidate',
                     'NOCHEH_UID='+str(os.getuid()),'NOCHEH_GID='+str(os.getgid())],
              'ExposedPorts':{'8787/tcp':{}},
              'HostConfig':{'NetworkMode':public,'ReadonlyRootfs':True,'CapDrop':['ALL'],'CapAdd':['DAC_READ_SEARCH'],'SecurityOpt':['no-new-privileges:true'],
                'Tmpfs':{'/tmp':'rw,nosuid,nodev,size=32m'},'LogConfig':{'Type':'none'},
                'Binds':['/var/run/docker.sock:/var/run/docker.sock',str(profiles)+':/profiles:ro'],
                'PortBindings':{'8787/tcp':[{'HostIp':'127.0.0.1','HostPort':''}]}}}
            identifier=docker('POST','/containers/create',spec)['Id'];identifiers.append(identifier);docker('POST','/containers/'+identifier+'/start')
            port=docker('GET','/containers/'+identifier+'/json')['NetworkSettings']['Ports']['8787/tcp'][0]['HostPort']
            address='http://127.0.0.1:'+port;deadline=time.monotonic()+20
            while True:
                try:
                    with urlopen(address+'/health',timeout=1) as response:json.load(response)
                    break
                except OSError:
                    if time.monotonic()>deadline:raise RuntimeError('acceptance_launcher_unavailable')
                    time.sleep(.1)
            body={'text':'Reply with only Cedar\'s project code.','channel':'browser','model':provider['model'],'session_id':'supervised-smoke',
                  'owner':True,'chat_id':'1','user_id':'1','archive_credential':binding['credential'],'memory_context':'evidence',**scoped_transport(binding['credential'],provider['api_mode'])}
            try:
                with urlopen(Request(address+'/v1/turn',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+binding['credential']}),timeout=10):pass
                report['checks']['launcher_rejects_agent_credential']=False
            except HTTPError as error:report['checks']['launcher_rejects_agent_credential']=error.code==403
            with urlopen(Request(address+'/v1/turn',data=json.dumps(body).encode(),headers={'Authorization':'Bearer synthetic-security-fixture-token','Content-Type':'application/json'}),timeout=235) as response:result=json.load(response)
            report['checks']['supervised_turn']=result.get('state')=='done' and result.get('text','').strip()=='amber-71'
            report['supervised_native_files']=[str(p.relative_to(profile)) for p in profile.rglob('*') if p.is_file()]
            report['checks']['supervised_history_persisted']=(profile/'native-state'/'state.db').is_file()
            report['checks']['no_running_turns']=not any(c.get('Labels',{}).get('nocheh.role')=='isolated-turn' and internal in c.get('NetworkSettings',{}).get('Networks',{}) for c in docker('GET','/containers/json'))
            launcher=identifier
            cancelled_body={**body,'session_id':'supervised-cancelled','text':'Read the Cedar archive source and report its budget.'}
            response=urlopen(Request(address+'/v1/turn',data=json.dumps(cancelled_body).encode(),headers={'Authorization':'Bearer synthetic-security-fixture-token','Content-Type':'application/json'}),timeout=150)
            response.close()
            deadline=time.monotonic()+12
            while True:
                remaining=[c for c in docker('GET','/containers/json?all=true') if c.get('Labels',{}).get('nocheh.role')=='isolated-turn' and internal in c.get('NetworkSettings',{}).get('Networks',{})]
                if not remaining or time.monotonic()>deadline:break
                time.sleep(.1)
            report['checks']['disconnect_removes_turn']=not remaining
            orphan=docker('POST','/containers/create',container_spec(name,str(profiles),images['nocheh-hermes'],internal,os.getuid(),os.getgid()))['Id'];identifiers.append(orphan)
            docker('POST','/containers/'+launcher+'/restart?t=1')
            deadline=time.monotonic()+15
            while True:
                remaining=[c for c in docker('GET','/containers/json?all=true') if c['Id']==orphan]
                if not remaining or time.monotonic()>deadline:break
                time.sleep(.1)
            report['checks']['restart_removes_orphan_without_replay']=not remaining
            logs=json.loads((root/'effects.json').read_text())
            report['checks']['no_approval_for_context']=not any(event['state']=='awaiting_approval' for event in logs['events'])
            report['checks']['provider_receipts']=any(event['kind']=='model.request' and event['state']=='completed' for event in logs['events'])
            report['checks']['credentials_absent_from_logs']=provider['api_key'] not in json.dumps(logs)
            report['quality_gate']=quality_gate(report['quality']) if not args.smoke_only else {'passed':True,'note':'Launcher lifecycle check; separate comparison report contains quality evidence.'}
            report['status']='passed' if report['quality_gate']['passed'] and all(report['checks'].values()) else 'quality_regression_or_inconclusive'
        except Exception as error:
            report['status']='pending';report['error_type']=type(error).__name__
            report['error_code']=str(error) if str(error) in ('live_subscription_unavailable','acceptance_broker_unavailable','acceptance_launcher_unavailable','live_turn_failed','owner_configuration_required') else 'acceptance_unavailable'
        finally:
            if (root/'effects.json').exists():
                try:report['effect_evidence']=json.loads((root/'effects.json').read_text())
                except ValueError:pass
            for identifier in reversed(identifiers):
                try:docker('DELETE','/containers/'+identifier+'?force=true')
                except Exception:pass
            for name in reversed(networks):
                if name=='nocheh-security-acceptance':
                    try:docker('POST','/networks/'+name+'/disconnect',{'Container':'nocheh-security-test-postgres','Force':True})
                    except Exception:pass
                try:docker('DELETE','/networks/'+name)
                except Exception:pass
            output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'status':report['status'],'report':str(output),'error_code':report.get('error_code')}),flush=True)
    return 0 if report['status']=='passed' else 1

if __name__=='__main__':raise SystemExit(main())
