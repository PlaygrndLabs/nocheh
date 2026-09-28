"""Production Honcho uses the installation's Compose project and protected state."""
import subprocess
import os
from pathlib import Path
from tools.operations.installation.configuration import load,write_env,read_env,env_path
from tools.operations.provider.provider import compose

SERVICES=('honcho-postgres','honcho-redis','honcho-provider-gateway','honcho-api','honcho-deriver')


def normalize_endpoints(directory):
    """Preserve protected values while updating production-only service hosts."""
    path=Path(directory)/'honcho.env';values=read_env(path);changed=False
    for key,value in values.items():
        updated=value.replace('@database:5432/','@honcho-postgres:5432/').replace('redis://redis:6379/','redis://honcho-redis:6379/').replace('http://meter:8790/','http://honcho-provider-gateway:8790/')
        if updated!=value:values[key]=updated;changed=True
    if changed:write_env(path,values)


def enabled(state):
    return load(state).get('NOCHEH_HONCHO_ENABLED')=='true'


def ensure_single_project():
    projects=subprocess.check_output(['docker','ps','--filter',
        'label=com.docker.compose.service=honcho-api','--format',
        '{{.Label "com.docker.compose.project"}}'],text=True,timeout=20).split()
    if any(project != os.environ.get('COMPOSE_PROJECT_NAME','nocheh') for project in projects):
        raise ValueError('honcho_other_project_running')


def enable(state,honcho_state):
    state=Path(state);honcho_state=Path(honcho_state).resolve()
    if (state/'spool/.restore-inactive').exists():raise ValueError('inactive_restore')
    ensure_single_project()
    values=load(state)
    token=(honcho_state/'internal_token').read_text().strip()
    if values.get('NOCHEH_MEMORY_TOKEN')!=token:raise ValueError('honcho_runtime_init_required')
    # Compose creates and labels these volumes, including on a fresh setup.
    project=os.environ.get('COMPOSE_PROJECT_NAME','nocheh')
    for kind in ('DATABASE','REDIS'):
        key='NOCHEH_HONCHO_'+kind+'_VOLUME'
        if not values.get(key):values[key]=project+'_honcho_'+kind.lower()
    values.update(NOCHEH_HONCHO_ENABLED='true',NOCHEH_HONCHO_STATE_DIR=str(honcho_state))
    normalize_endpoints(honcho_state)
    write_env(env_path(state),values)


def operate(state,action):
    if action not in ('up','down','status'):raise ValueError('honcho_operation_invalid')
    command,env=compose(state)
    if action=='up':
        if (Path(state)/'spool/.restore-inactive').exists():raise ValueError('inactive_restore')
        ensure_single_project()
        normalize_endpoints(env['NOCHEH_HONCHO_STATE_DIR'])
        arguments=['up','-d','--no-build','--wait','--wait-timeout','240',*SERVICES]
    elif action=='down':arguments=['stop',*reversed(SERVICES)]
    else:arguments=['ps',*SERVICES]
    return subprocess.call(command+['--profile','honcho']+arguments,env=env)
