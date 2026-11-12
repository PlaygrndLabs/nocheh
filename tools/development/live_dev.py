"""Source-watched development for the workspace of the main checkout (ADR-0245: other workspaces may run beside it)."""

from tools.paths import ROOT

import json
import os
import re
import socket
import subprocess
import time
from pathlib import Path

from tools.operations.installation import configuration, mini_app, workspaces
from tools.operations.provider import routes as provider_routes

# The personal workspace's names; another workspace's make dev uses its own, from its .env.
PROJECT = 'nocheh'
DEV_IMAGES = 'nocheh-dev'


def dev_images(project):
    return project + '-dev'
SERVICES = ('nocheh-db', 'nocheh-app', 'nocheh-dashboard', 'nocheh-executor', 'nocheh-machines',
            'nocheh-security', 'hermes-agent-sb', 'inngest-redis', 'inngest-server',
            'hermes', 'nocheh-telegram', 'honcho-postgres', 'honcho-redis',
            'honcho-provider-gateway', 'honcho-api', 'honcho-deriver')
PORTS = (8780, 8783, 8785)
FIXTURE_PROJECT = re.compile(r'nocheh-installation-[0-9a-f]{12}')


def port_available(port):
    # One meaning of a busy port for setup and make dev (ADR-0245).
    return workspaces.port_free(port)


def assert_ports(containers, ports=PORTS):
    owned = set()
    for container in containers:
        if not container['State']['Running']:
            continue
        for bindings in (container['NetworkSettings'].get('Ports') or {}).values():
            for binding in bindings or []:
                owned.add(int(binding['HostPort']))
    for port in ports:
        if port in owned:
            continue
        # A just-stopped stack's closing connections hold its ports for a moment.
        for attempt in range(10):
            if port_available(port):
                break
            if attempt == 9:
                raise ValueError(f'Local development port {port} is in use by another process')
            time.sleep(0.5)


def prepare_source_mounts():
    # Nested named volumes need existing mount points under read-only source
    # binds. These ignored directories hold no generated output on the host.
    for relative in ('dashboard/dist',):
        path = ROOT / relative
        if path.is_symlink():
            raise ValueError(f'Development source mount {relative} must not be a symlink')
        path.mkdir(exist_ok=True)


