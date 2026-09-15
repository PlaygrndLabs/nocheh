"""Read stored experiment data with the pinned official CLI; no global account."""
import json
import subprocess
from experiments.honcho.control import ROOT, STATE, COMPOSE, PROVIDER_STATE
from experiments.honcho.cli_runner import validate
from scripts.provider import login_state
from scripts.honcho_runtime import enabled,operate
from scripts.provider import compose


def selection():
    if enabled(PROVIDER_STATE):
        command,env=compose(PROVIDER_STATE)
        return command+['--profile','honcho','--profile','honcho-tools'],env
    return COMPOSE,None


def status():
    result={'isolated':True,'running':False,'cli_version':'0.1.4','api_budget_usd':5,
            'live_compatibility':'pending live memory checks',
            'embedding_credential':bool((STATE/'temporary_embedding_key').exists() and (STATE/'temporary_embedding_key').stat().st_size),
            'subscription_login':login_state(PROVIDER_STATE)['login_present']}
    command,env=selection()
    if enabled(PROVIDER_STATE) or (STATE/'compose.env').exists():
        try:
            raw=subprocess.check_output(command+['ps','--services','--status','running'],cwd=ROOT,env=env,text=True,stderr=subprocess.DEVNULL,timeout=15)
            result['running']=('honcho-api' if enabled(PROVIDER_STATE) else 'honcho') in raw.split()
        except (subprocess.SubprocessError,OSError): pass
    return result


def read(args):
    validate(args)
    if not status()['running']: return {'error':'honcho_not_running','complete':False}
    command,env=selection()
    process=subprocess.run(command+['run','--rm','--no-deps','-T',('honcho-cli' if enabled(PROVIDER_STATE) else 'cli')]+args,cwd=ROOT,env=env,capture_output=True,text=True,timeout=120)
    try: result=json.loads(process.stdout)
    except ValueError: result={'error':'honcho_cli_unavailable_run_honcho_install','complete':False}
    return result


def main(args):
    if args==['doctor']: result=status()
    elif args==['install']:
        if not (STATE/'compose.env').exists():
            print(json.dumps({'error':'initialize_with_scripts_honcho_experiment_init'}));return 1
        command,env=selection()
        return subprocess.call(command+['build',('honcho-cli' if enabled(PROVIDER_STATE) else 'cli')],cwd=ROOT,env=env)
    elif args and args[0] in ('up','down','status') and enabled(PROVIDER_STATE):
        return operate(PROVIDER_STATE,args[0])
    elif args and args[0] in ('init','up','down','status','login'):
        return subprocess.call([str(ROOT/'scripts/honcho-experiment')]+args,cwd=ROOT)
    else:
        try: result=read(args)
        except ValueError as error: result={'error':str(error),'complete':False}
    print(json.dumps(result,ensure_ascii=False,indent=2));return 1 if 'error' in result else 0
