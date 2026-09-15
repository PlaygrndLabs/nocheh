"""Build and test isolated Hermes candidates; never activate or change the saved pin."""
import argparse
import contextlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime,timezone
from pathlib import Path
from .configuration import ROOT


def lock():return json.loads((ROOT/'compatibility/upstreams.lock.json').read_text())


def pin_check(root=ROOT):
    pinned=json.loads((root/'compatibility/upstreams.lock.json').read_text())['hermes']
    checks={}
    for path in ('deploy/hermes.Dockerfile','src/managed-runs.ts'):
        checks[path]=pinned['revision'] in (root/path).read_text()
    for path in ('integrations/hermes/native_admin.py','integrations/hermes/browser_gateway.py'):
        checks[path]=pinned['version'] in (root/path).read_text()
    return {'revision':pinned['revision'],'version':pinned['version'],'consistent':all(checks.values()),'checks':checks}


@contextlib.contextmanager
def public_environment():
    host=subprocess.check_output(['docker','context','inspect','--format','{{(index .Endpoints "docker").Host}}'],text=True).strip()
    if not host.startswith('unix://'):raise ValueError('local_docker_context_required')
    # These builds only use public pinned images. Explicit empty public auth
    # entries avoid platform credential-helper auto-detection and its prompts.
    with tempfile.TemporaryDirectory(prefix='nocheh-public-images-') as folder:
        Path(folder,'config.json').write_text(json.dumps({'cliPluginsExtraDirs':[str(Path.home()/'.docker/cli-plugins')],
            'auths':{'https://index.docker.io/v1/':{},'ghcr.io':{}}}))
        env={**os.environ,'DOCKER_CONFIG':folder,'DOCKER_HOST':host};env.pop('DOCKER_CONTEXT',None)
        yield env


def commands(revision):
    if not re.fullmatch(r'[a-f0-9]{40}',revision):raise ValueError('full_revision_required')
    runtime='nocheh-candidate-'+revision[:12]+':runtime';dashboard=runtime
    return runtime,dashboard,[
        ('runtime_build',['docker','build','-f','deploy/hermes.Dockerfile','--build-arg','HERMES_REVISION='+revision,
            '--build-context','hermes_source='+str(ROOT/'data/compat/upstreams/hermes-agent'),
            '--build-arg','LOCAL_UID='+str(os.getuid()),'--build-arg','LOCAL_GID='+str(os.getgid()),'-t',runtime,'.']),
        ('native_contract_tests',['docker','run','--rm','--network=none','--read-only','--tmpfs','/tmp:rw,exec,nosuid,nodev,mode=1777',
            '--cap-drop=ALL','--security-opt=no-new-privileges','-e','HERMES_HOME=/tmp/nocheh-candidate-tests',
            '-e','SERVICE_TOKEN='+'0'*64,
            runtime,'python','-m','unittest','discover','-s','integrations/hermes','-t','.','-p','test_*.py','-q']),
        ('dashboard_assets',['docker','run','--rm','--network=none','--read-only',runtime,'python','-c',
            "from pathlib import Path; assert Path('/opt/hermes/hermes_cli/web_dist/index.html').is_file(); assert Path('/workspace/integrations/hermes/dashboard/dist/index.js').is_file()"]),
    ]


def check(state,revision,run=subprocess.run):
    runtime,dashboard,steps=commands(revision)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    directory=Path(state)/'reports/compatibility'/(stamp+'-'+revision[:12]);directory.mkdir(parents=True,exist_ok=False,mode=0o700)
    report={'revision':revision,'saved_pin':lock()['hermes']['revision'],'activated':False,'production_state_mounted':False,
        'provider_credentials_supplied':False,'images':{'runtime':runtime,'dashboard':dashboard},'checks':{},
        'live_acceptance':'pending','started_at':datetime.now(timezone.utc).isoformat()}
    try:
        with public_environment() as env:
            for name,command in steps:
                path=directory/(name+'.log')
                with path.open('x') as output:
                    path.chmod(0o600)
                    result=run(command,cwd=ROOT,env=env,stdout=output,stderr=subprocess.STDOUT)
                report['checks'][name]='passed' if result.returncode==0 else 'failed'
                print(name+': '+report['checks'][name],flush=True)
                if result.returncode:break
    finally:
        report['offline_passed']=len(report['checks'])==len(steps) and all(value=='passed' for value in report['checks'].values())
        (directory/'report.json').write_text(json.dumps(report,indent=2)+'\n');(directory/'report.json').chmod(0o600)
    return {'report':str(directory/'report.json'),**report}


def main(state,args):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=('status','check'))
    parser.add_argument('--revision',help='Full candidate commit; defaults to the saved pin.')
    options=parser.parse_args(args);pins=pin_check()
    if options.action=='status':print(json.dumps(pins,indent=2));return 0 if pins['consistent'] else 1
    if not pins['consistent']:raise ValueError('saved_pin_inconsistent')
    result=check(state,options.revision or pins['revision']);print(json.dumps(result,indent=2))
    return 0 if result['offline_passed'] else 1
