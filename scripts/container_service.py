"""Foreground entrypoints and content-free health for Compose administration."""
import json
import os
import secrets
import sys
import time
from pathlib import Path
from .configuration import ROOT


def main(args):
    state=Path(os.environ['NOCHEH_STATE_DIR'])
    if args==['executor-health']:
        try:
            value=json.loads((state/'admin/workflows/status.json').read_text())
            return 0 if value['state'] in ('running','inactive') and time.time()-value['seen_at']<30 else 1
        except (OSError,ValueError,KeyError):return 1
    if args==['dashboard-health']:
        from .dashboard import request
        try:return 0 if request(state,'/health').get('ok') else 1
        except Exception:return 1
    if args==['dashboard']:
        directory=state/'admin/dashboard';directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        token=directory/'token'
        if not token.exists():
            with token.open('x') as file:token.chmod(0o600);file.write(secrets.token_urlsafe(48))
        os.execvp('node',['node',str(ROOT/'dist/src/management.js')])
    if args==['executor']:
        from .workflow_worker import serve
        return serve(state)
    raise ValueError('unknown_container_service')


if __name__=='__main__':raise SystemExit(main(sys.argv[1:]))
