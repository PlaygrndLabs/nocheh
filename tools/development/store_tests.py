"""Run compiled Node test files, each against a freshly reset synthetic cluster.

Storage tests share installation singletons such as guard state and audience
policy. A file left running before another can change that state, so every
file starts from an empty synthetic cluster. Only the explicit stores fixture
project is touched; its cluster name is verified before every reset.
"""
from tools.paths import ROOT
import argparse
import json
import os
import re
import subprocess
import sys

COMPOSE = ROOT / 'deploy/acceptance/stores-compose.yml'
DATABASES = """SELECT string_agg(format('DROP DATABASE IF EXISTS %I WITH (FORCE);',datname),' ') FROM pg_database
 WHERE datname NOT IN ('postgres','template0','template1')"""
ROLES = """SELECT string_agg(format('DROP ROLE IF EXISTS %I;',rolname),' ') FROM pg_roles
 WHERE rolname<>current_user AND rolname NOT LIKE 'pg\\_%'"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', required=True, help='Synthetic stores fixture Compose project (nocheh-stores-...)')
    parser.add_argument('--image', required=True, help='Development-target image containing the compiled tests')
    parser.add_argument('files', nargs='*', help='Compiled test files; defaults to every dist/test/*.test.js and dashboard test')
    args = parser.parse_args()
    if not re.fullmatch(r'nocheh-stores-[a-z0-9-]+', args.project):
        raise SystemExit('a nocheh-stores-* fixture project is required')
    environment = {**os.environ, 'NOCHEH_STORES_FIXTURE_PROJECT': args.project, 'NOCHEH_STORES_FIXTURE_IMAGE': args.image}
    compose = ['docker', 'compose', '-f', str(COMPOSE)]
    subprocess.run(compose + ['up', '-d', '--wait', 'database'], env=environment, check=True, stdout=subprocess.DEVNULL)

    def psql(database, sql):
        return subprocess.check_output(compose + ['exec', '-T', 'database', 'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
                                                  '-U', 'nocheh', '-d', database, '-c', sql], env=environment, text=True).strip()

    def reset():
        if psql('postgres', "SELECT current_setting('cluster_name')") != 'nocheh-stores-fixture':
            raise SystemExit('synthetic stores fixture cluster required')
        for query in (DATABASES, ROLES):
            # DROP DATABASE cannot run inside psql's implicit multi-statement transaction.
            for statement in filter(None, (part.strip() for part in psql('postgres', query).split(';'))):
                psql('postgres', statement)
        psql('postgres', 'CREATE DATABASE nocheh')

    files = args.files or subprocess.check_output(compose + ['run', '--rm', '-T', '--no-deps', 'checks', 'sh', '-c',
        'ls dist/test/*.test.js test/dashboard-*.test.mjs'], env=environment, text=True).split()
    results = []
    for name in files:
        reset()
        # The development image carries only dashboard assets under services;
        # Python contract tests import the repository's service packages.
        run = subprocess.run(compose + ['run', '--rm', '-T', '--no-deps', '-v', str(ROOT/'services')+':/python/services:ro',
                                        '-e', 'PYTHONPATH=/python', 'checks', 'node', '--test', '--test-concurrency=1',
                                        '--test-reporter=tap', name], env=environment, capture_output=True, text=True)
        counts = {key: int(value) for key, value in re.findall(r'^# (pass|fail|skipped) (\d+)$', run.stdout, re.M)}
        row = {'file': name, 'exit': run.returncode, **counts}
        results.append(row)
        print(json.dumps(row), flush=True)
        if run.returncode and not counts.get('fail'):
            sys.stderr.write(run.stdout[-2000:] + run.stderr[-2000:])
    total = {key: sum(row.get(key, 0) for row in results) for key in ('pass', 'fail', 'skipped')}
    failed = [row['file'] for row in results if row['exit']]
    print(json.dumps({**total, 'files': len(results), 'failed_files': failed}), flush=True)
    raise SystemExit(1 if failed else 0)


if __name__ == '__main__':
    main()
