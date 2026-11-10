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
