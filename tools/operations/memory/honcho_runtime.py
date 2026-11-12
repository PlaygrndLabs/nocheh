"""Production Honcho uses the installation's Compose project and protected state."""
import json
import subprocess
from pathlib import Path
from tools.operations.installation.configuration import load,owns_project,write_env,read_env,env_path,compose,compose_environment,honcho_volumes

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


def ensure_own_resources(env):
    """Honcho's volumes and memory network belong to this workspace's project and never to another one's, so
    each workspace's memory engine runs beside the others' with data of its own (ADR-0245)."""
    project=env['COMPOSE_PROJECT_NAME']
    for kind,name in (('volume',env.get('NOCHEH_HONCHO_DATABASE_VOLUME') or project+'_honcho_database'),
                      ('volume',env.get('NOCHEH_HONCHO_REDIS_VOLUME') or project+'_honcho_redis'),
                      ('network',env.get('NOCHEH_MEMORY_NETWORK') or project+'-memory')):
        result=subprocess.run(['docker',kind,'inspect','--format','{{json .Labels}}',name],capture_output=True,text=True,timeout=20)
        # A missing one is made by Compose for this project.
        if result.returncode:continue
        try:holder=(json.loads(result.stdout or 'null') or {}).get('com.docker.compose.project')
        except ValueError:holder=None
        if holder and holder!=project:raise ValueError('honcho_other_project_resources')


def enable(state,honcho_state):
    state=Path(state);honcho_state=Path(honcho_state).resolve()
    if (state/'spool/.restore-inactive').exists():raise ValueError('inactive_restore')
    env=compose_environment(state)
    ensure_own_resources(env)
    values=load(state)
    token=(honcho_state/'internal_token').read_text().strip()
    if values.get('NOCHEH_MEMORY_TOKEN')!=token:raise ValueError('honcho_runtime_init_required')
    # Compose creates and labels these volumes, including on a fresh setup.
    for key,name in honcho_volumes(env['COMPOSE_PROJECT_NAME']).items():
        if not values.get(key):values[key]=name
    values.update(NOCHEH_HONCHO_ENABLED='true',NOCHEH_HONCHO_STATE_DIR=str(honcho_state))
    normalize_endpoints(honcho_state)
    write_env(env_path(state),values)


def operate(state,action):
    if action not in ('up','down','status'):raise ValueError('honcho_operation_invalid')
    command,env=compose(state)
    if action=='up' and (Path(state)/'spool/.restore-inactive').exists():raise ValueError('inactive_restore')
    if action!='status' and not owns_project(state):raise ValueError('state_project_required')
    if action=='up':
        ensure_own_resources(env)
        normalize_endpoints(env['NOCHEH_HONCHO_STATE_DIR'])
        arguments=['up','-d','--no-build','--wait','--wait-timeout','240',*SERVICES]
    elif action=='down':arguments=['stop',*reversed(SERVICES)]
    else:arguments=['ps',*SERVICES]
    # Compose's own wait ends first; the extra minute covers pulling up and reporting.
    return subprocess.call(command+['--profile','honcho']+arguments,env=env,timeout=300 if action=='up' else 120)
