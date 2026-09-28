"""Source-watched development against the stopped operating installation."""

from tools.paths import ROOT

import json
import os
import socket
import subprocess
from pathlib import Path

from tools.operations.installation import configuration

PROJECT = 'nocheh'
DEV_IMAGES = 'nocheh-dev'
SERVICES = ('nocheh-db', 'nocheh-app', 'nocheh-dashboard', 'nocheh-executor',
            'nocheh-security', 'hermes-agent-sb', 'cliproxy-api',
            'cliproxy-monitor', 'inngest-redis', 'inngest-server',
            'chatgpt-speech', 'hermes', 'honcho-postgres', 'honcho-redis',
            'honcho-provider-gateway', 'honcho-api', 'honcho-deriver')
PORTS = (8780, 8783, 8785, 1455, 18317)


def port_available(port):
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            return False
    return True


def assert_ports(containers):
    owned = set()
    for container in containers:
        if not container['State']['Running']:
            continue
        for bindings in (container['NetworkSettings'].get('Ports') or {}).values():
            for binding in bindings or []:
                owned.add(int(binding['HostPort']))
    for port in PORTS:
        if port not in owned and not port_available(port):
            raise ValueError(f'Local development port {port} is in use by another process')


def prepare_source_mounts():
    # Nested named volumes need existing mount points under read-only source
    # binds. These ignored directories hold no generated output on the host.
    for relative in ('dashboard/dist', 'services/hermes/dashboard/dist'):
        path = ROOT / relative
        if path.is_symlink():
            raise ValueError(f'Development source mount {relative} must not be a symlink')
        path.mkdir(exist_ok=True)


def prepare_runtime_images(env):
    """Reuse only revision-checked, credential-free pinned image contents."""
    locks = json.loads((ROOT / 'deploy/upstreams.lock.json').read_text())
    sources = (
        ('nocheh-hermes:local', locks['hermes']['revision'], DEV_IMAGES + ':hermes-base'),
        ('nocheh-cliproxy:c76dfd4e', locks['cliproxy']['revision'], DEV_IMAGES + ':cliproxy'),
        (locks['cpamp']['image'], locks['cpamp']['revision'], DEV_IMAGES + ':monitor'),
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
    honcho_source = 'nocheh-honcho:' + json.loads((ROOT / 'services/honcho/upstreams.lock.json').read_text())['honcho']['revision'][:8]
    if subprocess.run(['docker', 'image', 'inspect', honcho_source], cwd=ROOT, env=env,
                      capture_output=True).returncode:
        raise ValueError(f'Pinned Honcho image {honcho_source} is unavailable')
    subprocess.run(['docker', 'tag', honcho_source, DEV_IMAGES + ':honcho'], cwd=ROOT, env=env,
                   check=True, capture_output=True)


def operating_root():
    output = subprocess.check_output(['git', 'worktree', 'list', '--porcelain'], cwd=ROOT, text=True)
    entries = [block.splitlines() for block in output.strip().split('\n\n')]
    matches = [Path(lines[0][len('worktree '):]).resolve() for lines in entries
               if lines and lines[0].startswith('worktree ') and 'branch refs/heads/main' in lines]
    if len(matches) != 1 or not (matches[0] / '.env').is_file():
        raise ValueError('Expected one operating main checkout with an existing .env')
    return matches[0]


def operating_config(root):
    path = root / '.env'
    if path.is_symlink() or (root / 'data/local').is_symlink():
        raise ValueError('Operating configuration or state must not be a symlink')
    saved = configuration.read_env(path)
    if saved.get('NOCHEH_CONFIG_VERSION') != '1':
        raise ValueError('Operating configuration is not initialized')
    values = {**configuration.DEFAULTS, **saved}
    configuration.validate(values)
    if values['NOCHEH_STORAGE_LAYOUT'] != 'original-only-v1':
        raise ValueError('Live development requires the operating original-only layout')
    if values['TELEGRAM_ENABLED'] != 'true':
        raise ValueError('Operating Telegram must be enabled for live development')
    if values['NOCHEH_HONCHO_ENABLED'] != 'true':
        raise ValueError('Operating Honcho must be enabled for full-stack live development')
    if not all(values.get(name) for name in ('NOCHEH_HONCHO_STATE_DIR',
                                            'NOCHEH_HONCHO_DATABASE_VOLUME',
                                            'NOCHEH_HONCHO_REDIS_VOLUME')):
        raise ValueError('Operating Honcho state and volume identities are required')
    return values


def docker_env(root, values):
    keep = ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
            'XDG_RUNTIME_DIR', 'SSL_CERT_FILE')
    env = {name: os.environ[name] for name in keep if name in os.environ}
    env.update(values)
    env.update(COMPOSE_PROJECT_NAME=PROJECT, NOCHEH_DEV_PROJECT=DEV_IMAGES,
               NOCHEH_DEV_SOURCE_ROOT=str(ROOT), NOCHEH_INSTALLATION_ROOT=str(root),
               NOCHEH_STATE_DIR=str(root / 'data/local'),
               NOCHEH_DEV_HERMES_BASE=DEV_IMAGES + ':hermes-base',
               NOCHEH_DEV_HONCHO_IMAGE=DEV_IMAGES + ':honcho',
               NOCHEH_NATIVE_ADMIN_PORT=str(int(values['NOCHEH_PORT']) + 5),
               NOCHEH_OAUTH_PORT='1455', COMPOSE_PROFILES='honcho',
               COMPOSE_PROGRESS='plain',
               NOCHEH_AGENT_NETWORK=PROJECT + '-agent',
               NOCHEH_MEMORY_NETWORK=PROJECT + '-memory')
    return env


