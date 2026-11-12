"""Several workspaces on one machine (ADR-0245).

A workspace is one Nocheh installation in its own folder (a Git clone), with its own .env, data, bot
and Compose stack. Its short name is set once, at setup; its Compose project, internal networks,
volumes, images, ports and off-site backup folder follow from it. Setup refuses a name, port, bot,
mini app address or tunnel that another workspace on the machine already uses.

The machine's list of workspaces is one small file in the owner's home folder. It holds each
workspace's name and folder, never settings; checks read each workspace's own .env when they run.
"""
import fcntl
import json
import os
import socket
import subprocess
from contextlib import contextmanager
from pathlib import Path
import re

DEFAULT = 'personal'
NAME = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?')
FIRST_PORT, PORT_STEP = 8780, 10
# Settings that follow from the workspace name. A .env holding other values was copied from another workspace.
DERIVED = ('COMPOSE_PROJECT_NAME', 'NOCHEH_AGENT_NETWORK', 'NOCHEH_MEMORY_NETWORK',
           'NOCHEH_HONCHO_DATABASE_VOLUME', 'NOCHEH_HONCHO_REDIS_VOLUME', 'NOCHEH_IMAGES')
CLEAN_ENVIRONMENT = ('NOCHEH_STATE_DIR', 'NOCHEH_INSTALLATION_ROOT', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE',
                     'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES', 'NOCHEH_AGENT_NETWORK', 'NOCHEH_MEMORY_NETWORK', 'NOCHEH_IMAGES',
                     'NOCHEH_HONCHO_DATABASE_VOLUME', 'NOCHEH_HONCHO_REDIS_VOLUME', 'NOCHEH_PORT', 'NOCHEH_DASHBOARD_PORT',
                     'NOCHEH_NATIVE_ADMIN_PORT', 'NOCHEH_VIEWER_PORT')


class WorkspaceError(ValueError):
    pass


