"""Prepare and inspect the pinned shared CLIProxyAPI service without exposing secrets."""
import argparse
import json
import os
import secrets
import subprocess
from pathlib import Path

try: from .configuration import INSTALLATION_ROOT as ROOT
except ImportError: from configuration import INSTALLATION_ROOT as ROOT
LOCKS=json.loads((ROOT/'compatibility/upstreams.lock.json').read_text())
LOCK=LOCKS['cliproxy']
MONITOR_LOCK=LOCKS['cpamp']
CLIENTS=('hermes','honcho','preparation')


def paths(state):
    root=Path(state)/'provider'
    return root,root/'auth',root/'keys',root/'config.yaml'


def _secret(path):
    if not path.exists():
        path.write_text(secrets.token_hex(32))
    path.chmod(0o600)
    value=path.read_text().strip()
    if len(value)<32:raise ValueError('shared_provider_secret_too_short')
    return value


def login_state(state):
    _,auth,_,_=paths(state);files=active=invalid=0
    for path in auth.glob('*.json'):
        files+=1
        try:
            if path.is_symlink() or not path.is_file() or path.stat().st_size>1024*1024:
                raise ValueError()
            body=json.loads(path.read_text())
            if not isinstance(body,dict):raise ValueError()
            if (body.get('type')=='codex' and body.get('disabled') is not True
                    and isinstance(body.get('access_token'),str) and body['access_token'].strip()
                    and isinstance(body.get('refresh_token'),str) and body['refresh_token'].strip()):
                active+=1
        except (OSError,ValueError,UnicodeError):invalid+=1
    return {'login_present':active==1 and files==1 and invalid==0,'login_count':active,
            'login_files':files,'invalid_login_files':invalid}


def initialize(state):
    root,auth,keys,config=paths(state)
    monitor=root/'monitor'
    for directory in (root,auth,keys,monitor):directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    values={name:_secret(keys/(name+'.key')) for name in (*CLIENTS,'management')}
    _secret(keys/'monitor-admin.key');_secret(keys/'monitor-data.key')
    desired={
        'host':'','port':8317,'auth-dir':'/auth','api-keys':[values[name] for name in CLIENTS],
        'remote-management':{'allow-remote':True,'secret-key':values['management'],
                             'disable-control-panel':True,'disable-auto-update-panel':True},
        'plugins':{'enabled':False},'usage-statistics-enabled':True,
        'redis-usage-queue-retention-seconds':300,
        'request-retry':0,'max-retry-credentials':1,
        'logging-to-file':False,'request-log':False,'debug':False,
        'passthrough-headers':False,
        'quota-exceeded':{'switch-project':False,'switch-preview-model':False,
                          'antigravity-credits':False},
    }
    encoded=json.dumps(desired,indent=2)+'\n'
    if not config.exists() or config.read_text()!=encoded:
        temporary=config.with_suffix('.tmp');temporary.write_text(encoded);temporary.chmod(0o600);temporary.replace(config)
    config.chmod(0o600)
    return {'root':str(root),**login_state(state),'clients':list(CLIENTS)}


def _ensure_source(directory,pin,error_prefix,run):
    destination=ROOT/'data/compat/upstreams'/directory
    if not destination.exists():
        destination.parent.mkdir(parents=True,exist_ok=True)
        run(['git','clone','--no-checkout',pin['repository'],str(destination)],check=True)
        run(['git','-C',str(destination),'checkout','--detach',pin['revision']],check=True)
    actual=subprocess.check_output(['git','-C',str(destination),'rev-parse','HEAD'],text=True).strip()
    if actual!=pin['revision']:raise ValueError(error_prefix+'_source_pin_mismatch')
    if subprocess.run(['git','-C',str(destination),'diff','--quiet','HEAD']).returncode:
        raise ValueError(error_prefix+'_source_is_modified')
    (destination/'.nocheh-source-revision').write_text(pin['revision']+'\n')
    return destination


