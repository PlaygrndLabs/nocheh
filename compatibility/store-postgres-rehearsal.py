"""Exercise fresh, repeated, rejected, and inactive database startup in isolation."""
import argparse
import json
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.configuration import compose_command, compose_environment, initialize, write_env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--postgres-image', required=True)
    args = parser.parse_args()
    image = json.loads(subprocess.check_output(
        ['docker', 'image', 'inspect', args.postgres_image], text=True))[0]['Id']
    project = 'nocheh-db-fixture-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='nocheh-db-fixture-') as temporary:
        root = Path(temporary)
        state = root / 'state'
        values = initialize(state)
        values.update(NOCHEH_STORAGE_LAYOUT='original-only-v1', TELEGRAM_ENABLED='false',
                      COMPOSE_PROJECT_NAME=project, NOCHEH_AGENT_NETWORK=project+'-agent',
                      NOCHEH_MEMORY_NETWORK=project+'-memory')
        write_env(state / '.env', values)
        override = root / 'compose.json'
        override.write_text(json.dumps({'services': {'nocheh-db': {
            'image': image, 'restart': 'no'}}, 'networks': {
            'default': {'internal': True}, 'workflows': {'internal': True}}}))
        command = compose_command(state, project) + ['-f', str(override)]

        def run(*args, check=True):
            return subprocess.run(command + list(args), env=compose_environment(state),
                                  check=check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def query(database, sql):
            return subprocess.check_output(command + ['exec', '-T', 'nocheh-db',
                'psql', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'nocheh',
                '-d', database, '-c', sql], env=compose_environment(state), text=True).strip()

        try:
            rendered = json.loads(subprocess.check_output(command + ['config', '--format', 'json'],
                                                          env=compose_environment(state), text=True))
            assert 'nocheh-store-bootstrap' not in rendered['services']
            assert rendered['services']['nocheh-db']['image'] == image
            assert all(network.get('internal') for network in rendered['networks'].values()
                       if network['name'] in (project+'_default', project+'_workflows'))

            run('up', '-d', '--no-build', '--wait', '--wait-timeout', '180', 'nocheh-db')
            names = query('nocheh', "SELECT datname FROM pg_database WHERE datname IN ("
                          "'nocheh_archive','nocheh_derived','nocheh_control','nocheh_inngest') ORDER BY datname").splitlines()
            assert names == ['nocheh_archive', 'nocheh_control', 'nocheh_derived', 'nocheh_inngest']
            generation = query('nocheh_control', 'SELECT generation FROM installation')
            assert generation
            assert query('nocheh', "SELECT count(*) FROM pg_roles WHERE rolname IN ("
                         "'nocheh_archive','nocheh_derived','nocheh_control') AND rolcanlogin") == '3'
            run('restart', 'nocheh-db')
            run('up', '-d', '--no-build', '--wait', '--wait-timeout', '180', 'nocheh-db')
            assert query('nocheh_control', 'SELECT generation FROM installation') == generation

            control_password = values['NOCHEH_CONTROL_PASSWORD']
            values['NOCHEH_CONTROL_PASSWORD'] = 'invalid'
            write_env(state / '.env', values)
            rejected = run('up', '-d', '--no-build', '--force-recreate', '--wait',
                           '--wait-timeout', '40', 'nocheh-db', check=False)
            assert rejected.returncode != 0
            values['NOCHEH_CONTROL_PASSWORD'] = control_password
            write_env(state / '.env', values)
            run('up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '180', 'nocheh-db')
            assert query('nocheh_control', 'SELECT generation FROM installation') == generation

            query('nocheh', 'ALTER ROLE nocheh_archive NOLOGIN; ALTER ROLE nocheh_derived NOLOGIN; ALTER ROLE nocheh_control NOLOGIN')
            (state / 'spool/.restore-inactive').write_text('inactive fixture\n')
            run('restart', 'nocheh-db')
            run('up', '-d', '--no-build', '--wait', '--wait-timeout', '180', 'nocheh-db')
            assert query('nocheh', "SELECT count(*) FROM pg_roles WHERE rolname IN ("
                         "'nocheh_archive','nocheh_derived','nocheh_control') AND rolcanlogin") == '0'
            assert query('nocheh_control', 'SELECT generation FROM installation') == generation
            running = subprocess.check_output(command + ['ps', '--services', '--status', 'running'],
                                              env=compose_environment(state), text=True).split()
            assert running == ['nocheh-db'], running
            print(json.dumps({'passed': True, 'fresh_databases': names,
                              'repeat_preserved_generation': True,
                              'invalid_credential_failed_closed': True,
                              'inactive_restore_roles_stayed_disabled': True,
                              'standalone_bootstrap_containers': 0,
                              'external_credentials': False}))
        finally:
            run('down', '--volumes', '--remove-orphans', check=False)


if __name__ == '__main__':
    main()
