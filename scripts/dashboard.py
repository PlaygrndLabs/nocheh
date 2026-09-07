"""Start the local native shell and TypeScript owner management service."""
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
    url = 'http://127.0.0.1:8783/api/plugins/nocheh' + path
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={'X-Hermes-Session-Token': token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response: return json.load(response)


def start(state, rest):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-open', action='store_true')
    parser.add_argument('--stop', action='store_true')
    args = parser.parse_args(rest)
    directory = Path(state) / 'admin/dashboard'; directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    token = directory / 'token'
    if not token.exists():
        with token.open('x') as file: token.chmod(0o600); file.write(secrets.token_urlsafe(48))
    command = ['docker', 'compose', '--env-file', str(env_path(state)), '-f', str(ROOT / 'docker-compose.dashboard.yml'), '-p', 'nocheh-dashboard']
    env = compose_environment(state)
    if args.stop:
        # Ask the authenticated owner process to stop itself; never trust a stale PID.
        try: request(state, '/shutdown', {})
        except urllib.error.HTTPError as error:
            if error.code == 409:
                print('Wait for the active operation to finish before stopping the dashboard.'); return 1
            raise
        except (urllib.error.URLError, FileNotFoundError): pass
        return subprocess.call(command + ['down'], cwd=ROOT, env=env)
    try: running = request(state, '/health').get('ok') is True
    except Exception: running = False
    if not running:
        subprocess.run(['npm', 'run', 'build'], cwd=ROOT, check=True)
        subprocess.run(command + ['up', '-d', '--build', '--wait', '--wait-timeout', '180'], cwd=ROOT, env=env, check=True)
        log = directory / 'server.log'
        with log.open('ab') as output:
            log.chmod(0o600)
            process = subprocess.Popen(['node', str(ROOT / 'dist/src/management.js')], cwd=ROOT, env=env,
                                       stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        for _ in range(60):
            if process.poll() is not None: raise RuntimeError('dashboard_start_failed')
            try:
                if request(state, '/health').get('ok'): break
            except Exception: time.sleep(.25)
        else: raise RuntimeError('dashboard_start_timeout')
    url = 'http://127.0.0.1:8783/nocheh'
    print('Nocheh dashboard: ' + url)
    if not args.no_open: webbrowser.open(url)
    return 0
