"""Host records cross the paused family boundary without executing product work."""
import fcntl
import json
import os
import re
import socket
from contextlib import contextmanager
from pathlib import Path
from .archive import API,canonical,digest
from .configuration import load
from .import_job import safe_name
from .tool_worker import atomic


@contextmanager
def stopped_dashboard():
    # Reserving the owner's existing port (without listening) both proves it is
    # stopped and prevents a concurrent restart from rewriting import metadata.
    port=int(os.environ.get('NOCHEH_DASHBOARD_PORT','8783'))
    with socket.socket() as reservation:
        try:reservation.bind(('127.0.0.1',port))
        except OSError:raise RuntimeError('stop_owner_dashboard_before_import_handoff') from None
        yield


def import_records(state,api,migration):
    policy=load(state);allowed=set(filter(None,[policy['TELEGRAM_OWNER_ID'],*policy['TELEGRAM_GROUP_IDS'].split(',')]))
    staged=closed=0
    directory=Path(state)/'admin/jobs'
    if not directory.exists():return {'staged':0,'closed':0}
    for folder in sorted(directory.iterdir()):
        if not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',folder.name):continue
        if folder.is_symlink() or (folder/'job.json').is_symlink():raise ValueError('import_job_path_denied')
        if not (folder/'job.json').is_file():continue
        with (folder/'execution.lock').open('a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:raise RuntimeError('legacy_import_still_running') from None
            job=json.loads((folder/'job.json').read_text())
            if job.get('kind')!='import':continue
            receipt=folder/'workflow-receipt.json'
            if receipt.exists():
                if receipt.is_symlink():raise ValueError('import_job_path_denied')
                value=json.loads(receipt.read_text());result=api.call('/v1/workflows/imports/legacy-finish',value)
                if result.get('state','completed')=='completed':job.update(state='complete',completed=value['completed'],duplicates=value['duplicates'])
                atomic(folder/'job.json',job);receipt.unlink()
            if migration['to_owner']=='legacy':
                # Existing restart behavior is explicit Resume import. Preserve
                # the original mapping/consent and expose its archive checkpoint.
                if job.get('workflow'):
                    current=api.call('/v1/workflows/imports/'+folder.name)
                    if current.get('owned'):
                        status=current['job'];job.update(completed=status['completed'],duplicates=status['duplicates'])
                        job['state']='interrupted' if status['state'] in ('queued','running') else 'complete' if status['state']=='completed' else status['state']
                        atomic(folder/'job.json',job);staged+=1
                continue
            if job.get('state') not in ('queued','running','interrupted'):
                closed+=1;continue
            if not isinstance(job.get('review_approved'),bool) or not isinstance(job.get('mapping'),dict) or not isinstance(job.get('preview'),dict):raise ValueError('confirmed_import_configuration_required')
            preview=job['preview'];mapping=job['mapping']
            if any(not isinstance(k,str) or v not in allowed for k,v in mapping.items()):raise ValueError('scope_mapping_denied')
            source=folder/safe_name(preview['file'])
            if source.is_symlink() or not source.resolve().is_relative_to(folder.resolve()) or source.stat().st_size>32*1024*1024:raise ValueError('import_source_path_denied')
            if digest(source.read_bytes())!=preview['sha256']:raise ValueError('export_integrity_failed')
            value={'id':folder.name,'configuration_hash':digest(canonical({'sha256':preview['sha256'],'mapping':mapping,'review_approved':job['review_approved'],'total':preview['messages']})),
                   'review_approved':job['review_approved'],'total':preview['messages'],'completed':job['completed'],'duplicates':job['duplicates'],'learning_after':0}
            api.call('/v1/workflows/migrations/'+migration['id']+'/imports',value)
            job['workflow']='inngest';atomic(folder/'job.json',job);staged+=1
    return {'staged':staged,'closed':closed}


def handoff(state,identity,api=None):
    api=api or API();migration=api.call('/v1/workflows/migrations/'+identity)
    if migration['state']!='paused' or migration['family'] not in ('imports','tools'):raise ValueError('migration_host_not_paused')
    from .workflow_worker import running as workflow_running,stop as stop_workflow,start as start_workflow
    from .tool_worker import running as tool_running,stop as stop_tool,start as start_tool,flush_receipts
    workflow_was_running=workflow_running(state);tool_was_running=tool_running(state)
    try:
        if workflow_was_running:stop_workflow(state,wait=True)
        if migration['family']=='tools':
            if tool_was_running:stop_tool(state,wait=True)
            result={'receipts':flush_receipts(state,api)}
        else:
            with stopped_dashboard():result=import_records(state,api,migration)
        api.call('/v1/workflows/migrations/'+identity+'/host-ready',{})
        return {'migration_id':identity,'family':migration['family'],**result,'state':'host_ready'}
    finally:
        if workflow_was_running:start_workflow(state)
        if migration['family']=='tools' and tool_was_running:start_tool(state)
