"""Production Honcho uses the installation's Compose project and protected state."""
import hashlib
import subprocess
from pathlib import Path
from .configuration import load,write_env,read_env,env_path
from .provider import compose

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


def ensure_inactive_experiment():
    running=subprocess.check_output(['docker','ps','-q','--filter','label=com.docker.compose.project=nocheh-honcho-experiment'],text=True,timeout=20)
    if running.strip():raise ValueError('honcho_legacy_project_requires_quiesced_migration')


def enable(state,honcho_state):
    state=Path(state);honcho_state=Path(honcho_state).resolve()
    if (state/'spool/.restore-inactive').exists():raise ValueError('inactive_restore')
    ensure_inactive_experiment()
    values=load(state)
    token=(honcho_state/'internal_token').read_text().strip()
    if values.get('NOCHEH_MEMORY_TOKEN')!=token:raise ValueError('honcho_runtime_init_required')
    if not values.get('NOCHEH_HONCHO_DATABASE_VOLUME'):
        legacy=subprocess.run(['docker','volume','inspect','nocheh-honcho-experiment_database'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if legacy.returncode==0:raise ValueError('honcho_legacy_data_requires_verified_adoption')
    suffix=hashlib.sha256(str(state.resolve()).encode()).hexdigest()[:12]
    # Explicitly recorded volumes survive Compose down and worktree cleanup.
    # A legacy volume is adopted only by the separately verified migration.
    for kind in ('DATABASE','REDIS'):
        key='NOCHEH_HONCHO_'+kind+'_VOLUME'
        if values.get(key):
            subprocess.run(['docker','volume','inspect',values[key]],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        else:
            values[key]='nocheh_honcho_'+suffix+'_'+kind.lower()
            subprocess.run(['docker','volume','create',values[key]],check=True,stdout=subprocess.DEVNULL)
    values.update(NOCHEH_HONCHO_ENABLED='true',NOCHEH_HONCHO_STATE_DIR=str(honcho_state))
    normalize_endpoints(honcho_state)
    write_env(env_path(state),values)


def operate(state,action):
    if action not in ('up','down','status'):raise ValueError('honcho_operation_invalid')
    command,env=compose(state)
    if action=='up':
        if (Path(state)/'spool/.restore-inactive').exists():raise ValueError('inactive_restore')
        ensure_inactive_experiment()
        normalize_endpoints(env['NOCHEH_HONCHO_STATE_DIR'])
        arguments=['up','-d','--no-build','--wait','--wait-timeout','240',*SERVICES]
    elif action=='down':arguments=['stop',*reversed(SERVICES)]
    else:arguments=['ps',*SERVICES]
    return subprocess.call(command+['--profile','honcho']+arguments,env=env)
