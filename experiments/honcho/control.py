"""Compose lifecycle for the separate, synthetic-only memory comparison."""
import argparse
import json
import os
import secrets
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
STATE=ROOT/'data/honcho-experiment'
COMPOSE=['docker','compose','--env-file',str(STATE/'compose.env'),'-f',str(ROOT/'experiments/honcho/compose.yml')]


def initialize():
    for directory in ('','ledger','bridge-auth','baseline','reports'):
        (STATE/directory).mkdir(parents=True,exist_ok=True,mode=0o700)
    for name in ('internal_token','database_password','temporary_embedding_key'):
        path=STATE/name
        if not path.exists(): path.write_text('' if name=='temporary_embedding_key' else secrets.token_hex(32))
        path.chmod(0o600)
    # Only the owner-designated embedding key. Never use unrelated provider keys.
    from scripts.configuration import read_env
    dedicated=read_env(ROOT/'.env').get('NOCHEH_EMBEDDING_API_KEY','').strip()
    if dedicated:
        (STATE/'temporary_embedding_key').write_text(dedicated)
        (STATE/'temporary_embedding_key').chmod(0o600)
    token=(STATE/'internal_token').read_text().strip()
    password=(STATE/'database_password').read_text().strip()
    (STATE/'compose.env').write_text(f'NOCHEH_UID={os.getuid()}\nNOCHEH_GID={os.getgid()}\nHONCHO_EXPERIMENT_DOCKERFILE={STATE}/honcho.Dockerfile\nBRIDGE_EXPERIMENT_DOCKERFILE={STATE}/bridge.Dockerfile\n')
    # Only the bridge owns this separate OAuth login. No copying Hermes/Codex auth.
    bridge={'host':'','port':8317,'auth-dir':'/auth','api-keys':[token],
            'remote-management':{'allow-remote':False,'secret-key':'','disable-control-panel':True},
            'plugins':{'enabled':False},'request-retry':0,'max-retry-credentials':1,
            'logging-to-file':False,'request-log':False,'debug':False,
            'quota-exceeded':{'switch-project':False,'switch-preview-model':False}}
    (STATE/'bridge.yaml').write_text(json.dumps(bridge,indent=2)+'\n')  # JSON is valid YAML
    env={'DB_CONNECTION_URI':f'postgresql+psycopg://experiment:{password}@database:5432/honcho_experiment',
         'CACHE_URL':'redis://redis:6379/0?suppress=true','CACHE_ENABLED':'true','AUTH_USE_AUTH':'false',
         'PYTHON_DOTENV_DISABLED':'1','HONCHO_CONFIG_TOML_DISABLED':'1',
         'LLM_OPENAI_API_KEY':token,'EXPERIMENT_INTERNAL_TOKEN':token,
         'DERIVER_WORKERS':'1','DERIVER_FLUSH_ENABLED':'true',
         'DERIVER_REPRESENTATION_BATCH_WORK_UNIT_TARGET_TOKENS':'0',
         'DERIVER_REPRESENTATION_BATCH_MAX_AGE_SECONDS':'1',
         'DERIVER_POLLING_STARTUP_JITTER_SECONDS':'0','DERIVER_POLLING_BACKOFF_ENABLED':'false',
         'DREAM_ENABLED':'false','SUMMARY_ENABLED':'true','LOG_LEVEL':'WARNING',
         'EMBEDDING_VECTOR_DIMENSIONS':'1536','EMBEDDING_MODEL_CONFIG__TRANSPORT':'openai',
         'EMBEDDING_MODEL_CONFIG__MODEL':'text-embedding-3-small',
         'EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL':'http://meter:8790/v1',
         'EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV':'EXPERIMENT_INTERNAL_TOKEN'}
    prefixes=['DERIVER_MODEL_CONFIG','SUMMARY_MODEL_CONFIG','DREAM_DEDUCTION_MODEL_CONFIG','DREAM_INDUCTION_MODEL_CONFIG']
    prefixes += [f'DIALECTIC_LEVELS__{level}__MODEL_CONFIG' for level in ('minimal','low','medium','high','max')]
    for prefix in prefixes:
        env.update({prefix+'__TRANSPORT':'openai',prefix+'__MODEL':'gpt-5.6-sol',
                    prefix+'__OVERRIDES__BASE_URL':'http://meter:8790/v1',
                    prefix+'__OVERRIDES__API_KEY_ENV':'EXPERIMENT_INTERNAL_TOKEN'})
    env['DERIVER_MODEL_CONFIG__STRUCTURED_OUTPUT_MODE']='json_object'
    for level in ('minimal','low','medium','high','max'): env[f'DIALECTIC_LEVELS__{level}__MAX_OUTPUT_TOKENS']='2500'
    (STATE/'honcho.env').write_text(''.join(f'{key}={value}\n' for key,value in env.items()))
    for name in ('compose.env','bridge.yaml','honcho.env'): (STATE/name).chmod(0o600)