def prepare_runtime_images(env, root):
    """Reuse only revision-checked, credential-free pinned image contents."""
    images = env.get('NOCHEH_IMAGES', 'nocheh') + '-hermes:local'
    development = env.get('NOCHEH_DEV_PROJECT', DEV_IMAGES)
    locks = json.loads((ROOT / 'deploy/upstreams.lock.json').read_text())
    hermes_revision = locks['hermes']['revision']
    honcho_source = 'nocheh-honcho:' + json.loads((ROOT / 'services/honcho/upstreams.lock.json').read_text())['honcho']['revision'][:8]

    def image_revision(tag):
        result = subprocess.run(['docker', 'image', 'inspect', '--format',
                                 '{{ index .Config.Labels "org.opencontainers.image.revision" }}', tag],
                                cwd=ROOT, env=env, capture_output=True, text=True)
        return result.stdout.strip() if result.returncode == 0 else None

    # The Hermes image must still pass its Dockerfile's own import checks, so a changed
    # library list rebuilds it even when the Hermes pin stays the same.
    import_checks = re.findall(r'^RUN python -c "([^"]+)"$', (ROOT / 'deploy/hermes.Dockerfile').read_text(), re.M)

    def hermes_libraries_ready():
        return all(subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'python',
                                   images, '-c', check],
                                  cwd=ROOT, env=env, capture_output=True).returncode == 0 for check in import_checks)

    def pinned_images_ready():
        return (image_revision(images) == hermes_revision and image_revision(honcho_source) is not None
                and hermes_libraries_ready())

    if not pinned_images_ready():
        # A moved pin or library list needs the installation's own images first; this builds images only.
        print('Building the pinned Hermes and Honcho images', flush=True)
        subprocess.run([str(root / 'bin/nocheh'), 'build'], cwd=root, check=True)
        if image_revision(images) != hermes_revision:
            raise ValueError(f'Pinned runtime image {images} is unavailable or has the wrong revision after ./bin/nocheh build')
        if not hermes_libraries_ready():
            raise ValueError(f'Pinned runtime image {images} lacks a required library after ./bin/nocheh build')
        if image_revision(honcho_source) is None:
            raise ValueError(f'Pinned Honcho image {honcho_source} is unavailable after ./bin/nocheh build')
    # Development tags always follow the pinned images, so a moved pin replaces an older tag.
    for source, destination in ((images, development + ':hermes-base'),
                                (honcho_source, development + ':honcho')):
        subprocess.run(['docker', 'tag', source, destination], cwd=ROOT, env=env,
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
    if not all(values.get(name) for name in ('NOCHEH_HONCHO_DATABASE_VOLUME',
                                            'NOCHEH_HONCHO_REDIS_VOLUME')):
        raise ValueError('Operating Honcho volume identities are required; run ./bin/nocheh init')
    # An unsaved Honcho folder follows the checkout, as in configuration.compose_environment.
    values['NOCHEH_HONCHO_STATE_DIR'] = values.get('NOCHEH_HONCHO_STATE_DIR') or str(root / 'data/local/honcho')
    return values


def overlay_environment(source, project=PROJECT):
    """What docker-compose.dev.yml needs besides the installation's own settings."""
    development = dev_images(project)
    return dict(NOCHEH_DEV_PROJECT=development, NOCHEH_DEV_SOURCE_ROOT=str(source),
                NOCHEH_DEV_HERMES_BASE=development + ':hermes-base',
                NOCHEH_DEV_HONCHO_IMAGE=development + ':honcho')


def docker_env(root, values):
    keep = ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
            'XDG_RUNTIME_DIR', 'SSL_CERT_FILE')
    env = {name: os.environ[name] for name in keep if name in os.environ}
    env.update(values)
    # Settings › Models: the resolved provider and model of replies and secret checks.
    env.update(provider_routes.environment(values))
    env.update(mini_app.environment(values))
    names = workspaces.identity(values)
    project = names['COMPOSE_PROJECT_NAME']
    ports = workspaces.ports(values)
    env.update(overlay_environment(ROOT, project))
    env.update(COMPOSE_PROJECT_NAME=project, NOCHEH_INSTALLATION_ROOT=str(root),
               NOCHEH_STATE_DIR=str(root / 'data/local'),
               NOCHEH_NATIVE_ADMIN_PORT=str(ports['admin']),
               NOCHEH_DASHBOARD_PORT=str(ports['dashboard']),
               NOCHEH_VIEWER_PORT=str(ports['viewer']),
               NOCHEH_IMAGES=workspaces.images(values),
               COMPOSE_PROFILES='honcho,miniapp' if mini_app.enabled(values) else 'honcho',
               COMPOSE_PROGRESS='plain',
               NOCHEH_AGENT_NETWORK=names['NOCHEH_AGENT_NETWORK'],
               NOCHEH_MEMORY_NETWORK=names['NOCHEH_MEMORY_NETWORK'])
    return env


def command(root, project=PROJECT):
    return ['docker', 'compose', '--env-file', str(root / '.env'),
            '--project-directory', str(root),
            '-f', str(ROOT / 'docker-compose.yml'),
            '-f', str(ROOT / 'docker-compose.dev.yml'), '-p', project]


