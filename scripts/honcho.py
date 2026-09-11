"""Read stored experiment data with the pinned official CLI; no global account."""
import json
import subprocess
from experiments.honcho.control import ROOT, STATE, COMPOSE
from experiments.honcho.cli_runner import validate


def status():
    result={'isolated':True,'running':False,'cli_version':'0.1.4','api_budget_usd':5,
            'live_compatibility':'pending separate experiment credentials',
            'embedding_credential':bool((STATE/'temporary_embedding_key').exists() and (STATE/'temporary_embedding_key').stat().st_size),
            'subscription_login':any((STATE/'bridge-auth').glob('*.json'))}
    if (STATE/'compose.env').exists():
        try:
            raw=subprocess.check_output(COMPOSE+['ps','--services','--status','running'],cwd=ROOT,text=True,stderr=subprocess.DEVNULL,timeout=15)
            result['running']='honcho' in raw.split()
        except (subprocess.SubprocessError,OSError): pass
    return result


def read(args):
    validate(args)
    if not status()['running']: return {'error':'honcho_experiment_not_running','complete':False}
    process=subprocess.run(COMPOSE+['run','--rm','--no-deps','-T','cli']+args,cwd=ROOT,capture_output=True,text=True,timeout=120)
    try: result=json.loads(process.stdout)
    except ValueError: result={'error':'honcho_cli_unavailable_run_honcho_install','complete':False}
    return result


def main(args):
    if args==['doctor']: result=status()
    elif args==['install']:
        if not (STATE/'compose.env').exists():
            print(json.dumps({'error':'initialize_with_scripts_honcho_experiment_init'}));return 1
        return subprocess.call(COMPOSE+['build','cli'],cwd=ROOT)
    elif args and args[0] in ('init','up','down','status','login'):
        return subprocess.call([str(ROOT/'scripts/honcho-experiment')]+args,cwd=ROOT)
    else:
        try: result=read(args)
        except ValueError as error: result={'error':str(error),'complete':False}
    print(json.dumps(result,ensure_ascii=False,indent=2));return 1 if 'error' in result else 0
