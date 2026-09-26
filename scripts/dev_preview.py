"""One source-mounted development Compose stack for the selected checkout."""

import hashlib
import json
import os
import socket
import subprocess
from pathlib import Path

from . import configuration

ROOT = Path(__file__).resolve().parents[1]
SERVICES = ('nocheh-dev-builder', 'nocheh-db', 'nocheh-app', 'nocheh-dashboard', 'nocheh-executor',
            'nocheh-security', 'hermes-agent-sb', 'cliproxy-api',
            'cliproxy-monitor', 'inngest-redis', 'inngest-server',
            'chatgpt-speech', 'hermes')
STATE = ROOT / 'data/dev'
MARKER = STATE / '.preview-owner'
PROJECT = 'nocheh-dev-' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]


def assert_private_state():
    if configuration.INSTALLATION_ROOT != ROOT:
        raise ValueError('Development preview must use this checkout as its installation root')
    if (ROOT / 'data').is_symlink() or STATE.is_symlink():
        raise ValueError('Development state must not be a symlink')
    for path in STATE.rglob('*') if STATE.exists() else ():
        if not path.is_symlink():
            continue
        relative = path.relative_to(STATE).as_posix()
        if relative == 'hermes/plugins/nocheh' and path.resolve() == (ROOT / 'integrations/hermes').resolve():
            continue
        if (relative == 'admin/dashboard/home/plugins/nocheh'
                and os.readlink(path) == '/workspace/integrations/hermes'):
            continue
        raise ValueError('Development state contains an unexpected symlink')
    if MARKER.exists():
        if MARKER.is_symlink() or MARKER.read_text() != str(ROOT) + '\n':
            raise ValueError('Development state belongs to another checkout')
    elif STATE.exists() and any(STATE.iterdir()):
        raise ValueError('Existing development state has no checkout ownership marker')


def port_available(port):
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            return False
    return True


def choose_ports():
    start = 23000 + (int(hashlib.sha256(str(ROOT).encode()).hexdigest()[10:14], 16) % 1800) * 10
    for offset in range(1800):
        base = 23000 + ((start - 23000 + offset * 10) % 18000)
        if all(port_available(base + delta) for delta in (0, 3, 5, 6, 7, 8)):
            return base
    raise ValueError('No free local development port block')


def prepare_state():
    assert_private_state()
    if not MARKER.exists():
        STATE.mkdir(parents=True, mode=0o700, exist_ok=True)
        MARKER.write_text(str(ROOT) + '\n')
        MARKER.chmod(0o600)
    values = configuration.initialize(STATE)
    if values.get('NOCHEH_DEV_PORT_BASE'):
        base = int(values['NOCHEH_DEV_PORT_BASE'])
        if not 1024 <= base <= 65527:
            raise ValueError('Invalid development port block')
    else:
        base = choose_ports()
        values['NOCHEH_DEV_PORT_BASE'] = str(base)
        values['NOCHEH_PORT'] = str(base)
        values['NOCHEH_DASHBOARD_PORT'] = str(base + 3)
        values['NOCHEH_WORKFLOW_UI_PORT'] = str(base + 8)
        values['NOCHEH_STORAGE_LAYOUT'] = 'original-only-v1'
        configuration.validate(values)
        configuration.write_env(configuration.env_path(STATE), values)
    for key in ('TELEGRAM_ENABLED', 'NOCHEH_HONCHO_ENABLED'):
        if values.get(key) != 'false':
            raise ValueError(f'Development preview requires {key}=false')
    if values.get('TELEGRAM_BOT_TOKEN') or values.get('TELEGRAM_OWNER_ID') or values.get('NOCHEH_STORAGE_LAYOUT') != 'original-only-v1':
        raise ValueError('Development preview cannot use installation credentials or layout')
    if values.get('OPENAI_API_KEY') or any(next((STATE / path).glob('*.json'), None) for path in ('provider/auth', 'hermes/auth')):
        raise ValueError('Development preview cannot use provider or Hermes login credentials')
    if values.get('NOCHEH_PORT') != str(base) or values.get('NOCHEH_DASHBOARD_PORT') != str(base + 3):
        raise ValueError('Development preview ports do not match the reserved block')
    return values, base


def docker_env(values, base):
    # Do not carry installation credentials, profiles, or ports from the shell.
    keep = ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'SSL_CERT_FILE')
    env = {name: os.environ[name] for name in keep if name in os.environ}
    env.update(values)
    env.update(COMPOSE_PROJECT_NAME=PROJECT, NOCHEH_DEV_PROJECT=PROJECT,
               NOCHEH_DEV_HERMES_BASE=PROJECT + ':hermes-base',
               NOCHEH_INSTALLATION_ROOT=str(ROOT), NOCHEH_STATE_DIR=str(STATE),
               NOCHEH_HONCHO_STATE_DIR=str(STATE / 'honcho'), COMPOSE_PROFILES='',
               COMPOSE_PROGRESS='plain',
               NOCHEH_AGENT_NETWORK=PROJECT + '-agent', NOCHEH_MEMORY_NETWORK=PROJECT + '-memory',
               NOCHEH_PORT=str(base), NOCHEH_DASHBOARD_PORT=str(base + 3),
               NOCHEH_NATIVE_ADMIN_PORT=str(base + 5), NOCHEH_OAUTH_PORT=str(base + 6),
               NOCHEH_PROVIDER_MONITOR_PORT=str(base + 7), NOCHEH_WORKFLOW_UI_PORT=str(base + 8))
    return env


