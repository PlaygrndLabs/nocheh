"""Configure pinned production Honcho without changing existing memory storage."""
import json
import os
import secrets
import subprocess
from pathlib import Path

ROOT=Path(os.environ.get('NOCHEH_INSTALLATION_ROOT',Path(__file__).resolve().parents[2])).resolve()
PROVIDER_STATE=Path(os.environ.get('NOCHEH_STATE_DIR',ROOT/'data/local')).resolve()
from scripts.configuration import read_env,env_path
STATE=Path(read_env(env_path(PROVIDER_STATE)).get('NOCHEH_HONCHO_STATE_DIR') or
           (ROOT/'data/honcho-experiment' if PROVIDER_STATE==ROOT/'data/local' else PROVIDER_STATE/'honcho')).resolve()


def initialize():
    from scripts.configuration import read_env
    from scripts.embedding_config import embeddings
    values=read_env(env_path(PROVIDER_STATE));embedding=embeddings(values)
    for directory in ('','ledger'):
        (STATE/directory).mkdir(parents=True,exist_ok=True,mode=0o700)
    for name in ('internal_token','database_password','temporary_embedding_key'):
        path=STATE/name
        if not path.exists(): path.write_text('' if name=='temporary_embedding_key' else secrets.token_hex(32))
        path.chmod(0o600)
    # Only the owner-designated embedding key. Never use unrelated provider keys.
    # Explicitly empty OPENAI_API_KEY revokes the saved key. The old dedicated
    # name is accepted only when the new setting is absent; never use shell keys.
    if 'OPENAI_API_KEY' in values or 'NOCHEH_EMBEDDING_API_KEY' in values:
        dedicated=values.get('OPENAI_API_KEY',values.get('NOCHEH_EMBEDDING_API_KEY','')).strip()
        (STATE/'temporary_embedding_key').write_text(dedicated)
        (STATE/'temporary_embedding_key').chmod(0o600)
    token=(STATE/'internal_token').read_text().strip()
    password=(STATE/'database_password').read_text().strip()
    (STATE/'meter.env').write_text(f'NOCHEH_EMBEDDING_PROVIDER={embedding.provider}\nNOCHEH_EMBEDDING_MODEL={embedding.model}\nNOCHEH_REASONING_URL=http://shared-provider:8317/v1\n')
    env={'DB_CONNECTION_URI':f'postgresql+psycopg://experiment:{password}@database:5432/honcho_experiment',
         'CACHE_URL':'redis://redis:6379/0?suppress=true','CACHE_ENABLED':'true','AUTH_USE_AUTH':'false',
         'PYTHON_DOTENV_DISABLED':'1','HONCHO_CONFIG_TOML_DISABLED':'1',
         'LLM_OPENAI_API_KEY':token,'NOCHEH_HONCHO_INTERNAL_TOKEN':token,
         'DERIVER_WORKERS':'1','DERIVER_FLUSH_ENABLED':'true',
         'DERIVER_REPRESENTATION_BATCH_WORK_UNIT_TARGET_TOKENS':'0',
         'DERIVER_REPRESENTATION_BATCH_MAX_AGE_SECONDS':'1',
         'DERIVER_POLLING_STARTUP_JITTER_SECONDS':'0','DERIVER_POLLING_BACKOFF_ENABLED':'false',
         'DREAM_ENABLED':'false','SUMMARY_ENABLED':'true','EMBED_MESSAGES':'true','LOG_LEVEL':'WARNING',
         'EMBEDDING_VECTOR_DIMENSIONS':str(embedding.dimensions),'EMBEDDING_MODEL_CONFIG__TRANSPORT':embedding.provider,
         'EMBEDDING_MODEL_CONFIG__MODEL':embedding.model,
         'EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL':'http://meter:8790/v1',
         'EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV':'NOCHEH_HONCHO_INTERNAL_TOKEN'}
    prefixes=['DERIVER_MODEL_CONFIG','SUMMARY_MODEL_CONFIG','DREAM_DEDUCTION_MODEL_CONFIG','DREAM_INDUCTION_MODEL_CONFIG']
    prefixes += [f'DIALECTIC_LEVELS__{level}__MODEL_CONFIG' for level in ('minimal','low','medium','high','max')]
    for prefix in prefixes:
        env.update({prefix+'__TRANSPORT':'openai',prefix+'__MODEL':'gpt-5.6-sol',
                    prefix+'__OVERRIDES__BASE_URL':'http://meter:8790/v1',
                    prefix+'__OVERRIDES__API_KEY_ENV':'NOCHEH_HONCHO_INTERNAL_TOKEN'})
    env['DERIVER_MODEL_CONFIG__STRUCTURED_OUTPUT_MODE']='json_object'
    for level in ('minimal','low','medium','high','max'): env[f'DIALECTIC_LEVELS__{level}__MAX_OUTPUT_TOKENS']='2500'
    (STATE/'honcho.env').write_text(''.join(f'{key}={value}\n' for key,value in env.items()))
    for name in ('honcho.env','meter.env'): (STATE/name).chmod(0o600)
    if values.get('NOCHEH_HONCHO_ENABLED')=='true':
        from scripts.honcho_runtime import normalize_endpoints
        normalize_endpoints(STATE)