def ensure_source(run=subprocess.run):
    return _ensure_source('CLIProxyAPI',LOCK,'cliproxy',run)


def ensure_monitor_source(run=subprocess.run):
    return _ensure_source('cpa-manager-plus',MONITOR_LOCK,'provider_monitor',run)


def compose(state):
    from scripts.configuration import compose_environment,env_path
    from .configuration import compose_command
    return (compose_command(state),
            compose_environment(state))


def status(state):
    info={'root':str(paths(state)[0]),**login_state(state),'clients':list(CLIENTS)};info.update(revision=LOCK['revision'],running=False,healthy=False,
        monitor={'revision':MONITOR_LOCK['revision'],'running':False,'healthy':False})
    command,env=compose(state)
    try:
        raw=subprocess.check_output(command+['ps','--format','json','cliproxy-api','cliproxy-monitor'],cwd=ROOT,env=env,text=True,stderr=subprocess.DEVNULL,timeout=15)
        rows=[json.loads(line) for line in raw.splitlines() if line.strip()]
        for row in rows:
            target=info if row.get('Service')=='cliproxy-api' else info['monitor']
            target['running']=row.get('State')=='running';target['healthy']=row.get('Health')=='healthy'
    except (OSError,subprocess.SubprocessError,ValueError):pass
    return info


def verify(state):
    ensure_source();ensure_monitor_source();result=status(state)
    command,env=compose(state)
    try:
        subprocess.run(command+['exec','-T','cliproxy-api','curl','--fail','--silent','--output','/dev/null','http://127.0.0.1:8317/healthz'],cwd=ROOT,env=env,check=True,timeout=20)
        result['health_check']='passed'
    except (OSError,subprocess.SubprocessError):result['health_check']='failed'
    try:
        subprocess.run(command+['exec','-T','cliproxy-monitor','wget','-q','-O','/dev/null','http://127.0.0.1:18317/health'],cwd=ROOT,env=env,check=True,timeout=20)
        result['monitor_health_check']='passed'
    except (OSError,subprocess.SubprocessError):result['monitor_health_check']='failed'
    result['verified']=result['health_check']=='passed' and result['healthy'] and result['monitor_health_check']=='passed' and result['monitor']['healthy']
    return result


def login(state):
    ensure_source();initialize(state);command,env=compose(state)
    current=login_state(state)
    if current['login_files']:
        raise SystemExit('A provider login already exists; refusing to create a second refresh owner.')
    was_running='cliproxy-api' in subprocess.check_output(command+['ps','--services','--status','running'],cwd=ROOT,env=env,text=True).split()
    if was_running:subprocess.run(command+['stop','cliproxy-api'],cwd=ROOT,env=env,check=True)
    try:
        result=subprocess.call(command+['run','--rm','--no-deps','cliproxy-api','./CLIProxyAPI','-config','/state/config.yaml','-codex-device-login','-no-browser'],cwd=ROOT,env=env)
        if result==0 and not login_state(state)['login_present']:
            print('Device login returned without exactly one active Codex credential.',file=os.sys.stderr);return 1
        return result
    finally:
        if was_running:subprocess.run(command+['up','-d','--no-build','--wait','cliproxy-api'],cwd=ROOT,env=env,check=True)


def main(state,args):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=('init','status','verify','login','cutover'))
    selected=parser.parse_args(args)
    if selected.action=='init':ensure_source();ensure_monitor_source();result=initialize(state)
    elif selected.action=='status':result=status(state)
    elif selected.action=='verify':result=verify(state)
    elif selected.action=='login':return login(state)
    else:
        from scripts.provider_acceptance import cutover
        result=cutover(state)
    print(json.dumps(result,indent=2))
    if selected.action=='verify':return 0 if result['verified'] else 1
    if selected.action=='cutover':return 0 if result['status']=='passed' else 2 if result['status']=='credentials_pending' else 1
    return 0
