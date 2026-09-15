"""Run the owner dashboard independently of application containers."""
import argparse
import json
import os
import secrets
import subprocess
import time
import urllib.request
import urllib.error
import webbrowser
from pathlib import Path
from .configuration import ROOT, compose_environment, env_path


def request(state, path, body=None):
    token = (Path(state) / 'admin/dashboard/token').read_text().strip()
    url = 'http://127.0.0.1:'+os.environ.get('NOCHEH_DASHBOARD_PORT','8783')+'/api/plugins/nocheh' + path
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={'X-Hermes-Session-Token': token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response: return json.load(response)


def compose(state):
    return ['docker', 'compose', '--env-file', str(env_path(state)), '-f', str(ROOT / 'docker-compose.yml')]


def start(state, rest):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-open', action='store_true')
    parser.add_argument('--stop', action='store_true')
    args = parser.parse_args(rest)
    directory = Path(state) / 'admin/dashboard'; directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    token = directory / 'token'
    if not token.exists():
        with token.open('x') as file: token.chmod(0o600); file.write(secrets.token_urlsafe(48))
    command = compose(state)
    env = compose_environment(state)
    if args.stop:
        # Ask the authenticated owner process to stop itself; never trust a stale PID.
        try: request(state, '/shutdown', {})
        except urllib.error.HTTPError as error:
            if error.code == 409:
                print('Wait for the active operation to finish before stopping the dashboard.'); return 1
            raise
        except (urllib.error.URLError, FileNotFoundError): pass
        return 0
    try: running = request(state, '/health').get('ok') is True
    except Exception: running = False
    if not running:
        from .node_runtime import build,executable
        build(env)
        log = directory / 'server.log'
        with log.open('ab') as output:
            log.chmod(0o600)
            process = subprocess.Popen([executable(env), str(ROOT / 'dist/src/management.js')], cwd=ROOT, env=env,
                                       stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        for _ in range(60):
            if process.poll() is not None: raise RuntimeError('dashboard_start_failed')
            try:
                if request(state, '/health').get('ok'): break
            except Exception: time.sleep(.25)
        else: raise RuntimeError('dashboard_start_timeout')
    # A failed or stopped Hermes dashboard must not prevent archive/import access.
    url = 'http://127.0.0.1:'+env.get('NOCHEH_DASHBOARD_PORT','8783')+'/'
    print('Nocheh dashboard: ' + url,flush=True)
    if not args.no_open: webbrowser.open(url)
    return 0
