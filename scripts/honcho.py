"""Operate and inspect the production Honcho installation."""
import json
import subprocess

from integrations.honcho.cli.cli_runner import validate
from scripts.honcho_setup import ROOT, STATE, PROVIDER_STATE, initialize, sources, runtime_init, runtime_up, monthly
from scripts.honcho_runtime import enabled, operate
from scripts.provider import compose, login, login_state


def status():
    result = {
        'running': False,
        'cli_version': '0.1.4',
        'api_budget_usd': 5,
        'embedding_credential': bool(
            (STATE / 'temporary_embedding_key').exists()
            and (STATE / 'temporary_embedding_key').stat().st_size
        ),
        'subscription_login': login_state(PROVIDER_STATE)['login_present'],
    }
    if enabled(PROVIDER_STATE):
        command, env = compose(PROVIDER_STATE)
        try:
            raw = subprocess.check_output(
                command + ['--profile', 'honcho', 'ps', '--services', '--status', 'running'],
                cwd=ROOT, env=env, text=True, stderr=subprocess.DEVNULL, timeout=15,
            )
            result['running'] = 'honcho-api' in raw.split()
        except (subprocess.SubprocessError, OSError):
            pass
    return result


def read(args):
    validate(args)
    if not status()['running']:
        return {'error': 'honcho_not_running', 'complete': False}
    command, env = compose(PROVIDER_STATE)
    process = subprocess.run(
        command + ['--profile', 'honcho', '--profile', 'honcho-tools',
                   'run', '--rm', '--no-deps', '-T', 'honcho-cli'] + args,
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=120,
    )
    try:
        return json.loads(process.stdout)
    except ValueError:
        return {'error': 'honcho_cli_unavailable_run_honcho_install', 'complete': False}


def main(args):
    try:
        if args == ['doctor']:
            result = status()
        elif args == ['init']:
            initialize()
            sources()
            result = {'initialized': True}
        elif args == ['install']:
            command, env = compose(PROVIDER_STATE)
            return subprocess.call(command + ['--profile', 'honcho-tools', 'build', 'honcho-cli'], cwd=ROOT, env=env)
        elif args == ['login']:
            return login(PROVIDER_STATE)
        elif args == ['runtime-init']:
            initialize()
            runtime_init()
            result = {'runtime_credential_installed': True}
        elif args == ['runtime-up']:
            initialize()
            return runtime_up()
        elif args == ['monthly']:
            monthly()
            result = {'monthly_budget_enabled': True}
        elif len(args) == 1 and args[0] in ('up', 'down', 'status'):
            if not enabled(PROVIDER_STATE):
                result = {'error': 'honcho_not_enabled'}
            else:
                return operate(PROVIDER_STATE, args[0])
        else:
            result = read(args)
    except ValueError as error:
        result = {'error': str(error), 'complete': False}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if 'error' in result else 0