def check_name(name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise WorkspaceError('A workspace name has 1-50 lowercase letters, digits or dashes, such as acme')
    return name


# Compose project names that tests, fixtures and restores make for themselves; a workspace never takes one.
RESERVED = ('test', 'tester', 'installation', 'stores', 'reset', 'restore', 'restored', 'recovery', 'db-fixture',
            'release-check', 'candidate', 'preview', 'security-acceptance', 'dev')


def check_new_name(name):
    """A name a person picks: also kept clear of the names tests, fixtures and restores use."""
    check_name(name)
    if any(name == word or name.startswith(word + '-') for word in RESERVED):
        raise WorkspaceError(f'Nocheh keeps the name {name} for its own tests and restores. Pick another name, such as acme.')
    return name


def name_of(values):
    return values.get('NOCHEH_WORKSPACE') or DEFAULT


def project(name):
    """The `personal` workspace keeps the classic `nocheh` names, so an install from before workspaces keeps its data."""
    return 'nocheh' if name == DEFAULT else 'nocheh-' + name


def name_of_project(compose_project):
    if compose_project == 'nocheh': return DEFAULT
    return compose_project[len('nocheh-'):] if compose_project.startswith('nocheh-') else compose_project


def identity(values):
    """The names a workspace's .env may hold, all from its name."""
    own = project(name_of(values))
    return {'COMPOSE_PROJECT_NAME': own, 'NOCHEH_AGENT_NETWORK': own + '-agent', 'NOCHEH_MEMORY_NETWORK': own + '-memory',
            'NOCHEH_HONCHO_DATABASE_VOLUME': own + '_honcho_database', 'NOCHEH_HONCHO_REDIS_VOLUME': own + '_honcho_redis',
            'NOCHEH_IMAGES': own}


def images(values):
    """The prefix of the images this installation builds and runs. A restore runs its checkout's images."""
    return values.get('NOCHEH_IMAGES') or project(name_of(values))


def ports(values):
    """Every host port the workspace publishes, all from NOCHEH_PORT: app, database viewer, dashboard, assistant admin."""
    raw = str(values.get('NOCHEH_PORT') or FIRST_PORT)
    if not raw.isdigit() or not 1 <= int(raw) <= 65535: raise WorkspaceError(f'NOCHEH_PORT {raw!r} is not a port number.')
    port = int(raw)
    def near(offset): return port + offset if port + offset <= 65535 else port - offset
    dashboard = values.get('NOCHEH_DASHBOARD_PORT')
    return {'app': port, 'viewer': near(2), 'dashboard': int(dashboard) if str(dashboard or '').isdigit() else near(3),
            'admin': near(5)}


def claims(values, folder):
    """What a workspace holds that no other workspace on the machine may hold."""
    from tools.operations.installation import mini_app
    name = name_of(values)
    honcho = values.get('NOCHEH_HONCHO_STATE_DIR') or str(Path(folder) / 'data/local/honcho')
    try: held = set(ports(values).values())
    except WorkspaceError as error: raise WorkspaceError(f'{Path(folder) / ".env"}: {error} Fix it there.') from None
    return {'name': name, 'project': project(name), 'ports': held,
            'bot': mini_app.bot_id(values.get('TELEGRAM_BOT_TOKEN', '')),
            'mini_app': mini_app.host(values), 'tunnel': mini_app.tunnel_id(values.get('CLOUDFLARE_TUNNEL_TOKEN', '')),
            'honcho': str(Path(honcho).expanduser().resolve())}


def overlaps(mine, theirs, other):
    """Plain sentences for each thing two workspaces share; `other` names the other workspace."""
    found = []
    if mine['name'] == theirs['name'] or mine['project'] == theirs['project']:
        found.append(f"The name {mine['name']} is already used by {other}. Pick another name.")
    shared = sorted(mine['ports'] & theirs['ports'])
    if shared:
        found.append(f"{other} already uses port{'s' if len(shared) > 1 else ''} {', '.join(map(str, shared))}. "
                     'Set NOCHEH_PORT in .env to a free one, such as the next free ten.')
    if mine['bot'] and mine['bot'] == theirs['bot']:
        found.append(f"{other} already uses this Telegram bot. Each workspace needs its own bot from BotFather.")
    if mine['mini_app'] and mine['mini_app'] == theirs['mini_app']:
        found.append(f"{other} already uses the mini app address {mine['mini_app']}. Each workspace needs its own address and tunnel.")
    if mine['tunnel'] and mine['tunnel'] == theirs['tunnel']:
        found.append(f"{other} already uses this Cloudflare tunnel. Each workspace needs its own tunnel.")
    if mine['honcho'] and mine['honcho'] == theirs['honcho']:
        found.append(f"{other} already keeps its memory engine files in {mine['honcho']}.")
    return found


# ---- the machine's list of workspaces ----

def registry_file():
    return Path(os.environ.get('NOCHEH_WORKSPACES_FILE') or Path.home() / '.nocheh/workspaces.json')


def _read(path):
    if not path.exists(): return {}
    try:
        rows = json.loads(path.read_text()).get('workspaces')
        if not isinstance(rows, dict): raise ValueError
    except (ValueError, AttributeError):
        raise WorkspaceError(f'{path} is damaged. Fix or remove it; each workspace adds itself again at its next ./bin/nocheh up.') from None
    return {name: str(row['folder']) for name, row in rows.items()
            if isinstance(name, str) and NAME.fullmatch(name) and isinstance(row, dict) and isinstance(row.get('folder'), str)}


def _write(path, rows):
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w') as file:
        temporary.chmod(0o600)
        json.dump({'version': 1, 'workspaces': {name: {'folder': folder} for name, folder in sorted(rows.items())}}, file, indent=2)
        file.write('\n'); file.flush(); os.fsync(file.fileno())
    temporary.replace(path)


@contextmanager
def _registry():
    path = registry_file()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path.with_name(path.name + '.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield path


def settings_of(folder):
    """A workspace's saved settings with defaults, read from its own .env; None when it has none."""
    from tools.operations.installation.configuration import DEFAULTS, read_env
    path = Path(folder) / '.env'
    if not path.is_file(): return None
    try: return {**DEFAULTS, **read_env(path)}
    except ValueError: return None


def main_checkout(folder):
    """The main checkout a linked Git worktree belongs to, read from its .git file without running Git; None for a
    main checkout or any other folder."""
    try:
        line = (Path(folder) / '.git').read_text().strip()
        if not line.startswith('gitdir: '): return None
        private = (Path(folder) / line[len('gitdir: '):]).resolve()
        common = (private / (private / 'commondir').read_text().strip()).resolve()
    except (OSError, ValueError): return None
    return common.parent if common.name == '.git' else None


def checkout_settings(folder):
    """The workspace settings of the checkout `folder`: its own .env, or for a session worktree without one, those
    of the main checkout it belongs to. None when neither is found."""
    values = settings_of(folder)
    if values is not None: return values
    main = main_checkout(folder)
    return settings_of(main) if main else None


def _alive(rows):
    """Listed workspaces whose folder still holds that workspace; moved or deleted ones drop out."""
    found = []
    for name, folder in rows.items():
        values = settings_of(folder)
        if values is not None and name_of(values) == name: found.append((name, Path(folder), values))
    return found


def listed():
    """Reads without the lock: the list is only ever replaced whole."""
    return _alive(_read(registry_file()))


# ---- what Docker shows ----

def _docker(*arguments, partial=False):
    """Docker's output; with `partial`, also what a failed command still printed."""
    try: result = subprocess.run(['docker', *arguments], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError): return None
    output = getattr(result, 'stdout', None)
    return output if (result.returncode == 0 or partial) and isinstance(output, str) else None


def _inspect(kind, ids):
    if not ids: return []
    # One object removed since it was listed fails the command, yet Docker still prints the others.
    raw = _docker(*([kind, 'inspect'] if kind else ['inspect']), *ids, partial=True)
    try: return json.loads(raw) if raw else []
    except ValueError: return []


def containers():
    """Every Compose container on this Docker, running or not; empty when Docker can't be reached."""
    ids = (_docker('ps', '-aq', '--filter', 'label=com.docker.compose.project') or '').split()
    return _inspect(None, ids)


def docker_overlaps(mine, folder, everything=None, resources=True):
    """What Docker shows another Compose project holding that this workspace needs: its project from another
    folder, a running stack with its bot, mini app or tunnel, its published ports, or its networks and volumes."""
    found = []
    own = mine['project']
    everything = containers() if everything is None else everything
    for container in everything:
        labels = (container.get('Config') or {}).get('Labels') or {}
        other = labels.get('com.docker.compose.project', '')
        running = bool((container.get('State') or {}).get('Running'))
        if other == own:
            place = labels.get('com.docker.compose.project.working_dir')
            # Containers left by a folder that moved, by one that now holds another workspace, or by a session
            # worktree, which is never a workspace, are Compose's to replace.
            if not (place and folder and Path(place).resolve() != Path(folder).resolve()) or main_checkout(place):
                continue
            held = settings_of(place)
            if held is None and (Path(place) / '.env').is_file():
                found.append(f'Docker already runs the {own} stack from {place}, whose .env cannot be read. Fix it there first.')
            elif held is not None and name_of(held) == mine['name']:
                found.append(f"Docker already runs the {own} stack from {place}. That folder is this workspace; "
                             'use it, or make a new workspace with ./bin/nocheh workspace new NAME.')
            continue
        if not running: continue
        who = f'the {other} stack'
        service = labels.get('com.docker.compose.service')
        # A bot or tunnel started before these labels, or without ./bin/nocheh, could be this one.
        unknown = f'{who} runs a {{}} Nocheh cannot tell apart. Restart it with ./bin/nocheh up in its folder first.'
        if mine['bot'] and labels.get('com.nocheh.bot-id') == mine['bot']:
            found.append(f'{who} already uses this Telegram bot. Each workspace needs its own bot from BotFather.')
        elif mine['bot'] and service == 'nocheh-telegram' and labels.get('com.nocheh.bot-id', 'unknown') == 'unknown':
            found.append(unknown.format('Telegram bot'))
        if mine['tunnel'] and labels.get('com.nocheh.tunnel-id') == mine['tunnel']:
            found.append(f'{who} already uses this Cloudflare tunnel. Each workspace needs its own tunnel.')
        if mine['mini_app'] and labels.get('com.nocheh.mini-app-host') == mine['mini_app']:
            found.append(f"{who} already uses the mini app address {mine['mini_app']}.")
        if ((mine['tunnel'] or mine['mini_app']) and service == 'nocheh-tunnel'
                and 'unknown' in (labels.get('com.nocheh.tunnel-id', 'unknown'), labels.get('com.nocheh.mini-app-host', 'unknown'))):
            found.append(unknown.format('Cloudflare tunnel'))
        shared = sorted(_host_ports(container) & mine['ports'])
        if shared: found.append(f"{who} already uses port{'s' if len(shared) > 1 else ''} {', '.join(map(str, shared))}.")
    if not resources: return list(dict.fromkeys(found))
    names = identity({'NOCHEH_WORKSPACE': mine['name']})
    for kind, name in (('network', names['NOCHEH_AGENT_NETWORK']), ('network', names['NOCHEH_MEMORY_NETWORK']),
                       ('volume', own + '_postgres_data'), ('volume', names['NOCHEH_HONCHO_DATABASE_VOLUME']),
                       ('volume', names['NOCHEH_HONCHO_REDIS_VOLUME'])):
        for described in _inspect(kind, [name]):
            holder = (described.get('Labels') or {}).get('com.docker.compose.project')
            if holder and holder != own:
                found.append(f'The Docker {kind} {name} belongs to the {holder} stack, not to {own}.')
    return list(dict.fromkeys(found))


def port_free(port):
    """Whether no program holds the port. A program that listens on it, on 127.0.0.1 or every address, takes a
    connection. A just-stopped stack's closing connections do not count: the bind uses SO_REUSEADDR, as Docker's."""
    with socket.socket() as probe:
        probe.settimeout(0.5)
        try:
            probe.connect(('127.0.0.1', port))
            return False
        except OSError: pass
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try: probe.bind(('127.0.0.1', port))
        except OSError: return False
    return True


def _host_ports(container):
    """The host ports a container publishes; a range such as 9000-9010 counts whole."""
    found = set()
    for bindings in ((container.get('HostConfig') or {}).get('PortBindings') or {}).values():
        for binding in bindings or []:
            low, _, high = str(binding.get('HostPort') or '').partition('-')
            if low.isdigit() and (high or low).isdigit(): found.update(range(int(low), int(high or low) + 1))
    return found


def _published(everything, project=None, running_only=True):
    result = set()
    for container in everything:
        labels = (container.get('Config') or {}).get('Labels') or {}
        if project is not None and labels.get('com.docker.compose.project') != project: continue
        if running_only and not (container.get('State') or {}).get('Running'): continue
        result |= _host_ports(container)
    return result


def free_port(taken):
    """The first NOCHEH_PORT, in steps of ten from 8780, whose ports no workspace and no program on this machine uses."""
    for port in range(FIRST_PORT, 65000, PORT_STEP):
        wanted = set(ports({'NOCHEH_PORT': str(port)}).values())
        if not wanted & taken and all(port_free(each) for each in wanted): return port
    raise WorkspaceError('No free ports were found for this workspace.')


# ---- setup ----

def copied(values):
    """Settings in .env that name another workspace's project, networks, volumes or images."""
    expected = identity(values)
    return [key for key in DERIVED if values.get(key) and values[key] != expected[key]]


def claim(folder, fresh=False):
    """Adds the workspace in `folder` to the machine's list once nothing overlaps another workspace. A .env written
    just now (`fresh`) moves to the first free ports instead of failing."""
    from tools.operations.installation.configuration import read_env, write_env
    folder = Path(folder).resolve()
    values = settings_of(folder)
    if values is None: raise WorkspaceError(f'{folder} has no .env. Run ./bin/nocheh init there first.')
    name = check_name(name_of(values))
    wrong = copied(values)
    if wrong:
        raise WorkspaceError(f"This folder's .env names another workspace's {', '.join(wrong)}. It looks copied from another "
                             'workspace: remove those lines, or make a new workspace with ./bin/nocheh workspace new NAME.')
    with _registry() as path:
        others = [row for row in _alive(_read(path)) if row[1].resolve() != folder]
        everything = containers()
        mine = claims(values, folder)
        own = _published(everything, mine['project'])
        if fresh:
            taken = set().union(*(claims(theirs, place)['ports'] for _, place, theirs in others)) | (_published(everything) - own)
            if mine['ports'] & taken or not all(port_free(port) for port in mine['ports'] - own):
                saved = read_env(folder / '.env'); saved.pop('NOCHEH_DASHBOARD_PORT', None)
                saved['NOCHEH_PORT'] = str(free_port(taken)); write_env(folder / '.env', saved)
                values = settings_of(folder); mine = claims(values, folder)
        problems = []
        for other, place, theirs in others:
            problems += overlaps(mine, claims(theirs, place), f'the workspace {other} in {place}')
        problems += docker_overlaps(mine, folder, everything)
        busy = sorted(port for port in mine['ports'] - _published(everything) if not port_free(port))
        if busy: problems.append(f"Port{'s' if len(busy) > 1 else ''} {', '.join(map(str, busy))} {'are' if len(busy) > 1 else 'is'} "
                                 'used by another program. Set NOCHEH_PORT in .env to a free one.')
        if problems: raise WorkspaceError('\n'.join(dict.fromkeys(problems)))
        rows = {other: str(place) for other, place, _ in others}
        rows[name] = str(folder)
        _write(path, rows)
    return summary(name, folder, values)


def summary(name, folder, values):
    return {'workspace': name, 'folder': str(folder), 'project': project(name),
            'dashboard': f"http://127.0.0.1:{ports(values)['dashboard']}/"}


def running_overlaps(values):
    """For Settings: another running workspace with this bot, mini app address or tunnel. Reads only Docker,
    so it works inside the dashboard container, where other workspaces' folders are out of reach."""
    from tools.operations.installation.configuration import INSTALLATION_ROOT
    return docker_overlaps({**claims(values, INSTALLATION_ROOT), 'ports': set()}, None, resources=False)


def check_settings(values, before):
    """Refuses a saved bot, mini app address or tunnel another workspace uses: running ones through Docker,
    and on the host also every listed workspace."""
    from tools.operations.installation.configuration import INSTALLATION_ROOT
    keys = ('TELEGRAM_BOT_TOKEN', 'NOCHEH_MINI_APP_URL', 'CLOUDFLARE_TUNNEL_TOKEN')
    # Turning Telegram on starts polling, so it is checked too; turning it off never is.
    turning_on = values.get('TELEGRAM_ENABLED') == 'true' != before.get('TELEGRAM_ENABLED')
    if not turning_on and all(values.get(key, '') == before.get(key, '') for key in keys): return
    problems = running_overlaps(values)
    if os.environ.get('NOCHEH_CONTAINER') != '1':
        mine = {**claims(values, INSTALLATION_ROOT), 'ports': set(), 'honcho': ''}
        mine['name'] = mine['project'] = None
        try: others = [row for row in listed() if row[1].resolve() != INSTALLATION_ROOT.resolve()]
        except WorkspaceError: others = []
        for other, place, theirs in others:
            problems += overlaps(mine, claims(theirs, place), f'the workspace {other} in {place}')
    if problems: raise WorkspaceError(' '.join(dict.fromkeys(problems)))


# ---- workspaces on this machine, new ones and updates ----

def state_of(folder, everything):
    """running, development (make dev), or stopped."""
    values = settings_of(folder)
    if values is None: return 'missing'
    own = project(name_of(values))
    mode = 'stopped'
    for container in everything:
        labels = (container.get('Config') or {}).get('Labels') or {}
        if labels.get('com.docker.compose.project') != own or not (container.get('State') or {}).get('Running'): continue
        if labels.get('com.nocheh.runtime-mode') == 'source-watched': return 'development'
        mode = 'running'
    return mode


def clean_environment():
    """The environment for another workspace's own ./bin/nocheh: nothing from this shell may point it elsewhere."""
    return {key: value for key, value in os.environ.items() if key not in CLEAN_ENVIRONMENT}


def git(folder, *arguments, check=True):
    return subprocess.run(['git', '-C', str(folder), *arguments], capture_output=True, text=True, check=check)


def revision(folder):
    result = git(folder, 'rev-parse', '--short', 'HEAD', check=False)
    return result.stdout.strip() if result.returncode == 0 else '?'


def show(own_folder):
    rows = listed()
    everything = containers()
    lines = []
    for name, folder, values in sorted(rows, key=lambda row: (row[0] != DEFAULT, row[0])):
        here = ' (this folder)' if folder.resolve() == Path(own_folder).resolve() else ''
        try: dashboard = f"http://127.0.0.1:{ports(values)['dashboard']}/"
        except WorkspaceError as error: dashboard = str(error)
        lines.append(f"{name}{here}\n  folder: {folder}\n  dashboard: {dashboard}"
                     f"\n  state: {state_of(folder, everything)} · code {revision(folder)}")
    return '\n'.join(lines) or 'No workspaces yet. Run ./bin/nocheh up in a Nocheh folder.'


def create(name, own_folder, folder=None, run=subprocess.run):
    """Clones this folder's code into a new folder and sets it up as the workspace `name`. It starts nothing."""
    check_new_name(name)
    if any(other == name for other, _, _ in listed()):
        raise WorkspaceError(f'The workspace {name} already exists. ./bin/nocheh workspaces lists them.')
    own_folder = Path(own_folder)
    target = Path(folder).expanduser().resolve() if folder else own_folder.resolve().parent / project(name)
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        raise WorkspaceError(f'{target} already exists and is not empty. Pass --folder with a new folder.')
    origin = git(own_folder, 'remote', 'get-url', 'origin', check=False).stdout.strip()
    run(['git', 'clone', '--quiet', '--branch', 'main', str(own_folder), str(target)], check=True)
    if origin: run(['git', '-C', str(target), 'remote', 'set-url', 'origin', origin], check=True)
    # The clone keeps the repository's checks, such as the privacy check before a push.
    run(['git', '-C', str(target), 'config', 'core.hooksPath', 'tools/development/git-hooks'], check=True)
    run([str(target / 'bin/nocheh'), 'init', '--workspace', name], cwd=target, env=clean_environment(), check=True)
    return target


def update(targets, own_folder, run=subprocess.run, say=print):
    """Pulls main into each workspace folder, then runs that folder's own ./bin/nocheh up on a running stack,
    which rebuilds and restarts only what changed. A stopped workspace stays stopped; make dev reloads by itself."""
    rows = {name: (folder, values) for name, folder, values in listed()}
    unknown = [name for name in targets if name not in rows]
    if unknown: raise WorkspaceError(f"No workspace named {', '.join(unknown)}. ./bin/nocheh workspaces lists them.")
    failed = 0
    everything = containers()
    for name in targets:
        folder, _ = rows[name]
        branch = git(folder, 'branch', '--show-current', check=False).stdout.strip()
        if branch != 'main':
            say(f'{name}: skipped, its folder is on {branch or "no branch"}, not main.'); failed += 1; continue
        if git(folder, 'status', '--porcelain', check=False).stdout.strip():
            say(f'{name}: skipped, its folder has changes that are not committed.'); failed += 1; continue
        before = revision(folder)
        if run(['git', '-C', str(folder), 'pull', '--ff-only', '--quiet', 'origin', 'main']).returncode:
            say(f'{name}: the code could not be pulled.'); failed += 1; continue
        after = revision(folder)
        mode = state_of(folder, everything)
        moved = f'code {before} → {after}' if after != before else f'code {after}, already current'
        if mode == 'development':
            say(f'{name}: {moved}. make dev reloads it; run make dev-build if packages or images changed.')
        elif mode != 'running':
            say(f'{name}: {moved}. Not running; start it with ./bin/nocheh up in {folder}.')
        elif run([str(folder / 'bin/nocheh'), 'up'], cwd=folder, env=clean_environment()).returncode:
            say(f'{name}: {moved}, but ./bin/nocheh up failed. See its output above.'); failed += 1
        else:
            say(f'{name}: {moved}, restarted.')
    return 1 if failed else 0
