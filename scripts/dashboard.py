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
from .configuration import ROOT, compose_environment, env_path, compose_command


def request(state, path, body=None):
    token = (Path(state) / 'admin/dashboard/token').read_text().strip()
    port=os.environ.get('NOCHEH_DASHBOARD_PORT') or compose_environment(state)['NOCHEH_DASHBOARD_PORT']
    url = 'http://127.0.0.1:'+port+'/api/plugins/nocheh' + path
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={'X-Hermes-Session-Token': token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response: return json.load(response)


def compose(state):
    return compose_command(state)


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
        # Refuse to interrupt an active backup/apply before stopping the container.
        try: request(state, '/shutdown', {})
        except urllib.error.HTTPError as error:
            if error.code == 409:
                print('Wait for the active operation to finish before stopping the dashboard.'); return 1
            raise
        except (urllib.error.URLError, FileNotFoundError): pass
        return subprocess.call(command+['stop','nocheh-dashboard'],env=env)
    subprocess.run(command+['up','-d','--no-deps','--no-build','--wait','nocheh-dashboard'],env=env,check=True)
    # A failed or stopped Hermes dashboard must not prevent archive/import access.
    url = 'http://127.0.0.1:'+env.get('NOCHEH_DASHBOARD_PORT','8783')+'/'
    print('Nocheh dashboard: ' + url,flush=True)
    if not args.no_open: webbrowser.open(url)
    return 0
