"""The turn's bound Nocheh credential and Nocheh requests of the turn itself. Scope is bound by the trusted dispatcher, never an argument.

Nocheh's data tools are not here: Hermes reaches them at Nocheh's MCP endpoint (assistant_turn.connect_data_tools)."""
import contextvars
import json
import math
import os
import time
import urllib.request

ARCHIVE_CREDENTIAL = contextvars.ContextVar('nocheh_archive_credential', default=None)
_PROCESS_CREDENTIAL = None
_PROCESS_DEADLINE = None


def bind_process_credential(credential):
    """Trusted child startup binds once; tool arguments cannot replace the scope."""
    global _PROCESS_CREDENTIAL
    if _PROCESS_CREDENTIAL is not None or not isinstance(credential,str) or not credential.startswith(('scope.','turn.')):
        raise RuntimeError('invalid_process_scope_binding')
    _PROCESS_CREDENTIAL=credential


def bind_process_deadline(deadline, background=False):
    """The trusted parent turn's deadline, bound once; Nocheh's MCP endpoint fits a long memory recall into it. A background
    job run, up to its job's hard deadline, is the only one that may last longer than ten minutes, and never longer than its
    credential's hour."""
    global _PROCESS_DEADLINE
    if (_PROCESS_DEADLINE is not None or isinstance(deadline,bool) or
            not isinstance(deadline,(int,float)) or not math.isfinite(deadline) or
            deadline > time.time()+(3600 if background else 600)):
        raise RuntimeError('invalid_process_deadline')
    _PROCESS_DEADLINE=float(deadline)


def request(path,body=None,timeout=None):
    credential = _PROCESS_CREDENTIAL or ARCHIVE_CREDENTIAL.get()
    if not credential:
        raise RuntimeError('archive_scope_not_bound')
    req = urllib.request.Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780') + path,
                                 data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
                                 headers={'Authorization': 'Bearer ' + credential,'Content-Type':'application/json'})
    # Prepared context can include a cold guard-model pass. It is still bounded,
    # but must not share the short timeout used by ordinary archive reads.
    timeout = timeout or (60 if path == '/v1/context/prepare' else 15)
    with urllib.request.urlopen(req,timeout=timeout) as response:
        data=response.read(2*1024*1024+1)
        if len(data)>2*1024*1024:
            raise ValueError('archive_response_too_large')
        return json.loads(data)


def import_status():
    """History still being imported says so, so an answer about it is not taken as complete."""
    try:
        pending=request('/v1/imports/pending').get('imports') or []
        return '; '.join(f"Still importing{' '+item['label'] if item.get('label') else ''}: {int(item['ready_percent'])}% of "
                         f"{int(item['messages'])} messages ready, so older history may be missing" for item in pending) or None
    except Exception:
        return None


# The job codes Nocheh's job tool may relay; test/store-job-repo.test.ts checks the broker relays exactly these.
JOB_ERRORS=('invalid_job_request','job_not_permitted','job_not_found','job_limit_reached','job_not_running','job_in_a_job','job_box_not_allowed','job_changed','job_too_long','job_repo_not_allowed')


def isolated_runtime():
    """Whether job runs run in the isolated runtime, the only one with sealed boxes: this is an
    isolated turn (its container does not carry the runtime setting), or the setting says so."""
    from .security_transport import isolated_enabled
    return os.environ.get('NOCHEH_ISOLATED_TURN')=='1' or isolated_enabled()


def reaction_observation(event):
    """Retain guarded reaction evidence; unrelated payload content stays omitted."""
    payload=event.get('payload')
    if not isinstance(payload,dict):return None
    for key,mode,fields in (
        ('message_reaction','individual',('date','user','actor_chat','old_reaction','new_reaction')),
        ('message_reaction_count','aggregate',('date','reactions')),
    ):
        value=payload.get(key)
        if not isinstance(value,dict):continue
        observation={'mode':mode,**{field:value[field] for field in fields if field in value}}
        if len(json.dumps(observation,ensure_ascii=False))>6000:return {'mode':mode,'unavailable':'observation_size_limit'}
        return observation
    return None
