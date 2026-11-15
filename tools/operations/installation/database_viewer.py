"""Provision the optional local pgweb browser with a PostgreSQL read-only role and its own web login."""
import secrets
import subprocess

from tools.operations.installation.configuration import load, write_env, env_path, compose_environment

# The viewer's web login (ADR-0251). The password lives only in the ignored .env, never in a command line.
WEB_USER = 'owner'


def generated(values, key):
    """Keeps a generated 64-character hex password, or makes one; hex stays literal in SQL, URLs and .env."""
    password = values.get(key) or secrets.token_hex(32)
    if len(password) != 64 or any(c not in '0123456789abcdef' for c in password):
        raise ValueError(key + ' must be 64 lowercase hex characters')
    return password


def web_login(state):
    """The viewer's web password, made and saved once. Returns it and whether it is new."""
    values = load(state)
    password = generated(values, 'NOCHEH_VIEWER_WEB_PASSWORD')
    new = values.get('NOCHEH_VIEWER_WEB_PASSWORD') != password
    if new:
        values['NOCHEH_VIEWER_WEB_PASSWORD'] = password
        write_env(env_path(state), values)
    return password, new


def show_login(env, password):
    print('Read-only archive browser: http://127.0.0.1:' + env['NOCHEH_VIEWER_PORT'])
    print('  It asks for a login once; your browser can save it.')
    print('  User: ' + WEB_USER)
    print('  Password: ' + password)


def start(state, command, root):
    values = load(state)
    password = generated(values, 'NOCHEH_VIEWER_PASSWORD')
    values['NOCHEH_VIEWER_PASSWORD'] = password
    values['NOCHEH_VIEWER_WEB_PASSWORD'] = generated(values, 'NOCHEH_VIEWER_WEB_PASSWORD')
    write_env(env_path(state), values)
    env = compose_environment(state)
    result = subprocess.call(command + ['up', '-d', '--wait', 'nocheh-db'], cwd=root, env=env)
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
    result = subprocess.run(command + ['exec', '-T', 'nocheh-db', 'psql', '-U', 'nocheh',
        '-d', 'nocheh', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, cwd=root, env=env)
    if result.returncode:
        print('Database viewer role setup failed; PostgreSQL exit code:', result.returncode)
        return result.returncode
    result = subprocess.call(command + ['--profile', 'tools', 'up', '-d', '--wait',
        '--no-deps', 'pgweb-archive'], cwd=root, env=env)
    if result == 0:
        show_login(env, values['NOCHEH_VIEWER_WEB_PASSWORD'])
    return result


def refresh(state, command, root):
    """After `up`, a viewer still running from before it had a login starts again with one (ADR-0251). It keeps
    running: Compose recreates it only when its settings changed. A stopped viewer stays stopped."""
    try:
        env = compose_environment(state)
        running = subprocess.run(command + ['--profile', 'tools', 'ps', '--status', 'running', '--quiet', 'pgweb-archive'],
                                 cwd=root, env=env, capture_output=True, text=True)
    except (OSError, ValueError):
        print('Could not check whether the database viewer runs. If it does, run ./bin/nocheh db to give it its login.')
        return 1
    if running.returncode or not running.stdout.strip():
        return 0
    # A login it can't make or save is reported like the rest, so up keeps its own result.
    try:
        password, new = web_login(state)
        env = compose_environment(state)
    except ValueError as error:
        print('The database viewer still runs without its login: ' + str(error) + ' in .env. '
              'Clear it there and run ./bin/nocheh db to make one.')
        return 1
    except OSError:
        print('Could not save the database viewer login. Run ./bin/nocheh db to give it its login.')
        return 1
    result = subprocess.call(command + ['--profile', 'tools', 'up', '-d', '--wait', '--no-deps', 'pgweb-archive'],
                             cwd=root, env=env)
    if result:
        print('The database viewer could not restart with its login. Run ./bin/nocheh db to start it again.')
    elif new:
        print('The database viewer now asks for a login.')
        show_login(env, password)
    return result
