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
from tools.operations.installation.configuration import ROOT, compose_environment, env_path, compose_command


def request(state, path, body=None):
    token = (Path(state) / 'admin/dashboard/token').read_text().strip()
    port=os.environ.get('NOCHEH_DASHBOARD_PORT') or compose_environment(state)['NOCHEH_DASHBOARD_PORT']
    url = 'http://127.0.0.1:'+port+'/api/plugins/nocheh' + path
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={'X-Hermes-Session-Token': token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as response: return json.load(response)


def script_reports(state):
    """What browsers reported about the Hermes page's script rules while they are only reported (ADR-0251): how many,
    since when, and which rule, blocked site and page. The dashboard counts them; diagnose shows them."""
    try:
        value = json.loads((Path(state) / 'admin/dashboard/csp-reports.json').read_text())
    except FileNotFoundError:
        return {'mode': 'report_only', 'total': 0, 'first_at': None, 'last_at': None, 'kinds': []}
    except (OSError, ValueError):
        return {'mode': 'report_only', 'error': 'unreadable'}
    kinds = value.get('kinds') if isinstance(value, dict) else None
    return {'mode': 'report_only', 'total': value.get('total', 0) if isinstance(value, dict) else 0,
            'first_at': value.get('first_at') if isinstance(value, dict) else None,
            'last_at': value.get('last_at') if isinstance(value, dict) else None,
            'kinds': [{key: kind.get(key) for key in ('directive', 'blocked', 'page', 'count', 'last_at')}
                      for kind in (kinds if isinstance(kinds, list) else []) if isinstance(kind, dict)]}


def compose(state):
    return compose_command(state)


def start(state, rest):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-open', action='store_true')
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--stop', action='store_true')
    actions.add_argument('--clear-pause', action='store_true',
                         help='End every sign-in pause from wrong passwords, in the browser and on phones')
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
    if args.clear_pause:
        # The installation token ends the pause, so a forgotten count never means removing the password file (ADR-0251).
        try: cleared = request(state, '/owner-lock/clear-pause', {}).get('cleared', 0)
        except (urllib.error.URLError, OSError, ValueError) as error:
            print('The sign-in pause could not be cleared: the dashboard did not answer '
                  f'({getattr(error, "code", None) or type(error).__name__}). Try again in a minute.', flush=True)
            return 1
        print('Sign-in pause cleared. Sign in again with your password.' if cleared else
              'No sign-in was paused. Wrong passwords counted so far are forgotten.', flush=True)
    # A failed or stopped Hermes dashboard must not prevent archive/import access.
    url = 'http://127.0.0.1:'+env.get('NOCHEH_DASHBOARD_PORT','8783')+'/'
    print('Nocheh dashboard: ' + url,flush=True)
    if not args.no_open: webbrowser.open(url)
    return 0
