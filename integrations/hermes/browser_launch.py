"""Fixed native TUI launch: no shell, workspace imports, refresh store or gateway URL."""
import os
from pathlib import Path
from .scopes import Scope, Scopes


def launch(admin, resume=None, sidecar_url=None, profile=None, active_session_file=None):
    name, home = admin.profile(profile)
    chat = next((chat for chat in [admin.policy.owner,*admin.policy.groups] if chat and Scopes.profile(chat)==name),admin.policy.owner)
    owner = chat == admin.policy.owner
    if not chat: raise ValueError('owner_required')
    from .assistant_gateway import prepare_profile
    prepare_profile(admin.root,Scope(chat,admin.policy.owner,owner,name),admin.model)
    workspace = home / 'workspace'
    if workspace.is_symlink(): raise ValueError('workspace_path_denied')
    workspace.mkdir(exist_ok=True,mode=0o700)
    if resume:
        from hermes_state import SessionDB
        # Explicit resume IDs are verified by the authenticated WS boundary.
        # A keep-alive channel may still point at an unpersisted native draft.
        if not (home/'state.db').exists(): resume=None
        else:
            db=SessionDB(home/'state.db',read_only=True)
            try:
                if not db.get_session(resume): resume=None
            finally: db.close()
    env = {key:os.environ[key] for key in ('LANG','LC_ALL','LD_LIBRARY_PATH','SERVICE_TOKEN',
        'ARCHIVE_URL','GUARD_URL','GUARD_MODE','GUARD_TRUSTED_ENDPOINTS') if key in os.environ}
    env.update(PATH='/opt/venv/bin:/usr/local/bin:/usr/bin:/bin',HOME=str(home),HERMES_HOME=str(home),
        PYTHONPATH='/workspace:/opt/hermes',HERMES_PYTHON='/opt/venv/bin/python',
        HERMES_PYTHON_SRC_ROOT='/opt/hermes',HERMES_CWD=str(workspace),
        NOCHEH_RUNTIME_HOME=str(admin.root),NOCHEH_MODEL=admin.model,
        NOCHEH_BROWSER_PROFILE=name,NOCHEH_BROWSER_SCOPE=chat,NOCHEH_BROWSER_OWNER='1' if owner else '0',
        NOCHEH_BROWSER_OWNER_ID=admin.policy.owner,NOCHEH_CAPTURE_ENABLED='0',
        NODE_ENV='production',HERMES_TUI_DISABLE_MOUSE='1',HERMES_TUI_INLINE='1',HERMES_TUI_DASHBOARD='1',
        COLORTERM='truecolor',TERM='xterm-256color')
    if resume: env['HERMES_TUI_RESUME']=resume
    if sidecar_url:
        from urllib.parse import urlsplit,parse_qs,urlencode
        parsed=urlsplit(sidecar_url)
        if parsed.scheme!='ws' or parsed.hostname!='127.0.0.1' or parsed.port!=8785 or parsed.path!='/api/pub': raise ValueError('invalid_metadata_destination')
        query=parse_qs(parsed.query);query['profile']=[name]
        env['HERMES_TUI_SIDECAR_URL']=parsed._replace(query=urlencode(query,doseq=True)).geturl()
    if active_session_file: env['HERMES_TUI_ACTIVE_SESSION_FILE']=active_session_file
    return ['/usr/local/bin/node','/opt/hermes/ui-tui/dist/entry.js'],str(workspace),env
