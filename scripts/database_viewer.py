"""Provision the optional local pgweb browser with a PostgreSQL read-only role."""
import secrets
import subprocess

from configuration import load, write_env, env_path, compose_environment


def start(state, command, root):
    values = load(state)
    password = values.get('NOCHEH_VIEWER_PASSWORD') or secrets.token_hex(32)
    # Generated hex keeps the credential literal in both SQL and the database URL.
    if len(password) != 64 or any(c not in '0123456789abcdef' for c in password):
        raise ValueError('NOCHEH_VIEWER_PASSWORD must be 64 lowercase hex characters')
    values['NOCHEH_VIEWER_PASSWORD'] = password
    write_env(env_path(state), values)
    env = compose_environment(state)
    result = subprocess.call(command + ['up', '-d', '--wait', 'postgres'], cwd=root, env=env)
    if result:
        return result
    sql = """
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nocheh_viewer') THEN
    CREATE ROLE nocheh_viewer LOGIN;
  END IF;
END $$;
ALTER ROLE nocheh_viewer WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '%s';
GRANT pg_read_all_data TO nocheh_viewer;
GRANT CONNECT ON DATABASE nocheh TO nocheh_viewer;
ALTER ROLE nocheh_viewer SET default_transaction_read_only = on;
ALTER ROLE nocheh_viewer SET statement_timeout = '15s';
""" % password
    # Never put SQL containing the password in argv, logs, or error output.
    result = subprocess.run(command + ['exec', '-T', 'postgres', 'psql', '-U', 'nocheh',
        '-d', 'nocheh', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=root, env=env)
    if result.returncode:
        print('Database viewer role setup failed; PostgreSQL exit code:', result.returncode)
        return result.returncode
    result = subprocess.call(command + ['--profile', 'tools', 'up', '-d', '--wait',
        '--no-deps', 'db-viewer'], cwd=root, env=env)
    if result == 0:
        print('Read-only archive browser: http://127.0.0.1:8782')
    return result
