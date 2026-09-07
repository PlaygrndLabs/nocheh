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
    profile=prepare_profile(root,scope,model)
    env={key:os.environ[key] for key in ('PATH','HOME','LANG','LC_ALL','PYTHONPATH','LD_LIBRARY_PATH','SERVICE_TOKEN','SERVICE_TOKEN_FILE','GUARD_URL','GUARD_MODE','GUARD_TRUSTED_ENDPOINTS') if key in os.environ}
    env.update(HERMES_HOME=str(profile),NOCHEH_CAPTURE_ENABLED='0')
    request={'review':True,'review_id':body['id'],'text':body['content'],'model':model,
             'session_id':'review-'+body['id'],'owner':True,'chat_id':policy.owner,'user_id':policy.owner,'access_token':credentials.access_token}
    result=subprocess.run([sys.executable,'-m','integrations.hermes.assistant_turn'],input=json.dumps(request).encode(),
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,timeout=220,cwd=Path(__file__).resolve().parents[2])
    if result.returncode or len(result.stdout)>1024*1024:raise RuntimeError('review_worker_failed')
    return json.loads(result.stdout)