def command(root):
    return ['docker', 'compose', '--env-file', str(root / '.env'),
            '-f', str(root / 'docker-compose.yml'),
            '-f', str(root / 'deploy/original-only-compose.yml'),
            '-f', str(ROOT / 'docker-compose.dev.yml'), '-p', PROJECT]


def assert_operating_volumes(env):
    names = {'nocheh_postgres_data': ('nocheh', 'postgres_data'),
             env['NOCHEH_HONCHO_DATABASE_VOLUME']: None,
             env['NOCHEH_HONCHO_REDIS_VOLUME']: None}
    for name, expected in names.items():
        result = subprocess.run(['docker', 'volume', 'inspect', name],
                                cwd=ROOT, env=env, capture_output=True, text=True)
        if result.returncode:
            raise ValueError('Missing operating volume: ' + name)
        volume = json.loads(result.stdout)[0]
        if expected:
            labels = volume.get('Labels') or {}
            if (labels.get('com.docker.compose.project'), labels.get('com.docker.compose.volume')) != expected:
                raise ValueError('Operating database volume has unexpected ownership')


def inspect_project(root, env):
    ids = subprocess.check_output(['docker', 'ps', '-aq', '--filter',
                                   'label=com.docker.compose.project=' + PROJECT],
                                  cwd=root, env=env, text=True).split()
    if not ids:
        return []
    containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids],
                                                    cwd=root, env=env, text=True))
    for container in containers:
        labels = container['Config']['Labels'] or {}
        service = labels.get('com.docker.compose.service') or ''
        if (labels.get('com.docker.compose.project.working_dir') != str(root)
                or service not in SERVICES
                and not service.startswith('nocheh-reset-')
                and service != 'pgweb-archive'):
            raise ValueError('Operating Compose project belongs to another checkout or service')
    return containers


def assert_only_development_running(containers, env):
    ids = subprocess.check_output(['docker', 'ps', '-q', '--filter',
                                   'label=com.docker.compose.project'],
                                  cwd=ROOT, env=env, text=True).split()
    if ids:
        running = json.loads(subprocess.check_output(['docker', 'inspect', *ids],
                                                     cwd=ROOT, env=env, text=True))
        for container in running:
            labels = container['Config']['Labels'] or {}
            if (labels.get('com.docker.compose.project') != PROJECT
                    and labels.get('com.docker.compose.service') in SERVICES):
                raise ValueError('Another Nocheh stack is running; stop it before make dev')
    active = [container for container in containers if container['State']['Running']]
    if active and not any(
        (container['Config']['Labels'] or {}).get('com.docker.compose.service') == 'nocheh-app'
        and (container['Config']['Labels'] or {}).get('com.nocheh.runtime-mode') == 'source-watched'
        for container in containers
    ):
        raise ValueError('The unattended operating stack is running; stop it before make dev')


