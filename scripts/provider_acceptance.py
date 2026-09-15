"""Atomic live cutover to the shared subscription provider."""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from datetime import datetime,timezone
from pathlib import Path

from scripts.configuration import load,write_env,env_path

REPORT='shared-provider-acceptance.json'


def _save(state,report):
    directory=Path(state)/'reports';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    path=directory/REPORT;temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps(report,indent=2)+'\n');temporary.chmod(0o600);temporary.replace(path)


def _run(args,*,env,cwd,input=None):
    result=subprocess.run(args,cwd=cwd,env=env,input=input,text=input is not None)
    if result.returncode:raise RuntimeError('provider_acceptance_command_failed')


def _monitor(state):
    values=load(state);key=(Path(state)/'provider/keys/monitor-admin.key').read_text().strip()
    request=urllib.request.Request(f"http://127.0.0.1:{values['NOCHEH_PROVIDER_MONITOR_PORT']}/status",
        headers={'Authorization':'Bearer '+key})
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request,timeout=10) as response:body=json.load(response)
    collector=body.get('collector',{})
    return {'events':int(body.get('events',0)),'inserted':int(collector.get('totalInserted',0)),
            'collector':collector.get('collector')}


def _wait_monitor(state,minimum,seconds=45):
    deadline=time.monotonic()+seconds;last={}
    while time.monotonic()<deadline:
        try:
            last=_monitor(state)
            if last['events']>minimum and last['collector']=='running':return last
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('provider_monitor_did_not_observe_request')


def _verify(command,env,state,name,checks=()):
    target=f'/reports/shared-provider-{name}.json'
    args=command+['exec','-T','hermes-runtime','python','-m','integrations.hermes.verify','--live','--output',target]
    for check in checks:args+=['--check',check]
    _run(args,env=env,cwd=Path(__file__).resolve().parents[1])
    report=json.loads((Path(state)/'reports'/Path(target).name).read_text())
    if report.get('reasoning_route')!='shared' or not report.get('checks') or any(row.get('status')!='passed' for row in report['checks'].values()):
        raise RuntimeError('shared_provider_live_check_failed')
    return {name:row['status'] for name,row in report['checks'].items()}


def _honcho_probe(env,state):
    root=Path(__file__).resolve().parents[1];key=Path(state)/'provider/keys/honcho.key'
    if key.is_symlink() or not key.is_file():raise RuntimeError('honcho_provider_key_missing')
    code="""import json,urllib.request
from pathlib import Path
key=Path('/run/secrets/honcho.key').read_text().strip()
body={'model':'gpt-5.6-sol','messages':[{'role':'user','content':'Reply exactly NOCHEH_HONCHO_ROUTE_OK with no other text.'}],'stream':False}
request=urllib.request.Request('http://shared-provider:8317/v1/chat/completions',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=120) as response:data=json.load(response)
if data['choices'][0]['message']['content'].strip()!='NOCHEH_HONCHO_ROUTE_OK':raise SystemExit(1)
"""
    args=['docker','run','--rm','--network','nocheh-memory','--user',f'{os.getuid()}:{os.getgid()}',
          '--mount',f'type=bind,src={key},dst=/run/secrets/honcho.key,readonly',
          'nocheh-hermes:local','python','-c',code]
    _run(args,env=env,cwd=root)


def _retire_native_login(state):
    source=Path(state)/'hermes/auth.json'
    if not source.exists():return 'absent'
    if source.is_symlink() or not source.is_file() or source.stat().st_size>1024*1024:
        raise RuntimeError('native_login_invalid')
    directory=Path(state)/'provider/retired';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    destination=directory/('hermes-auth-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
    source.replace(destination);destination.chmod(0o600)
    return 'retired'


def cutover(state):
    from scripts.provider import compose,status,verify
    state=Path(state).resolve();root=Path(__file__).resolve().parents[1]
    report={'recorded_at':datetime.now(timezone.utc).isoformat(),'environment':'local-compose',
            'status':'running','synthetic_inputs_only':True,'checks':{},
            'honcho_memory_gate':'pending separate embedding acceptance'}
    provider=status(state)
    report['provider']={'revision':provider['revision'],'login_count':provider['login_count'],
                        'monitor_revision':provider['monitor']['revision']}
    if not provider['login_present']:
        report['status']='credentials_pending';_save(state,report);return report
    infrastructure=verify(state)
    if not infrastructure['verified']:
        report['status']='infrastructure_failed';_save(state,report);return report
    command,env=compose(state);before=load(state);changed=before['NOCHEH_REASONING_ROUTE']!='shared'
    try:
        baseline=_monitor(state)['events']
        if changed:
            write_env(env_path(state),{**before,'NOCHEH_REASONING_ROUTE':'shared'})
            env={**env,'NOCHEH_REASONING_ROUTE':'shared'}
        _run(command+['up','-d','--no-build','--wait','--wait-timeout','180','cliproxy-api','cliproxy-monitor','chatgpt-speech','hermes-runtime'],env=env,cwd=root)
        report['checks']['initial']=_verify(command,env,state,'initial')
        _honcho_probe(env,state);report['checks']['honcho_reasoning']='passed'
        first=_wait_monitor(state,baseline);report['checks']['monitor_initial']=first

        _run(command+['stop','cliproxy-monitor'],env=env,cwd=root)
        try:report['checks']['monitor_outage_reasoning']=_verify(command,env,state,'monitor-outage',('chat',))
        finally:_run(command+['up','-d','--no-build','--wait','cliproxy-monitor'],env=env,cwd=root)
        second=_wait_monitor(state,first['events']);report['checks']['monitor_recovery']=second

        _run(command+['restart','cliproxy-api','chatgpt-speech','hermes-runtime','cliproxy-monitor'],env=env,cwd=root)
        _run(command+['up','-d','--no-build','--wait','--wait-timeout','180','cliproxy-api','cliproxy-monitor','chatgpt-speech','hermes-runtime'],env=env,cwd=root)
        report['checks']['restart']=_verify(command,env,state,'restart',('refresh','chat','transcription'))
        report['checks']['monitor_after_restart']=_wait_monitor(state,second['events'])
        report['native_login']=_retire_native_login(state)
        report['status']='passed';report['reasoning_route']='shared';_save(state,report);return report
    except Exception as error:
        report['status']='failed';report['error_type']=type(error).__name__
        if changed:
            try:
                write_env(env_path(state),before);rollback_env={**env,'NOCHEH_REASONING_ROUTE':before['NOCHEH_REASONING_ROUTE']}
                _run(command+['up','-d','--no-build','--wait','--wait-timeout','180','cliproxy-api','cliproxy-monitor','chatgpt-speech','hermes-runtime'],env=rollback_env,cwd=root)
                report['rollback']='passed'
            except Exception:report['rollback']='failed'
        _save(state,report);return report