def sources():
    pins=json.loads((ROOT/'experiments/honcho/upstreams.lock.json').read_text())
    for name,pin in pins.items():
        if not isinstance(pin,dict) or 'repository' not in pin: continue
        path=ROOT/'data/compat/upstreams'/('CLIProxyAPI' if name=='bridge' else 'honcho')
        if not path.exists():
            subprocess.run(['git','clone','--no-checkout',pin['repository'],str(path)],check=True)
            subprocess.run(['git','-C',str(path),'checkout','--detach',pin['revision']],check=True)
        actual=subprocess.check_output(['git','-C',str(path),'rev-parse','HEAD'],text=True).strip()
        if actual!=pin['revision']: raise SystemExit(f'{name}: source revision differs from the experiment lock')
    # Honcho must tokenize with its network disabled. Populate verified public
    # tokenizer assets during the build, before any runtime credentials exist.
    def pinned(text):
        text='\n'.join(line for line in text.splitlines() if not line.startswith('# syntax='))+'\n'
        for name,value in pins['build_images'].items(): text=text.replace(name,value)
        return text
    upstream=pinned((ROOT/'data/compat/upstreams/honcho/Dockerfile').read_text())
    (STATE/'honcho.Dockerfile').write_text(upstream+'\nENV TIKTOKEN_CACHE_DIR=/app/tokenizer_cache\nRUN python -c "import tiktoken; tiktoken.get_encoding(\'o200k_base\'); tiktoken.get_encoding(\'cl100k_base\')"\n')
    bridge=pinned((ROOT/'data/compat/upstreams/CLIProxyAPI/Dockerfile').read_text())
    (STATE/'bridge.Dockerfile').write_text(bridge.replace('RUN CGO_ENABLED=1','RUN GOMAXPROCS=2 GOFLAGS=-p=2 CGO_ENABLED=1'))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=('init','up','down','status','login','run','test','config'))
    args=parser.parse_args();initialize()
    if args.command=='init':
        sources();print('Experiment initialized; no provider requests were made.');return 0
    if args.command=='test': return subprocess.call(['python3','-m','unittest','experiments.honcho.test_meter','experiments.honcho.test_compare','-v'],cwd=ROOT)
    if args.command=='run':
        if not (STATE/'temporary_embedding_key').read_text().strip(): raise SystemExit('Live evaluation pending: temporary_embedding_key is empty.')
        if not list((STATE/'bridge-auth').glob('*.json')): raise SystemExit('Live evaluation pending: run scripts/honcho-experiment login for the separate bridge login.')
        from .compare import main as compare
        return compare()
    if args.command=='up': sources()
    actions={'up':['up','-d','--build','--wait','--wait-timeout','240'],
             'down':['down'],'status':['ps'],'config':['config','--quiet'],
             'login':['run','--rm','--no-deps','bridge','./CLIProxyAPI','-config','/CLIProxyAPI/config.yaml','-codex-device-login','-no-browser']}
    return subprocess.call(COMPOSE+actions[args.command],cwd=ROOT)
