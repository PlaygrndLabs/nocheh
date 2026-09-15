"""Supervisor entry for a private, externally effect-free native review worker."""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from .scopes import Scopes, Scope
from .assistant_gateway import prepare_profile


def observe(root,policy,body):
    """Read a durable review receipt without login, preparation or execution."""
    import fcntl
    from .native_memory import registered_profiles
    if not policy.owner or body.get('scope')!=policy.owner:raise ValueError('owner_review_required')
    if not re.fullmatch('[a-f0-9]{64}',body.get('id','')):raise ValueError('invalid_review_request')
    found=[]
    for profile in registered_profiles(root):
        receipt=profile/'reviews'/body['id']
        if not receipt.exists():continue
        if receipt.is_symlink() or not receipt.resolve().is_relative_to(profile.resolve()):raise ValueError('review_receipt_path_denied')
        with receipt.open('r') as file:value=file.read(32)
        if value=='done':found.append('done');continue
        lock=profile/'.memory.lock'
        if lock.is_symlink():raise ValueError('review_receipt_path_denied')
        if not lock.exists():found.append('ambiguous');continue
        with lock.open('rb') as file:
            try:fcntl.flock(file,fcntl.LOCK_EX|fcntl.LOCK_NB);found.append('ambiguous')
            except BlockingIOError:found.append('running')
    return {'state':'running' if 'running' in found else 'ambiguous' if 'ambiguous' in found else 'done' if found else 'not_found'}


def review(root, policy, model, credentials, body):
    if not policy.owner or body.get('scope') != policy.owner:
        raise ValueError('owner_review_required')
    if not re.fullmatch(r'[a-f0-9]{64}',body.get('id','')) or not isinstance(body.get('content'),str) or len(body['content'])>12000:
        raise ValueError('invalid_review_request')
    scope=Scope(policy.owner,policy.owner,True,Scopes.profile(policy.owner))
    import base64
    scope=Scopes.apply_revision(scope,json.loads(base64.urlsafe_b64decode(body['archive_credential'].split('.')[1]+'===')))
    profile=prepare_profile(root,scope,model)
    import fcntl
    with (profile/'.turn.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'state':'waiting','error_code':'profile_busy'}
        # Leave a short quiet interval for conversational follow-ups. This
        # parent-owned timestamp contains no content and is not agent-mounted.
        # Existing review receipts stay authoritative; no running work is killed.
        activity=profile/'.foreground'
        if activity.exists() and time.time()-activity.stat().st_mtime<60:
            return {'state':'waiting','error_code':'profile_busy'}
        return _review(profile,policy,model,credentials,body)


def _review(profile,policy,model,credentials,body):
    env={key:os.environ[key] for key in ('PATH','HOME','LANG','LC_ALL','PYTHONPATH','LD_LIBRARY_PATH','ARCHIVE_URL','GUARD_URL','GUARD_TRUSTED_ENDPOINTS','NOCHEH_REASONING_ROUTE') if key in os.environ}
    env.update(HERMES_HOME=str(profile),NOCHEH_CAPTURE_ENABLED='0',GUARD_MODE=body.get('guard_mode','on'))
    transport = credentials.runtime() if hasattr(credentials,'runtime') else {
        'api_key':credentials.access_token,'base_url':'https://chatgpt.com/backend-api/codex',
        'provider':'openai-codex','api_mode':'codex_responses'}
    request={'review':True,'review_id':body['id'],'text':body['content'],'model':model,'archive_credential':body['archive_credential'],'memory_context':os.environ.get('NOCHEH_MEMORY_CONTEXT','legacy'),
             'session_id':'review-'+body['id'],'owner':True,'chat_id':policy.owner,'user_id':policy.owner,**transport}
    from .security_transport import isolated_enabled,scoped_transport
    module='integrations.hermes.assistant_turn'
    if isolated_enabled():
        from .isolated_profile import prepare
        from .profile_config import inherited_config,read,preferences
        from .environment import secret
        prepare(profile)
        effective,_=inherited_config(profile,read(profile/'config.yaml'))
        request.update(scoped_transport(body['archive_credential'],transport['api_mode']))
        request['preferences']=preferences(effective)
        env['SERVICE_TOKEN']=secret('SERVICE_TOKEN');module='integrations.hermes.security_client'
    result=subprocess.run([sys.executable,'-m',module],input=json.dumps(request).encode(),
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,timeout=220,cwd=Path(__file__).resolve().parents[2])
    if result.returncode or len(result.stdout)>1024*1024:raise RuntimeError('review_worker_failed')
    return json.loads(result.stdout)
