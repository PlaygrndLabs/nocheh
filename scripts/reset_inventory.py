"""Read-only installation reset preflight. A manifest never authorizes execution.

Only metadata and configuration fingerprints are retained here. Quiescence,
effect settlement, frozen preservation data and acceptance gates are separate
coordinator steps; this module cannot stop services or erase anything.
"""
import argparse
import hashlib
import json
import os
import stat
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

from .configuration import INSTALLATION_ROOT, compose_command, compose_environment, env_path, load

CONTAINER_FORMAT = ('{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},'
                    '"restart_policy":{{json .HostConfig.RestartPolicy}},'
                    '"state":{{json .State.Status}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                    '"working_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},'
                    '"config_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},'
                    '"mounts":{{json .Mounts}}}')
VOLUME_FORMAT = ('{"name":{{json .Name}},"created_at":{{json .CreatedAt}},"driver":{{json .Driver}},"options_count":{{len .Options}},'
                 '"project":{{json (index .Labels "com.docker.compose.project")}},'
                 '"compose_volume":{{json (index .Labels "com.docker.compose.volume")}}}')
VOLUME_TARGETS = {'nocheh-postgres': '/var/lib/postgresql/data',
                  'honcho-postgres': '/var/lib/postgresql/data', 'honcho-redis': '/data'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def run(arguments, environment):
    result = subprocess.run(arguments, env=environment, capture_output=True, text=True, timeout=60)
    if result.returncode or len(result.stdout) > 32 * 1024 * 1024:
        # Compose environment/configuration output can contain credentials.
        raise RuntimeError('reset_inventory_inspection_failed')
    return result.stdout


def overlap(left, right):
    left, right = Path(left).resolve(), Path(right).resolve()
    return left.is_relative_to(right) or right.is_relative_to(left)


def entry(path, action, reason):
    path = Path(path)
    result = {'path': str(path), 'action': action, 'reason': reason, 'exists': path.exists() or path.is_symlink()}
    if result['exists']:
        metadata = path.lstat()
        result.update(device=metadata.st_dev, inode=metadata.st_ino,
                      kind='symlink' if stat.S_ISLNK(metadata.st_mode) else 'directory' if stat.S_ISDIR(metadata.st_mode) else 'file')
    return result


def files(state, memory, config_path, blockers):
    actions = [entry(config_path, 'preserve', 'saved_setup_and_credentials')]

    def area(root, decisions):
        if root.is_symlink():
            blockers.append({'code': 'state_anchor_symlink', 'path': str(root)})
            return
        if not root.exists():
            return
        if not root.is_dir():
            blockers.append({'code': 'state_anchor_not_directory', 'path': str(root)})
            return
        children = sorted(root.iterdir())
        if len(children) > 10000:
            raise ValueError('reset_inventory_limit')
        for path in children:
            if path == config_path:
                continue
            selected = decisions.get(path.name)
            if selected is None:
                blockers.append({'code': 'unclassified_state_path', 'path': str(path)})
            elif selected[0] != 'delegate':
                actions.append(entry(path, *selected))

    state_erase = ('files', 'spool', 'reports', 'backups', 'security-before-activation', 'workflows')
    area(state, {**{name: ('erase', 'installation_content') for name in state_erase},
                 **{name: ('preserve', 'saved_setup_and_credentials') for name in ('secrets', 'compose.env', 'assistant.json', 'previous-configuration')},
                 **{name: ('delegate', '') for name in ('admin', 'hermes', 'provider', 'honcho')}})
    area(state / 'admin', {**{name: ('erase', 'installation_content_and_receipts') for name in ('backups', 'exports', 'jobs', 'tools', 'workflows', 'dashboard')},
                           'reset': ('preserve', 'reset_coordinator_journal'), 'restores': ('review_restore', 'separate_restore_ownership_required')})
    native = state / 'hermes'
    if native.is_symlink():
        blockers.append({'code': 'state_anchor_symlink', 'path': str(native)})
    elif native.is_dir():
        for path in sorted(native.iterdir()):
            action = 'preserve' if path.name in ('auth.json', 'auth.lock') else 'snapshot_preferences_then_erase' if path.name in ('profiles', 'nocheh-policy.yaml') else 'erase'
            actions.append(entry(path, action, 'provider_login' if action == 'preserve' else 'native_runtime_state'))
    area(state / 'provider', {**{name: ('preserve', 'provider_setup_and_credentials') for name in ('auth', 'keys', 'config.yaml', 'retired')},
                              'monitor': ('delegate', '')})
    monitor = state / 'provider/monitor'
    monitor_decisions = {'usage.sqlite': ('sanitize_accounting', 'preserve_accounting_erase_content'),
                         'usage.sqlite-wal': ('sqlite_checkpoint', 'managed_by_accounting_cleanup'),
                         'usage.sqlite-shm': ('sqlite_checkpoint', 'managed_by_accounting_cleanup'),
                         'usage.sqlite-journal': ('sqlite_checkpoint', 'managed_by_accounting_cleanup'),
                         'usage.sqlite.manager.lock': ('preserve', 'native_writer_lock'),
                         'usage-imports': ('erase', 'old_usage_import_payloads')}
    area(monitor, monitor_decisions)
    # Bind absent SQLite companions too: sanitization can create the native lock
    # and remove WAL/checkpoint files after the preflight was taken.
    known = {item['path'] for item in actions}
    if monitor.is_dir() and not monitor.is_symlink():
        for name in ('usage.sqlite', 'usage.sqlite-wal', 'usage.sqlite-shm', 'usage.sqlite-journal',
                     'usage.sqlite.manager.lock'):
            path = monitor / name
            if str(path) not in known:
                actions.append(entry(path, *monitor_decisions[name]))
    area(memory, {**{name: ('preserve', 'memory_setup_credentials_or_spending') for name in (
        'honcho.env', 'meter.env', 'internal_token', 'database_password', 'temporary_embedding_key', 'honcho.Dockerfile',
        'ledger', 'bridge-auth', 'bridge.Dockerfile', 'bridge.yaml', 'compose.env')},
        **{name: ('erase', 'old_memory_content') for name in ('baseline', 'reports')}})
    for item in actions:
        if item.get('kind') == 'symlink' and item['action'] not in ('erase', 'snapshot_preferences_then_erase'):
            blockers.append({'code': 'preserved_or_transformed_path_symlink', 'path': item['path']})
    return actions


def inspect(state, *, root=INSTALLATION_ROOT, runner=run):
    supplied = Path(state)
    if supplied.is_symlink():
        raise ValueError('reset_state_symlink')
    state, root = supplied.resolve(), Path(root).resolve()
    values = load(state); environment = compose_environment(state)
    memory = Path(environment['NOCHEH_HONCHO_STATE_DIR'])
    if memory.is_symlink() or memory.resolve() == state or state.is_relative_to(memory.resolve()):
        raise ValueError('reset_memory_state_overlap')
    memory = memory.resolve()
    command = compose_command(state)
    rendered = json.loads(runner(command + ['config', '--format', 'json'], environment))
    project = rendered['name']; blockers = []
    identifiers = runner(['docker', 'ps', '-a', '-q', '--no-trunc'], environment).split()
    if len(identifiers) > 4096:
        raise ValueError('reset_inventory_limit')
    containers = []
    for start in range(0, len(identifiers), 64):
        lines = runner(['docker', 'inspect', '--format', CONTAINER_FORMAT, *identifiers[start:start + 64]], environment)
        containers.extend(json.loads(line) for line in lines.splitlines() if line)
    owned = [item for item in containers if item.get('project') == project]
    expected_files = {str(Path(command[i + 1]).resolve()) for i, part in enumerate(command[:-1]) if part == '-f'}
    for item in owned:
        source_files = {str(Path(path).resolve()) for path in (item.get('config_files') or '').split(',') if path}
        if (not item.get('working_dir') or Path(item['working_dir']).resolve() != root or
                source_files != expected_files or item.get('service') not in rendered['services']):
            blockers.append({'code': 'container_installation_binding_changed', 'container': item['id'], 'service': item.get('service')})
    if not owned:
        blockers.append({'code': 'installation_containers_missing'})
    volumes = []
    for service, target in VOLUME_TARGETS.items():
        if service not in rendered['services']:
            continue
        mounts = [mount for container in owned if container.get('service') == service
                  for mount in container.get('mounts', []) if mount.get('Destination') == target]
        configured = [mount for mount in rendered['services'][service].get('volumes', []) if mount.get('target') == target]
        if len(mounts) != 1 or len(configured) != 1 or mounts[0].get('Type') != 'volume' or configured[0].get('type') != 'volume':
            blockers.append({'code': 'database_volume_binding_missing', 'service': service})
            continue
        logical = configured[0]['source']; name = rendered['volumes'][logical]['name']
        if mounts[0].get('Name') != name:
            blockers.append({'code': 'database_volume_binding_changed', 'service': service})
            continue
        record = json.loads(runner(['docker', 'volume', 'inspect', '--format', VOLUME_FORMAT, name], environment))
        if record.get('driver') != 'local' or record.get('options_count') != 0:
            blockers.append({'code': 'external_volume_driver_requires_review', 'volume': name})
        volumes.append({**record, 'service': service, 'target': target, 'configured_name': name,
                        'authority': 'explicit_configuration_and_installation_mount'})
    names = {volume['name'] for volume in volumes}
    for container in containers:
        if container in owned:
            continue
        for mount in container.get('mounts', []):
            if mount.get('Type') == 'volume' and mount.get('Name') in names:
                blockers.append({'code': 'volume_has_another_container_owner', 'volume': mount['Name'], 'container': container['id'], 'project': container.get('project')})
            if mount.get('Type') == 'bind' and mount.get('RW') and any(overlap(mount['Source'], path) for path in (state, memory)):
                blockers.append({'code': 'state_has_another_writer', 'container': container['id'], 'project': container.get('project')})
    config = env_path(state)
    paths = files(state, memory, config, blockers)
    # These locations may include unrelated worktrees, fixtures or restorations.
    # Never infer their ownership from a directory name or a shared provider key.
    external = [entry(root / 'data' / name, 'review_archive', 'establish_per_item_installation_ownership') for name in (
        'backups', 'exports', 'recovery', 'worktree-archives', 'worktree-backups') if (root / 'data' / name).exists()]
    pending = ['complete_isolated_acceptance', 'quiesce_all_owners', 'settle_external_effects', 'freeze_configuration_and_preferences',
               'review_restore_and_external_archive_ownership', 'verify_preserved_spending_and_credentials',
               'new_installation_generation', 'one_time_telegram_backlog_boundary', 'empty_baseline', 'fresh_live_acceptance']
    return {'format': 'nocheh-reset-preflight-v1', 'id': str(uuid.uuid4()), 'created_at': datetime.now(timezone.utc).isoformat(),
            'executable': False, 'installation': {'root': str(root), 'state': str(state), 'memory_state': str(memory),
                'project': project, 'storage_layout': values['NOCHEH_STORAGE_LAYOUT'], 'config_path': str(config),
                'configuration_sha256': hashlib.sha256(canonical(values)).hexdigest(),
                'state_anchor': entry(state, 'retain_root', 'installation_anchor')},
            'containers': owned, 'volumes': volumes, 'paths': paths, 'external_archives': external,
            'blockers': blockers, 'pending': pending, 'content_copied': False}


def write_manifest(path, manifest):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    raw = canonical(manifest) + b'\n'
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as target:
        target.write(raw); target.flush(); os.fsync(target.fileno())
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return {'path': str(path.resolve()), 'sha256': hashlib.sha256(raw).hexdigest(), 'executable': False,
            'containers': len(manifest['containers']), 'volumes': len(manifest['volumes']), 'paths': len(manifest['paths']),
            'blockers': len(manifest['blockers']), 'pending': manifest['pending']}


def main(state, arguments):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan',))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(arguments)
    print(json.dumps(write_manifest(args.output, inspect(state)), indent=2))
    return 0