def sources():
    pins=json.loads((ROOT/'integrations/honcho/upstreams.lock.json').read_text())
    for name,pin in pins.items():
        if not isinstance(pin,dict) or 'repository' not in pin: continue
        path=ROOT/'data/compat/upstreams/honcho'
        if not path.exists():
            subprocess.run(['git','clone','--no-checkout',pin['repository'],str(path)],check=True)
            subprocess.run(['git','-C',str(path),'checkout','--detach',pin['revision']],check=True)
        actual=subprocess.check_output(['git','-C',str(path),'rev-parse','HEAD'],text=True).strip()
        if actual!=pin['revision']: raise SystemExit(f'{name}: source revision differs from the Honcho lock')
    # Honcho must tokenize with its network disabled. Populate verified public
    # tokenizer assets during the build, before any runtime credentials exist.
    def pinned(text):
        text='\n'.join(line for line in text.splitlines() if not line.startswith('# syntax='))+'\n'
        for name,value in pins['build_images'].items(): text=text.replace(name,value)
        return text
    upstream=pinned((ROOT/'data/compat/upstreams/honcho/Dockerfile').read_text())
    (STATE/'honcho.Dockerfile').write_text(upstream+'\nENV TIKTOKEN_CACHE_DIR=/app/tokenizer_cache\nRUN python -c "import tiktoken; tiktoken.get_encoding(\'o200k_base\'); tiktoken.get_encoding(\'cl100k_base\')"\n')


def provider_ready():
    from scripts.provider import status
    result=status(PROVIDER_STATE)
    return result['healthy'] and result['login_present']


def runtime_init():
    from scripts.configuration import write_env
    path=env_path(PROVIDER_STATE);values=read_env(path)
    values['NOCHEH_MEMORY_TOKEN']=(STATE/'internal_token').read_text().strip()
    write_env(path,values)


def runtime_up():
    from scripts.honcho_runtime import enable,operate
    if read_env(env_path(PROVIDER_STATE)).get('NOCHEH_MEMORY_TOKEN')!=(STATE/'internal_token').read_text().strip():
        raise ValueError('honcho_runtime_init_required')
    if not provider_ready():raise ValueError('shared_provider_not_ready')
    sources()
    enable(PROVIDER_STATE,STATE)
    from scripts.provider import compose
    command,env=compose(PROVIDER_STATE)
    subprocess.run(command+['--profile','honcho','build','honcho-api','honcho-deriver'],cwd=ROOT,env=env,check=True)
    return operate(PROVIDER_STATE,'up')


def monthly():
    from scripts.archive import API
    from integrations.honcho.meter import Ledger
    connection=API().call('/v1/memory/honcho')['connection']
    if not connection['verified'] or not connection['attached']:
        raise ValueError('honcho_monthly_requires_accepted_attached_memory')
    Ledger(STATE/'ledger/budget.sqlite').enable_monthly()
