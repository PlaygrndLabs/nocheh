"""Thin host adapters. Protected files and arguments never enter Inngest history."""
import fcntl
import json
import re
import time
from .archive import API, canonical, digest
from .configuration import load
from .import_job import run


def tool_tick(state,body):
    from .tool_receipts import tick
    for key in ('action_id','workflow_id'):
        if not isinstance(body.get(key),str) or not re.fullmatch('[a-f0-9]{64}',body[key]):raise ValueError('invalid_workflow_identity')
    if not isinstance(body.get('workflow_token'),str) or not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',body['workflow_token']):raise ValueError('invalid_workflow_lease')
    # The executor's existing exact approval, current native preference check,
    # sandbox and durable receipt path remain outside the event engine.
    class WorkerAPI(API):
        def call(self,path,body=None,binary=False,timeout=10):
            return super().call(path,body,binary,15 if path.endswith('/finish') else 10)
    # Leave time for the executor's 90-second overall bound and receipt commit.
    # A large receipt backlog cannot cause the parent to kill a newly started tool.
    admission_deadline=time.monotonic()+120
    worked=tick(state,WorkerAPI(),'wf-'+body['workflow_id'],action_id=body['action_id'],workflow={k:body[k] for k in ('workflow_id','workflow_token')},admit=lambda:time.monotonic()<admission_deadline)
    return {'completed':int(worked)}


def import_batch(state, body):
    job=body['job'];lease=body['lease']
    if not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',job):raise ValueError('invalid_job')
    if not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',lease):raise ValueError('invalid_import_lease')
    directory=state/'admin/jobs'/job
    with (directory/'execution.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('import_batch_busy') from None
        metadata=json.loads((directory/'job.json').read_text())
        preview=metadata['preview'];mapping=metadata['mapping'];approved=metadata.get('review_approved') is True
        fingerprint=digest(canonical({'sha256':preview['sha256'],'mapping':mapping,'review_approved':approved,'total':preview['messages']}))
        if fingerprint!=body['configuration_hash']:raise ValueError('import_configuration_changed')
        policy=load(state)
        allowed=set(filter(None,[policy['TELEGRAM_OWNER_ID'],*policy['TELEGRAM_GROUP_IDS'].split(',')]))
        if not isinstance(mapping,dict) or any(not isinstance(k,str) or v not in allowed for k,v in mapping.items()):raise ValueError('scope_mapping_denied')
        return run(directory,mapping,body['completed'],API(job,lease),limit=50,duplicates=body['duplicates'],learning_after=body['learning_after'])
