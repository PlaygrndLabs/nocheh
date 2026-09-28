#!/usr/bin/env python3
"""Local Compose entrypoint. No provider keys, package installs or VPS required."""
from tools.paths import ROOT as REPO_ROOT
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from tools.operations.installation.configuration import initialize, load, write_env, env_path, compose_environment, compose_command, DEFAULT_STATE, INSTALLATION_ROOT

ROOT = REPO_ROOT
STATE = Path(os.environ.get("NOCHEH_STATE_DIR", str(DEFAULT_STATE))).resolve()


def bootstrap():
    initialize(STATE)
    # Transfer the dedicated test login once. There must be only one refresh owner.
    prior = ROOT / "data/compat/hermes-auth/auth.json"
    current = STATE / "hermes/auth.json"
    if STATE == ROOT / "data/local" and prior.is_file() and not current.exists():
        shutil.move(prior, current)
        current.chmod(0o600)
        print("Transferred the dedicated Hermes login into the Compose runtime.")


def run_isolated_tests(rest):
    # A test run owns a fresh Compose project and generated fixture credentials.
    # It never starts, reads, or tears down the installation's database project.
    with tempfile.TemporaryDirectory(prefix='nocheh-test-') as folder:
        state = Path(folder)
        initialize(state)
        sys.path.insert(0, str(ROOT))
        from tools.operations.provider.provider import ensure_source, ensure_monitor_source
        ensure_source(); ensure_monitor_source()
        from tools.acceptance.subscription.setup import checkout, LOCK
        checkout('hermes-agent', LOCK['hermes'])
        project = state.name
        command = compose_command(state, project) + ['-f', str(INSTALLATION_ROOT / 'docker-compose.dev.yml')]
        env = compose_environment(state)
        env['COMPOSE_PROJECT_NAME'] = project
        env['NOCHEH_AGENT_NETWORK'] = project + '-agent'
        env['NOCHEH_MEMORY_NETWORK'] = project + '-memory'
        try:
            result = subprocess.call(command + ['up', '-d', '--wait', 'nocheh-db'], cwd=ROOT, env=env)
            if result == 0:
                result = subprocess.call(command + ['run', '--rm', '--build', '--no-deps',
                    'nocheh-app', 'npm', 'test'] + rest, cwd=ROOT, env=env)
            if result == 0:
                result = subprocess.call(command + ['run', '--rm', '--no-deps',
                    '-e', 'NOCHEH_WORKFLOW_FIXTURE=1', 'nocheh-app', 'node', '--test',
                    'dist/test/database-recovery.test.js'], cwd=ROOT, env=env)
            if result == 0:
                result = subprocess.call(command + ['build', 'hermes'], cwd=ROOT, env=env)
            if result == 0:
                # Native unit tests get only a synthetic token, no Compose secrets.
                result = subprocess.call(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,mode=1777', '--entrypoint', 'python',
                    '-e', 'HERMES_HOME=/tmp/nocheh-tests', '-e', 'SERVICE_TOKEN=test-service-token',
                    'nocheh-hermes:local', '-m', 'unittest', 'discover', '-s', 'services/hermes',
                    '-t', '.', '-p', 'test_*.py', '-q'], cwd=ROOT, env=env)
        finally:
            cleanup = subprocess.call(command + ['down', '--volumes', '--remove-orphans'], cwd=ROOT, env=env)
        return result or cleanup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "up", "dev", "dev-stop", "dev-status", "down", "status", "logs", "build", "test", "verify", "login", "provider", "config", "group-access", "discover-telegram", "configure-telegram", "backup", "restore", "diagnose", "db", "dashboard", "jobs", "import", "memory", "honcho", "runtime", "policy", "approvals", "cron", "export", "compatibility", "workflows", "sources", "projects", "learned", "sharing", "reset", "admin", "deploy", "archive", "security", "security-profiles"))
    args=parser.parse_args(sys.argv[1:2]);rest=sys.argv[2:]
    if args.command == 'admin':
        sys.path.insert(0, str(ROOT))
        from tools.cli.admin import main as admin
        return admin(rest)
    if args.command == 'deploy':
        sys.path.insert(0, str(ROOT))
        from tools.operations.installation.deploy import main as deploy
        return deploy(rest)
    if args.command == 'archive':
        from tools.operations.archive.archive import main as archive
        return archive(rest)
    if args.command == 'security':
        from tools.operations.security.security import main as security
        return security(rest)
    if args.command == 'security-profiles':
        from tools.operations.security.security_profiles import main as security_profiles
        return security_profiles(rest)
    if args.command in ('dev', 'dev-stop', 'dev-status'):
        sys.path.insert(0, str(ROOT))
        from tools.development.live_dev import main as live_dev
        return live_dev(args.command, rest)
    if args.command == 'test':
        return run_isolated_tests(rest)
    if args.command=='reset':
        sys.path.insert(0,str(ROOT))
        from tools.acceptance.reset_inventory import main as reset_inventory
        return reset_inventory(STATE,rest)
    if args.command in ('sources','projects','learned','sharing'):
        sys.path.insert(0,str(ROOT))
        from tools.operations.archive.knowledge import main as knowledge
        return knowledge(args.command,rest)
    if args.command=='workflows':
        sys.path.insert(0,str(ROOT))
        from tools.operations.workflows.workflows import main as workflows
        return workflows(STATE,rest)
    if args.command=='import' and ('--portable' in rest or '--honcho-memory' in rest):
        sys.path.insert(0,str(ROOT))
        from tools.operations.archive.portable import import_main
        return import_main(STATE,rest)
    if args.command=='export':
        sys.path.insert(0,str(ROOT))
        from tools.operations.archive.portable import main as portable
        return portable(STATE,rest)
    if args.command=='compatibility':
        sys.path.insert(0,str(ROOT))
        from tools.acceptance.compatibility import main as compatibility
        return compatibility(STATE,rest)
    if args.command=='cron':
        bootstrap();sys.path.insert(0,str(ROOT))
        from tools.operations.security.cron import main as cron
        return cron(STATE,rest)
    if args.command in ('backup','restore','diagnose'):
        sys.path.insert(0,str(ROOT))
        from tools.operations.installation.operations import main as operations
        return operations(args.command,STATE,rest)
    bootstrap()
    if args.command == 'group-access':
        sys.path.insert(0, str(ROOT))
        from tools.operations.security.group_access import main as group_access
        return group_access(STATE, rest)
    if args.command=='provider':
        sys.path.insert(0,str(ROOT))
        from tools.operations.provider.provider import main as provider
        return provider(STATE,rest)
    if args.command=='approvals':
        sys.path.insert(0,str(ROOT))
        from tools.operations.security.approvals import main as approvals
        return approvals(STATE,rest)
    if args.command in ('runtime', 'policy'):
        sys.path.insert(0, str(ROOT))
        from tools.operations.security.native import main as native
        return native(STATE, args.command, rest)
    if args.command == 'honcho':
        sys.path.insert(0, str(ROOT))
        from tools.operations.memory.honcho import main as honcho
        return honcho(rest)
    if args.command == 'memory':
        sys.path.insert(0, str(ROOT))
        if rest and rest[0] in ('honcho','spaces','policy','shares','share','revoke','preview','recall','reviews','review','pause','resume'):
            from tools.operations.memory.memory import main as memory
            return memory(rest)
        from tools.runtime.management import dispatch
        memory_parser=argparse.ArgumentParser(description='Inspect native Hermes memory without model calls.')
        memory_parser.add_argument('action',choices=('list','show','preferences','graph'))
        memory_parser.add_argument('--output',type=Path);memory_parser.add_argument('--after',default='');memory_parser.add_argument('--scope');memory_parser.add_argument('--session')
        memory_parser.add_argument('--offset',type=int,default=0);memory_parser.add_argument('--profile')
        selected=memory_parser.parse_args(rest)
        if selected.action!='list' and not selected.scope:memory_parser.error('--scope is required')
        if selected.action=='graph':
            from tools.operations.archive.graph import read
            result=read(selected.scope,selected.after)
            encoded=json.dumps(result,ensure_ascii=False,indent=2)
            if selected.output:
                with selected.output.open('x') as file:file.write(encoded+'\n')
                selected.output.chmod(0o600)
            else:print(encoded)
            return 0
        result=dispatch({'operation':'hermes.manage','request':{'action':{'list':'profiles','show':'memory','preferences':'preferences'}[selected.action],
                        'scope':selected.scope,'profile':selected.profile,'session':selected.session,'offset':selected.offset}})
        print(json.dumps(result,ensure_ascii=False,indent=2));return 0
    if args.command in ('dashboard', 'jobs', 'import'):
        sys.path.insert(0, str(ROOT))
        if args.command == 'dashboard':
            from tools.operations.installation.dashboard import start
            return start(STATE, rest)
        if args.command == 'jobs':
            from tools.operations.installation.dashboard import request
            if rest == ['list']: result = request(STATE, '/jobs')
            elif len(rest) == 2 and rest[0] == 'show': result = request(STATE, '/jobs/' + rest[1])
            else: parser.error('Use jobs list or jobs show JOB_ID.')
            print(json.dumps(result, indent=2)); return 0
        if rest and rest[0]=='sources':
            return subprocess.call([sys.executable,'-m','tools.operations.archive.archive','import']+rest[1:],cwd=ROOT)
        if not rest or rest[0] != 'telegram': parser.error('Use import telegram FILE [--scope ID] or import sources DIRECTORY.')
        return subprocess.call([sys.executable, '-m', 'tools.operations.archive.archive', 'import-telegram'] + rest[1:], cwd=ROOT)
    if args.command == 'config' and rest:
        from tools.operations.installation.settings import view, save, apply
        action, *parts = rest
        if action == 'show' and not parts: result = view(STATE)
        elif action == 'apply' and not parts: result = apply(STATE)
        elif action == 'set' and len(parts) in (1, 2):
            from tools.operations.installation.settings import SECRETS
            key = parts[0]
            if key in SECRETS and len(parts) == 2:
                parser.error('Use a hidden prompt or piped stdin for secret values.')
            if len(parts) == 2: value = parts[1]
            elif sys.stdin.isatty():
                from getpass import getpass
                value = getpass(key + ': ')
            else: value = sys.stdin.read(65536).rstrip('\r\n')
            result = save(STATE, {key: value}, view(STATE)['revision'])
        else: parser.error('Use config show, config set KEY [VALUE], or config apply.')
        print(json.dumps(result, indent=2)); return 1 if result.get('status') == 'apply_failed' else 0
    if args.command == "init":
        print("Local configuration ready. Edit " + str(env_path(STATE))); return 0
    if args.command=='configure-telegram':
        config_parser=argparse.ArgumentParser(description='Enable the owner DM and explicitly selected groups; token stays in .env.')
        config_parser.add_argument('--owner-id',required=True)
        config_parser.add_argument('--group-id',action='append',default=[])
        selected=config_parser.parse_args(rest)
        if not re.fullmatch(r'[1-9]\d{0,18}',selected.owner_id) or any(not re.fullmatch(r'-\d{1,19}',g) for g in selected.group_id):config_parser.error('Use numeric Telegram IDs; group IDs are negative.')
        values=load(STATE)
        if not values['TELEGRAM_BOT_TOKEN']:config_parser.error('Set TELEGRAM_BOT_TOKEN in .env first.')
        values.update(TELEGRAM_ENABLED='true',TELEGRAM_OWNER_ID=selected.owner_id,TELEGRAM_GROUP_IDS=','.join(dict.fromkeys(selected.group_id)))
        write_env(env_path(STATE),values)
        print('Telegram policy saved. Run ./bin/nocheh up to apply it.');return 0
    env = compose_environment(STATE)
    if args.command in ('up','dev') and env.get('NOCHEH_HONCHO_ENABLED')=='true':
        sys.path.insert(0,str(ROOT))
        from tools.operations.memory.honcho_runtime import normalize_endpoints
        normalize_endpoints(env.get('NOCHEH_HONCHO_STATE_DIR') or STATE/'honcho')
    if args.command in ('up','dev','build'):
        sys.path.insert(0,str(ROOT))
        from tools.operations.provider.provider import ensure_source,ensure_monitor_source
        ensure_source();ensure_monitor_source()
        from tools.acceptance.subscription.setup import checkout,LOCK
        checkout('hermes-agent',LOCK['hermes'])
    command = compose_command(STATE)
    if args.command == 'db':
        from tools.operations.installation.database_viewer import start
        return start(STATE, command, ROOT)
    if args.command in ('down', 'status', 'logs'):
        command += ['--profile', 'tools','--profile','honcho','--profile','honcho-tools']
    if args.command=='status':
        sys.path.insert(0,str(ROOT))
        from tools.operations.installation.services import containers,describe,host_status
        for row in describe(containers(command,env),load(STATE),host_status(STATE)):
            print(f"{row['service']}: {row['state']} (expected {row['expected_state']})\n  {row['tool']} · {row['location']} · {row['purpose']}")
        return 0
    if args.command=='down':
        sys.path.insert(0,str(ROOT))
        from tools.operations.workflows.workflow_worker import stop as stop_workflows
        stop_workflows(STATE,wait=True)
    actions = {
        "up": ["up", "-d", "--build", "--wait", "--wait-timeout", "180"],
        "down": ["down"], "status": ["ps"],
        "logs": ["logs", "--tail", "100", "-f"], "build": ["build"],
        "verify": ["exec", "-T", "hermes", "python", "-m", "services.hermes.verify", "--live"],
        "config": ["config", "--quiet"],
        "discover-telegram": ["exec", "-T", "hermes", "python", "-m", "services.hermes.discover_telegram"],
        "login": ["exec", "hermes", "python", "-c",
            "from hermes_cli.auth_codex import _codex_device_code_login,_save_codex_tokens; r=_codex_device_code_login(); _save_codex_tokens(r['tokens'],last_refresh=r.get('last_refresh')); print('Hermes login saved')"],
    }
    result = subprocess.call(command + actions[args.command] + rest, cwd=ROOT, env=env)
    if args.command=='up' and result==0:
        result=subprocess.call(['docker','build','-f',str(INSTALLATION_ROOT/'deploy/tools.Dockerfile'),'-t','nocheh-tools:local',str(INSTALLATION_ROOT)],cwd=ROOT,env=env)

    return result


if __name__ == "__main__":
    raise SystemExit(main())