def assert_compose_mounts(cmd, env):
    rendered = json.loads(subprocess.check_output(cmd + ['config', '--format', 'json'],
                                                  cwd=env['NOCHEH_INSTALLATION_ROOT'],
                                                  env=env, text=True))
    if rendered['name'] != PROJECT:
        raise ValueError('Development must reuse the operating Compose project')
    expected_volumes = {'postgres_data': 'nocheh_postgres_data',
                        'honcho_database': env['NOCHEH_HONCHO_DATABASE_VOLUME'],
                        'honcho_redis': env['NOCHEH_HONCHO_REDIS_VOLUME']}
    if any(rendered['volumes'][key].get('name') != name
           or rendered['volumes'][key].get('external') is not True
           for key, name in expected_volumes.items()):
        raise ValueError('Development databases are not attached to the operating volumes')
    def mount(service, target):
        return next((item.get('source') for item in rendered['services'][service]['volumes']
                     if item['target'] == target), None)
    if (mount('nocheh-db', '/var/lib/postgresql/data') != 'postgres_data'
            or mount('honcho-postgres', '/var/lib/postgresql/data') != 'honcho_database'
            or mount('nocheh-app', '/data/files') != str(Path(env['NOCHEH_STATE_DIR']) / 'files')
            or mount('hermes', '/workspace/data/local/hermes') != str(Path(env['NOCHEH_STATE_DIR']) / 'hermes')
            or mount('cliproxy-api', '/auth') != str(Path(env['NOCHEH_STATE_DIR']) / 'provider/auth')
            or mount('nocheh-app', '/app/src') != str(ROOT / 'src')
            or mount('honcho-api', '/nocheh') != str(ROOT / 'services/honcho')
            or mount('honcho-provider-gateway', '/workspace-honcho') != str(ROOT / 'services/honcho')
            or mount('honcho-provider-gateway', '/workspace-provider') != str(ROOT / 'tools/operations/provider')
            or mount('honcho-provider-gateway', '/nocheh') is not None):
        raise ValueError('Development source or state mount does not match the approved paths')
    hermes = rendered['services']['hermes']
    if (hermes['environment'].get('TELEGRAM_ENABLED') != 'true'
            or hermes['environment'].get('HOME') != '/workspace/data/local/hermes'):
        raise ValueError('Telegram or its writable home is not configured in development')


def build_needed(env):
    if os.environ.get('NOCHEH_DEV_BUILD') == '1':
        return True
    for service in ('db', 'app', 'dashboard', 'executor', 'security'):
        result = subprocess.run(['docker', 'image', 'inspect', DEV_IMAGES + ':' + service],
                                cwd=ROOT, env=env, capture_output=True)
        if result.returncode:
            return True
    return False


def main(action, rest):
    if rest:
        raise ValueError('Use make dev, make dev-status, or make dev-stop without extra arguments')
    root = operating_root()
    values = operating_config(root)
    env = docker_env(root, values)
    cmd = command(root)
    containers = inspect_project(root, env)
    if action == 'dev-stop':
        assert_only_development_running(containers, env)
        if not any(container['State']['Running'] for container in containers):
            print('No development stack is running.')
            return 0
        return subprocess.call(cmd + ['down'], cwd=root, env=env)
    if action == 'dev-status':
        return subprocess.call(cmd + ['ps'], cwd=root, env=env)
    assert_only_development_running(containers, env)
    assert_ports(containers)
    assert_operating_volumes(env)
    assert_compose_mounts(cmd, env)
    prepare_source_mounts()
    prepare_runtime_images(env)
    build_flag = '--build' if build_needed(env) else '--no-build'
    print('Live development: http://127.0.0.1:8783/', flush=True)
    print(f'Source checkout: {ROOT}\nOperating state: {root / "data/local"}', flush=True)
    try:
        return subprocess.call(cmd + ['up', build_flag, *SERVICES], cwd=root, env=env)
    except KeyboardInterrupt:
        return 130
