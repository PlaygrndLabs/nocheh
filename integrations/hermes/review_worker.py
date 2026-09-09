"""Supervisor entry for a private, externally effect-free native review worker."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from .scopes import Scopes, Scope
from .assistant_gateway import prepare_profile


def review(root, policy, model, credentials, body):
    if not policy.owner or body.get('scope') != policy.owner:
        raise ValueError('owner_review_required')
    if not re.fullmatch(r'[a-f0-9]{64}',body.get('id','')) or not isinstance(body.get('content'),str) or len(body['content'])>12000:
        raise ValueError('invalid_review_request')
    scope=Scope(policy.owner,policy.owner,True,Scopes.profile(policy.owner))
    import base64
    scope=Scopes.apply_revision(scope,json.loads(base64.urlsafe_b64decode(body['archive_credential'].split('.')[1]+'===')))
    profile=prepare_profile(root,scope,model)
    env={key:os.environ[key] for key in ('PATH','HOME','LANG','LC_ALL','PYTHONPATH','LD_LIBRARY_PATH','ARCHIVE_URL','GUARD_URL','GUARD_TRUSTED_ENDPOINTS','NOCHEH_REASONING_ROUTE') if key in os.environ}
    env.update(HERMES_HOME=str(profile),NOCHEH_CAPTURE_ENABLED='0',GUARD_MODE=body.get('guard_mode','on'))
    transport = credentials.runtime() if hasattr(credentials,'runtime') else {
        'api_key':credentials.access_token,'base_url':'https://chatgpt.com/backend-api/codex',
        'provider':'openai-codex','api_mode':'codex_responses'}
    request={'review':True,'review_id':body['id'],'text':body['content'],'model':model,'archive_credential':body['archive_credential'],
             'session_id':'review-'+body['id'],'owner':True,'chat_id':policy.owner,'user_id':policy.owner,**transport}
    result=subprocess.run([sys.executable,'-m','integrations.hermes.assistant_turn'],input=json.dumps(request).encode(),
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,timeout=220,cwd=Path(__file__).resolve().parents[2])
    if result.returncode or len(result.stdout)>1024*1024:raise RuntimeError('review_worker_failed')
    return json.loads(result.stdout)
