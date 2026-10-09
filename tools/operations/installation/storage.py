"""Read-only storage size report: where disk is used, so uncontrolled growth is visible."""
import argparse
import json
import os
import subprocess
from pathlib import Path

from tools.operations.installation.configuration import compose_command, compose_environment, load

# Owned originals are retained by design; every other entry must stay bounded.
STORES = (('nocheh_archive', 'owned originals'), ('nocheh_derived', 'derived'),
          ('nocheh_control', 'operational'), ('nocheh_inngest', 'workflow history'))
TABLES = """SELECT c.relname,pg_total_relation_size(c.oid),greatest(c.reltuples,0)::bigint FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
 ORDER BY 2 DESC LIMIT {limit}"""


def query(command, env, service, user, database, sql):
    """Rows of a read-only query, or None when the service is not running."""
    try:
        raw = subprocess.check_output(command + ['exec', '-T', service, 'psql', '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1',
                                                 '-U', user, '-d', database, '-c', 'SET default_transaction_read_only=on; ' + sql],
                                      env=env, text=True, stderr=subprocess.DEVNULL, timeout=60)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    return [line.split('\t') for line in raw.splitlines() if '\t' in line]


def database(command, env, service, user, name, role, limit):
    size = query(command, env, service, user, name, 'SELECT current_database(),pg_database_size(current_database())')
    if size is None:
        return {'database': name, 'role': role, 'state': 'unavailable'}
    tables = query(command, env, service, user, name, TABLES.format(limit=int(limit))) or []
    return {'database': name, 'role': role, 'state': 'measured', 'bytes': int(size[0][1]),
            'largest_tables': [{'table': table, 'bytes': int(size), 'estimated_rows': int(rows)} for table, size, rows in tables]}


def measure(path):
    """Bytes under a directory without following symlinks out of it, and
    whether every entry could be read (another user's folder may not be)."""
    total, unreadable = 0, []
    for folder, folders, files in os.walk(path, onerror=unreadable.append):
        folders[:] = [name for name in folders if not os.path.islink(os.path.join(folder, name))]
        for name in files:
            try:
                status = os.lstat(os.path.join(folder, name))
            except OSError:
                unreadable.append(name)
                continue
            total += status.st_size
    return total, not unreadable


def directory_size(path):
    return measure(path)[0]


def folder(child):
    size, complete = measure(child)
    return {'path': child.name, 'bytes': size, 'complete': complete}


def report(state, limit=8, command=None, env=None):
    state = Path(state)
    config = load(state)
    command = command or compose_command(state)
    env = env or compose_environment(state)
    databases = [database(command, env, 'nocheh-db', 'nocheh', name, role, limit) for name, role in STORES]
    if config.get('NOCHEH_HONCHO_ENABLED') == 'true':
        databases.append(database(command, env, 'honcho-postgres', 'experiment', 'honcho_experiment', 'Honcho memory', limit))
    folders = [folder(child) for child in sorted(state.iterdir()) if child.is_dir() and not child.is_symlink()] if state.is_dir() else []
    size, files = config.get('NOCHEH_LOG_MAX_SIZE', '10m'), int(config.get('NOCHEH_LOG_MAX_FILES', '3'))
    return {'databases': databases, 'state_folders': sorted(folders, key=lambda row: -row['bytes']),
            'docker_logs': {'max_size_per_file': size, 'max_files_per_container': files},
            'retention_days': int(config.get('NOCHEH_WORKFLOW_HISTORY_RETENTION_DAYS', '14'))}


def human(count):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if count < 1024 or unit == 'GB':
            return f'{count:.0f} {unit}' if unit == 'B' else f'{count:.1f} {unit}'
        count /= 1024


def main(state, argv):
    parser = argparse.ArgumentParser(prog='nocheh storage', description=__doc__)
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--tables', type=int, default=8, choices=range(1, 51), metavar='1-50')
    args = parser.parse_args(argv)
    result = report(state, args.tables)
    if args.json:
        print(json.dumps(result, indent=2))
        return 0
    for row in result['databases']:
        if row['state'] != 'measured':
            print(f"{row['database']} ({row['role']}): not running")
            continue
        print(f"{row['database']} ({row['role']}): {human(row['bytes'])}")
        for table in row['largest_tables']:
            print(f"  {table['table']}: {human(table['bytes'])}, about {table['estimated_rows']} rows")
    print('Local state:')
    for row in result['state_folders']:
        print(f"  {row['path']}: {'at least ' if not row['complete'] else ''}{human(row['bytes'])}")
    logs = result['docker_logs']
    print(f"Docker logs: at most {logs['max_files_per_container']} x {logs['max_size_per_file']} per container")
    retention = result['retention_days']
    print(f"Workflow history retention: {f'{retention} days' if retention else 'off'}")
    return 0