def inspect_project(env):
    ids = subprocess.check_output(
        ['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + PROJECT],
        cwd=ROOT, env=env, text=True).split()
    if not ids:
        return []
    containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], cwd=ROOT, env=env, text=True))
    for container in containers:
        labels = container['Config']['Labels'] or {}
        if (labels.get('com.docker.compose.project.working_dir') != str(ROOT)
                or labels.get('com.docker.compose.service') not in SERVICES):
            raise ValueError('Development Compose project is owned by another checkout or service')
    return containers


def assert_single_running_stack(env):
    ids = subprocess.check_output(
        ['docker', 'ps', '-q', '--filter', 'label=com.docker.compose.project'],
        cwd=ROOT, env=env, text=True).split()
    if not ids:
        return
    containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids], cwd=ROOT, env=env, text=True))
    for container in containers:
        labels = container['Config']['Labels'] or {}
        project = labels.get('com.docker.compose.project')
        service = labels.get('com.docker.compose.service')
        if (project != PROJECT and isinstance(service, str)
                and (service in SERVICES or service.startswith(('honcho-', 'nocheh-reset-'))
                     or service == 'pgweb-archive')):
            raise ValueError(f'Another Nocheh Compose stack ({project}) is running; stop it before make dev')


def assert_networks(env):
    for name in (PROJECT + '-agent', PROJECT + '-memory', PROJECT + '_default', PROJECT + '_workflows'):
        result = subprocess.run(['docker', 'network', 'inspect', name], cwd=ROOT, env=env,
                                capture_output=True, text=True)
        if result.returncode:
            continue
        for network in json.loads(result.stdout):
            if (network.get('Labels') or {}).get('com.docker.compose.project') != PROJECT:
                raise ValueError(f'Development network {name} belongs to another project')


def assert_ports(base, containers):
    owned = set()
    for container in containers:
        if not container['State']['Running']:
            continue
        for bindings in (container['NetworkSettings'].get('Ports') or {}).values():
            for binding in bindings or []:
                owned.add(int(binding['HostPort']))
    for port in (base, base + 3, base + 5, base + 6, base + 7):
        if port not in owned and not port_available(port):
            raise ValueError(f'Local development port {port} is in use by another process')


def prepare_source_mounts():
    # Nested named volumes need existing mount points under read-only source
    # binds. These ignored directories hold no generated output on the host.
    for relative in ('web/dist', 'integrations/hermes/dashboard/dist'):
        path = ROOT / relative
        if path.is_symlink():
            raise ValueError(f'Development source mount {relative} must not be a symlink')
        path.mkdir(exist_ok=True)


def prepare_runtime_images(env):
    """Reuse only revision-checked, credential-free pinned image contents."""
    locks = json.loads((ROOT / 'compatibility/upstreams.lock.json').read_text())
    sources = (
        ('nocheh-hermes:local', locks['hermes']['revision'], PROJECT + ':hermes-base'),
        ('nocheh-cliproxy:c76dfd4e', locks['cliproxy']['revision'], PROJECT + ':cliproxy'),
        (locks['cpamp']['image'], locks['cpamp']['revision'], PROJECT + ':monitor'),
    )
    for source, revision, destination in sources:
        def image_revision(tag):
            result = subprocess.run(['docker', 'image', 'inspect', '--format',
                                     '{{ index .Config.Labels "org.opencontainers.image.revision" }}', tag],
                                    cwd=ROOT, env=env, capture_output=True, text=True)
            return result.stdout.strip() if result.returncode == 0 else None
        saved = image_revision(destination)
        if saved == revision:
            continue
        if saved is not None:
            raise ValueError(f'Development image {destination} has the wrong pinned revision')
        if image_revision(source) != revision:
            raise ValueError(f'Pinned runtime image {source} is unavailable or has the wrong revision; build the pinned local runtime images before starting the full development stack')
        subprocess.run(['docker', 'tag', source, destination], cwd=ROOT, env=env,
                       check=True, capture_output=True)


def main(action, rest):
    if rest:
        raise ValueError('Use make dev, make dev-status, or make dev-stop without extra arguments')
    assert_private_state()
    if action != 'dev' and not MARKER.exists():
        print('No development preview exists for this checkout.')
        return 0
    values, base = prepare_state()
    env = docker_env(values, base)
    containers = inspect_project(env)
    assert_networks(env)
    command = configuration.compose_command(STATE, PROJECT) + ['-f', str(ROOT / 'deploy/dev-preview-compose.yml')]
    if action == 'dev-stop':
        return subprocess.call(command + ['down'], cwd=ROOT, env=env)
    if action == 'dev-status':
        return subprocess.call(command + ['ps'], cwd=ROOT, env=env)
    assert_single_running_stack(env)
    assert_ports(base, containers)
    prepare_source_mounts()
    prepare_runtime_images(env)
    print(f'Development preview: http://127.0.0.1:{base + 3}/', flush=True)
    print(f'Checkout: {ROOT}\nCompose project: {PROJECT}\nState: {STATE}', flush=True)
    try:
        return subprocess.call(command + ['up', '--build', *SERVICES], cwd=ROOT, env=env)
    except KeyboardInterrupt:
        return 130