def assert_operating_volumes(env):
    project = env.get('COMPOSE_PROJECT_NAME', PROJECT)
    names = {project + '_postgres_data': (project, 'postgres_data'),
             env['NOCHEH_HONCHO_DATABASE_VOLUME']: (project, 'honcho_database'),
             env['NOCHEH_HONCHO_REDIS_VOLUME']: (project, 'honcho_redis')}
    for name, expected in names.items():
        result = subprocess.run(['docker', 'volume', 'inspect', name],
                                cwd=ROOT, env=env, capture_output=True, text=True)
        if result.returncode:
            # Compose creates missing, project-owned volumes on a clean setup.
            if 'no such volume' not in result.stderr.lower():
                raise ValueError('Unable to inspect operating volume: ' + name)
            continue
        volume = json.loads(result.stdout)[0]
        if expected:
            labels = volume.get('Labels') or {}
            if (labels.get('com.docker.compose.project'), labels.get('com.docker.compose.volume')) != expected:
                raise ValueError('Operating database volume has unexpected ownership')


def inspect_project(root, env):
    ids = subprocess.check_output(['docker', 'ps', '-aq', '--filter',
                                   'label=com.docker.compose.project=' + env.get('COMPOSE_PROJECT_NAME', PROJECT)],
                                  cwd=root, env=env, text=True).split()
    if not ids:
        return []
    containers = json.loads(subprocess.check_output(['docker', 'inspect', *ids],
                                                    cwd=root, env=env, text=True))
    for container in containers:
        labels = container['Config']['Labels'] or {}
        service = labels.get('com.docker.compose.service') or ''
        if (labels.get('com.docker.compose.project.working_dir') != str(root)
                or service not in SERVICES + mini_app.SERVICES
                and not service.startswith('nocheh-reset-')
                and service != 'pgweb-archive'):
            raise ValueError('Operating Compose project belongs to another checkout or service')
    return containers


def assert_only_development_running(containers, env, bot=None):
    """Other workspaces may run beside development (ADR-0245), but never a second poller of its bot: a running
    Nocheh bot of another stack must show a different bot or none (Telegram off). One without the label, or
    `unknown` (started without ./bin/nocheh), counts as the same."""
    project = env.get('COMPOSE_PROJECT_NAME', PROJECT)
    ids = subprocess.check_output(['docker', 'ps', '-q', '--filter',
                                   'label=com.docker.compose.project'],
                                  cwd=ROOT, env=env, text=True).split()
    if ids:
        running = json.loads(subprocess.check_output(['docker', 'inspect', *ids],
                                                     cwd=ROOT, env=env, text=True))
        for container in running:
            labels = container['Config']['Labels'] or {}
            if (labels.get('com.docker.compose.project') != project
                    and labels.get('com.docker.compose.service') == 'nocheh-telegram'
                    and (not bot or labels.get('com.nocheh.bot-id', 'unknown') in ('unknown', bot))):
                raise ValueError('Another Nocheh stack is running with this Telegram bot, or one Nocheh cannot tell; '
                                 'stop it before make dev')
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
    project = env.get('COMPOSE_PROJECT_NAME', PROJECT)
    if rendered['name'] != project:
        raise ValueError('Development must reuse the operating Compose project')
    expected_volumes = {'postgres_data': project + '_postgres_data',
                        'honcho_database': env['NOCHEH_HONCHO_DATABASE_VOLUME'],
                        'honcho_redis': env['NOCHEH_HONCHO_REDIS_VOLUME']}
    if any(rendered['volumes'][key].get('name') != name
           or rendered['volumes'][key].get('external', False)
           for key, name in expected_volumes.items()):
        raise ValueError('Development databases are not attached to the operating volumes')
    def mount(service, target):
        return next((item.get('source') for item in rendered['services'][service]['volumes']
                     if item['target'] == target), None)
    if (mount('nocheh-db', '/var/lib/postgresql/data') != 'postgres_data'
            or mount('honcho-postgres', '/var/lib/postgresql/data') != 'honcho_database'
            or mount('nocheh-app', '/data/files') != str(Path(env['NOCHEH_STATE_DIR']) / 'files')
            or mount('hermes', '/workspace/data/local/hermes') != str(Path(env['NOCHEH_STATE_DIR']) / 'hermes')
            or mount('nocheh-app', '/app/src') != str(ROOT / 'src')
            or mount('honcho-api', '/nocheh') != str(ROOT / 'services/honcho')
            or mount('honcho-provider-gateway', '/workspace-honcho') != str(ROOT / 'services/honcho')
            or mount('honcho-provider-gateway', '/workspace-provider') != str(ROOT / 'tools/operations/provider')
            or mount('honcho-provider-gateway', '/nocheh') is not None):
        raise ValueError('Development source or state mount does not match the approved paths')
    # nocheh-telegram polls and keeps its incident file; Hermes still needs a writable home for its own files.
    telegram, hermes = rendered['services']['nocheh-telegram'], rendered['services']['hermes']
    if (telegram['environment'].get('TELEGRAM_ENABLED') != 'true'
            or mount('nocheh-telegram', '/telegram-state') != str(Path(env['NOCHEH_STATE_DIR']) / 'telegram')
            or hermes['environment'].get('HOME') != '/workspace/data/local/hermes'):
        raise ValueError('Telegram or its writable home is not configured in development')


