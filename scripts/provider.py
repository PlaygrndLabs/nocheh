"""Prepare and inspect the pinned shared CLIProxyAPI service without exposing secrets."""
import argparse
import json
import os
import secrets
import subprocess
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
LOCK=json.loads((ROOT/'compatibility/upstreams.lock.json').read_text())['cliproxy']
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


def initialize(state):
    root,auth,keys,config=paths(state)
    for directory in (root,auth,keys):directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    values={name:_secret(keys/(name+'.key')) for name in (*CLIENTS,'management')}
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
    return {'root':str(root),'login_present':bool(list(auth.glob('*.json'))),'clients':list(CLIENTS)}


def ensure_source(run=subprocess.run):
    destination=ROOT/'data/compat/upstreams/CLIProxyAPI'
    if not destination.exists():
        destination.parent.mkdir(parents=True,exist_ok=True)
        run(['git','clone','--no-checkout',LOCK['repository'],str(destination)],check=True)
        run(['git','-C',str(destination),'checkout','--detach',LOCK['revision']],check=True)
    actual=subprocess.check_output(['git','-C',str(destination),'rev-parse','HEAD'],text=True).strip()
    if actual!=LOCK['revision']:raise ValueError('cliproxy_source_pin_mismatch')
    if subprocess.run(['git','-C',str(destination),'diff','--quiet','HEAD']).returncode:
        raise ValueError('cliproxy_source_is_modified')
    return destination


def compose(state):
    from scripts.configuration import compose_environment,env_path
    return (['docker','compose','--env-file',str(env_path(state)),'-f',str(ROOT/'docker-compose.yml')],
            compose_environment(state))


def status(state):
    info=initialize(state);info.update(revision=LOCK['revision'],running=False,healthy=False)
    command,env=compose(state)
    try:
        raw=subprocess.check_output(command+['ps','--format','json','cliproxy'],cwd=ROOT,env=env,text=True,stderr=subprocess.DEVNULL,timeout=15)
        rows=[json.loads(line) for line in raw.splitlines() if line.strip()]
        if rows:
            info['running']=rows[0].get('State')=='running'
            info['healthy']=rows[0].get('Health')=='healthy'
    except (OSError,subprocess.SubprocessError,ValueError):pass
    return info


def verify(state):
    ensure_source();result=status(state)
    command,env=compose(state)
    try:
        subprocess.run(command+['exec','-T','cliproxy','curl','--fail','--silent','--output','/dev/null','http://127.0.0.1:8317/healthz'],cwd=ROOT,env=env,check=True,timeout=20)
        result['health_check']='passed'
    except (OSError,subprocess.SubprocessError):result['health_check']='failed'
    result['verified']=result['health_check']=='passed' and result['healthy']
    return result


def login(state):
    ensure_source();initialize(state);command,env=compose(state)
    was_running='cliproxy' in subprocess.check_output(command+['ps','--services','--status','running'],cwd=ROOT,env=env,text=True).split()
    if was_running:subprocess.run(command+['stop','cliproxy'],cwd=ROOT,env=env,check=True)
    try:
        return subprocess.call(command+['run','--rm','--no-deps','cliproxy','./CLIProxyAPI','-config','/state/config.yaml','-codex-device-login','-no-browser'],cwd=ROOT,env=env)
    finally:
        if was_running:subprocess.run(command+['up','-d','--no-build','--wait','cliproxy'],cwd=ROOT,env=env,check=True)


def main(state,args):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=('init','status','verify','login'))
    selected=parser.parse_args(args)
    if selected.action=='init':ensure_source();result=initialize(state)
    elif selected.action=='status':result=status(state)
    elif selected.action=='verify':result=verify(state)
    else:return login(state)
    print(json.dumps(result,indent=2));return 0 if selected.action!='verify' or result['verified'] else 1