def release_idle_fixture_networks(env):
    """Stopped rehearsal fixtures keep their networks and can exhaust Docker's address pools.

    Only networks of fixture projects with no running container are removed;
    Compose recreates them, and the fixtures' volumes and state stay untouched.
    """
    ids = subprocess.check_output(['docker', 'network', 'ls', '-q', '--filter', 'label=com.docker.compose.project'],
                                  cwd=ROOT, env=env, text=True).split()
    if not ids:
        return []
    released = []
    for network in json.loads(subprocess.check_output(['docker', 'network', 'inspect', *ids],
                                                      cwd=ROOT, env=env, text=True)):
        project = (network.get('Labels') or {}).get('com.docker.compose.project', '')
        if FIXTURE_PROJECT.fullmatch(project) and not network.get('Containers'):
            subprocess.run(['docker', 'network', 'rm', network['Name']], cwd=ROOT, env=env,
                           check=True, stdout=subprocess.DEVNULL)
            released.append(network['Name'])
    return released


def build_needed(env):
    if os.environ.get('NOCHEH_DEV_BUILD') == '1':
        return True
    for service in ('db', 'app', 'dashboard', 'executor', 'machines', 'security'):
        result = subprocess.run(['docker', 'image', 'inspect', env.get('NOCHEH_DEV_PROJECT', DEV_IMAGES) + ':' + service],
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
    cmd = command(root, env['COMPOSE_PROJECT_NAME'])
    containers = inspect_project(root, env)
    bot = mini_app.bot_id(values.get('TELEGRAM_BOT_TOKEN', ''))
    if action == 'dev-stop':
        assert_only_development_running(containers, env, bot)
        if not any(container['State']['Running'] for container in containers):
            print('No development stack is running.')
            return 0
        return subprocess.call(cmd + ['down'], cwd=root, env=env)
    if action == 'dev-status':
        return subprocess.call(cmd + ['ps'], cwd=root, env=env)
    assert_only_development_running(containers, env, bot)
    # The operating folder joins the machine's list of workspaces once nothing overlaps another one.
    workspaces.claim(root)
    ports = workspaces.ports(values)
    assert_ports(containers, (ports['app'], ports['dashboard'], ports['admin']))
    assert_operating_volumes(env)
    assert_compose_mounts(cmd, env)
    prepare_source_mounts()
    prepare_runtime_images(env, root)
    released = release_idle_fixture_networks(env)
    if released:
        print(f'Released {len(released)} networks of stopped rehearsal fixtures', flush=True)
    build_flag = '--build' if build_needed(env) else '--no-build'
    print(f"Live development: http://127.0.0.1:{ports['dashboard']}/", flush=True)
    print(f'Source checkout: {ROOT}\nOperating state: {root / "data/local"}', flush=True)
    try:
        services = SERVICES + (mini_app.SERVICES if mini_app.enabled(values) else ())
        return subprocess.call(cmd + ['up', build_flag, *services], cwd=root, env=env)
    except KeyboardInterrupt:
        return 130
