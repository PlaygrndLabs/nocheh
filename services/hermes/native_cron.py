"""Native Hermes job definitions, with managed execution fields and strict locking."""
import contextlib
import fcntl
import hashlib
import json
import os
import re
import uuid
from datetime import datetime,timezone,timedelta
from pathlib import Path
from urllib.request import Request,urlopen
from services.durable import canonical


def archive(route,body,token):
    request=Request(os.environ.get('ARCHIVE_URL','http://nocheh-app:8780')+'/v1/scheduler/'+route,
        data=canonical(body),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urlopen(request,timeout=15) as response:return json.load(response)


@contextlib.contextmanager
def store(home):
    from cron.jobs import use_cron_store
    from hermes_constants import set_hermes_home_override,reset_hermes_home_override
    home=Path(home);directory=home/'cron'
    if home.is_symlink() or directory.is_symlink():raise ValueError('cron_path_denied')
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (directory/'.nocheh.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        override=set_hermes_home_override(str(home))
        try:
            with use_cron_store(home):yield
        finally:reset_hermes_home_override(override)


def inspect(home):
    path=Path(home)/'cron/jobs.json'
    if Path(home).is_symlink() or path.parent.is_symlink() or path.is_symlink():raise ValueError('cron_path_denied')
    if not path.exists():return []
    data=json.loads(path.read_text());jobs=data.get('jobs') if isinstance(data,dict) else None
    if not isinstance(jobs,list):raise ValueError('cron_store_invalid')
    return jobs


def definition(job,profile):
    return {'profile':profile,'name':job.get('name'),'prompt':job['prompt'],'schedule':job['schedule'],
        'deliver':job.get('deliver','local'),'repeat':(job.get('repeat') or {}).get('times'),
        'enabled':job.get('enabled',True),'removed':job.get('nocheh_removed',False),
        'preferences':job.get('nocheh_preferences',{}),'execution_version':job.get('nocheh_definition_version'),
        # A schedule set in a chat runs in the owner's time zone (ADR-0266); one without a zone in Hermes's own.
        'timezone':job.get('timezone') if isinstance(job.get('timezone'),str) else None}


def revision(job,profile):return hashlib.sha256(canonical(definition(job,profile))).hexdigest()


def workflow_cursor(job,profile):
    return hashlib.sha256(canonical({'definition':definition(job,profile),'next':job.get('next_run_at'),
        'pending':job.get('nocheh_pending'),'running':job.get('nocheh_running'),
        'completed':(job.get('repeat') or {}).get('completed',0)})).hexdigest()


# How long a change whose answer was lost is posted again when Nocheh refuses it: the original post may still be
# committing there meanwhile, and a press's edit grant lives three minutes.
POSTING_SECONDS=180


def sync_job(call,job,profile,scope,grant=None):
    from cron import jobs as native
    # Persist order before publishing so a delayed older acknowledgment cannot
    # replace a later native definition or occurrence checkpoint in the archive.
    updates={'nocheh_workflow_revision':int(job.get('nocheh_workflow_revision',0))+1}
    if job.get('state')=='completed' and not job.get('enabled'):updates['next_run_at']=None
    job=native.update_job(job['id'],updates)
    body={'scope':scope,'profile':profile,'job_id':job['id'],'definition':definition(job,profile),
        'workflow_cursor':workflow_cursor(job,profile),'workflow_sequence':job['nocheh_workflow_revision']}
    if not job.get('nocheh_registered'):
        # A change (a turn's or a press's) whose answer is lost (a timeout, a network error, a restart) is posted again,
        # the very same body, by the scheduler loop until Nocheh answers (Scheduler.resume).
        job=native.update_job(job['id'],{'nocheh_posting':{'body':body,'grant':grant,'revision':revision(job,profile),
            'until':(datetime.now(timezone.utc)+timedelta(seconds=POSTING_SECONDS)).isoformat()}})
    # Nocheh takes a changed definition only with its own grant (an owner or member press); without one, only a
    # checkpoint of the version it already holds.
    call('definition',{**body,**({'grant':grant} if grant else {})})
    return mark_saved(native,job,profile)


def mark_saved(native,job,profile):
    """The definition Nocheh captured: a later change Hermes makes itself (its schedule tool) differs from it (ADR-0266)."""
    return native.update_job(job['id'],{'nocheh_registered':True,'nocheh_workflow_synced':True,'nocheh_synced_revision':revision(job,profile),
        'nocheh_posting':None,**({'last_error':None} if job.get('last_error')=='not_saved' else {})})


def transient(error):
    """Whether a post's outcome is unknown or may change on its own: no answer (a timeout or a lost connection), a server
    error, or a guard or owner change."""
    from http.client import HTTPException
    status,code=refusal(error)
    if status is None:return isinstance(error,(OSError,HTTPException))
    return status>=500 or status==429 or code in ('guard_context_changed','guard_transition_pending','workflow_owner_changed')


def not_saved(native,job):
    """A change Nocheh refused for good: the job stays inert and says so on the Schedules pages. A removal Nocheh did
    not take shows again, so it can be deleted again and its row stops counting."""
    updates={'nocheh_posting':None,'last_error':'not_saved'}
    if job.get('nocheh_removed'):updates['nocheh_removed']=False
    return native.update_job(job['id'],updates)


def refusal(error):
    """(status, code) of a call Nocheh refused: its body is {"error":code}. (None, None) for anything else."""
    from urllib.error import HTTPError
    if not isinstance(error,HTTPError):return None,None
    if not hasattr(error,'nocheh_code'):
        try:code=json.load(error).get('error')
        except Exception:code=None
        finally:error.close()
        error.nocheh_code=code if isinstance(code,str) else None
    return error.code,error.nocheh_code


def turn_notice(job):
    """What Nocheh's message in the chat says of a schedule set by asking: its name, when, its zone, its next run."""
    return {'name':job.get('name') or '','schedule':job.get('schedule_display') or (job.get('schedule') or {}).get('display') or '',
        'timezone':job.get('timezone') if isinstance(job.get('timezone'),str) else None,'next_run_at':job.get('next_run_at')}


def turn_capture(job_id,home,profile,scope,request):
    """A schedule the owner or a member set by asking, sent from inside their sealed turn with its pass: Nocheh records it
    for this turn's person and chat (ADR-0290), or refuses. A new schedule it refused is removed again; a changed one stays
    inert, shown as not saved. One whose answer was lost is posted again by the scheduler loop. Raises the failure."""
    from cron import jobs as native
    answer={}
    with store(home):
        job=next((job for job in inspect(home) if job['id']==job_id),None)
        if not job:raise ValueError('cron_job_not_found')
        # Hermes's tool names its own delivery targets; a schedule set in a chat sends to that chat.
        if job.get('deliver','local')!='telegram':job=native.update_job(job_id,{'deliver':'telegram'})
        if not job.get('nocheh_registered') or not job.get('nocheh_definition_version') or revision(job,profile)!=job.get('nocheh_synced_revision'):
            job=native.update_job(job_id,{'nocheh_definition_version':uuid.uuid4().hex,'nocheh_registered':False})
        notice=turn_notice(job)
        def call(_route,body):answer.update(request('/v1/schedules/turn/definition',{**body,'notice':notice}))
        try:sync_job(call,job,profile,scope)
        except Exception as error:
            if not transient(error):
                job=next((stored for stored in inspect(home) if stored['id']==job_id),job)
                # The turn says it was not saved: a new one leaves nothing behind, so asking again sets no second one.
                if not job.get('nocheh_synced_revision'):native.remove_job(job_id)
                else:not_saved(native,job)
            raise
        native.update_job(job_id,{'nocheh_announced':True})
    return answer


def turn_remove(job,profile,scope,request):
    """A registered schedule Hermes's tool removed in a turn: Nocheh records the removal, so its row neither waits nor
    counts toward the chat's limit. The job is gone from the store, so this posts its last copy."""
    job={**job,'enabled':False,'nocheh_removed':True,'nocheh_definition_version':uuid.uuid4().hex,
        'nocheh_workflow_revision':int(job.get('nocheh_workflow_revision',0))+1}
    return request('/v1/schedules/turn/definition',{'scope':scope,'profile':profile,'job_id':job['id'],'definition':definition(job,profile),
        'workflow_cursor':workflow_cursor(job,profile),'workflow_sequence':job['nocheh_workflow_revision']})


def profiles(admin):
    for item in admin.profiles()['profiles']:
        # The logical profile is the chat link; the listed name is only how the dashboard finds it.
        name,home=admin.profile(item.get('logical_profile') or item['name']);bound=admin.binding(name)
        logical=admin.preference_home(name,home)
        yield name,logical,bound


def delivery_policy(job,bound,served=None):
    """How a schedule's results go out (ADR-0266): kept local; sent to the owner's private chat, or a member's own chat
    with Personal assistant on, with no card, since its person approved that chat's schedules once; or, for a group,
    each result waits for the owner's card."""
    if job.get('deliver','local')=='local':return 'local'
    member=served is not None and not bound.owner and served.member_assistant(bound.chat_id)
    return 'send_each_result' if bound.owner or member else 'review_each_result'


def _annotate(job,home,selected,bound,served=None):
    return {**job,'profile':selected,'profile_name':selected,'hermes_home':str(home),
        '_nocheh_revision':revision(job,home.name),'managed':bool(job.get('nocheh_registered')),
        'delivery_policy':delivery_policy(job,bound,served)}


def manage(admin,path,method,query,body,headers,call=None):
    """Hermes's Cron page reads (ADR-0290: it changes nothing), and the owner adapter's pause, resume, run now and delete,
    each carrying the request id Nocheh granted."""
    call=call or (lambda route,payload:archive(route,payload,admin.agent_key))
    if path=='/api/cron/delivery-targets':return {'targets':[
        {'id':'local','name':'Local (save only)','home_target_set':True,'home_env_var':None},
        {'id':'telegram','name':'Telegram to this chat (no card in your private chat; a group\'s results wait for your card)',
         'home_target_set':True,'home_env_var':None}]}
    if path=='/api/cron/blueprints':return {'blueprints':[]}
    match=re.fullmatch(r'/api/cron/jobs(?:/([a-zA-Z0-9_-]{1,128})(?:/(runs|pause|resume|trigger))?)?',path)
    if not match:raise ValueError('cron_operation_unavailable')
    job_id,operation=match.groups();selected=query.get('profile',['default'])[0]
    policy=getattr(admin,'policy',None);served=policy.current() if policy is not None else None
    annotate=lambda job,home,name,bound:_annotate(job,home,name,bound,served)
    if selected=='all' and method=='GET' and not job_id:
        return [annotate(job,home,name,bound) for name,home,bound in profiles(admin) for job in inspect(home) if not job.get('nocheh_removed')]
    name,physical=admin.profile(selected);bound=admin.binding(name);home=admin.preference_home(name,physical)
    if bound.space!=bound.chat_id:raise ValueError('cron_topic_scope_unavailable')
    if operation=='runs' and method=='GET':
        result=call('runs',{'profile':home.name,'job_id':job_id})
        return {'runs':[{'id':row['native_session'],'source':'scheduler','title':row['state']+': '+(row.get('error_code') or 'scheduled run'),
            'started_at':datetime.fromisoformat(row['created_at'].replace('Z','+00:00')).timestamp(),'is_active':row['state']=='running',
            'message_count':0,'profile':name,'nocheh_event_id':row['event_id']} for row in result['runs'] if row.get('native_session') and row['payload']['profile']==name],'limit':100}
    jobs=inspect(home)
    if method=='GET':
        if not job_id:return [annotate(job,home,name,bound) for job in jobs if not job.get('nocheh_removed')]
        job=next((job for job in jobs if job['id']==job_id and not job.get('nocheh_removed')),None)
        if not job:raise ValueError('cron_job_not_found')
        return annotate(job,home,name,bound)
    # Only the owner adapter changes a schedule here, each change with the request id of Nocheh's grant. Creating,
    # editing, catching up and cancelling are gone (ADR-0290): a schedule is set by asking in a chat.
    if not job_id or not (method=='POST' and operation in ('pause','resume','trigger') or method=='DELETE' and not operation):
        raise ValueError('cron_operation_unavailable')
    identity=body.get('request_id') or headers.get(b'idempotency-key',b'').decode()
    if not isinstance(identity,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}',identity):raise ValueError('cron_request_identity_required')
    from cron import jobs as native
    with store(home):
        jobs=inspect(home);job=next((job for job in jobs if job['id']==job_id and not job.get('nocheh_removed')),None)
        if not job:raise ValueError('cron_job_not_found')
        grant=None
        if operation=='trigger':
            # Run now moves only the cursor (a checkpoint); the fire itself then needs Nocheh's run-now grant.
            if not job.get('nocheh_registered'):raise ValueError('cron_definition_not_captured')
            if job.get('nocheh_pending') or job.get('nocheh_running'):raise ValueError('cron_already_pending')
            if job.get('nocheh_last_request')==identity:return annotate(job,home,name,bound)
            job=native.update_job(job_id,{'nocheh_pending':{'id':identity,'reason':'manual','at':datetime.now(timezone.utc).isoformat()},'nocheh_last_request':identity})
        elif operation in ('pause','resume'):
            grant=identity
            job=native.update_job(job_id,{'enabled':operation=='resume','state':'scheduled' if operation=='resume' else 'paused','nocheh_registered':False})
        else:
            grant=identity
            if event:=job.get('nocheh_running'):call('cancel',{'event_id':event})
            removal={'enabled':False,'nocheh_removed':True,'nocheh_registered':False,'nocheh_pending':None}
            # Hermes keeps a finished job terminal; only a live job is paused on removal.
            if job.get('state') not in ('completed','error'):removal['state']='paused'
            recorded=job.get('nocheh_registered') or job.get('nocheh_synced_revision')
            job=native.update_job(job_id,removal)
            # One Nocheh never recorded (set in a turn it refused) has nothing there to remove; it is gone here.
            if not recorded:return {'ok':True}
        if not job.get('nocheh_registered'):
            # A refused or failed archive write leaves the native definition intact but inert: the scheduler never
            # executes a definition Nocheh did not capture.
            job=native.update_job(job['id'],{'nocheh_definition_version':uuid.uuid4().hex})
        job=native.update_job(job['id'],{'nocheh_workflow_synced':False})
        try:job=sync_job(call,job,home.name,bound.chat_id,grant)
        except Exception as error:
            # A lost answer is posted again by the scheduler loop with the same grant; a refusal is final.
            if transient(error):raise
            not_saved(native,next((stored for stored in inspect(home) if stored['id']==job_id),job))
            if refusal(error)[0]==403:raise ValueError('cron_change_refused') from None
            raise
        return {'ok':True} if method=='DELETE' else annotate(job,home,name,bound)


SCHEDULE_ACTIONS={'pause':('POST','/pause'),'resume':('POST','/resume'),'run':('POST','/trigger'),'delete':('DELETE','')}


def listed(job,name,bound):
    """What the owner's Schedules pages show of a schedule: no prompt text, Hermes's own fields by their meaning. One
    whose last change Nocheh did not save (ADR-0290) is not saved: it has no next run, since it does not run."""
    repeat=job.get('repeat') or {};saved=bool(job.get('nocheh_registered'))
    state=job.get('state') or ('scheduled' if job.get('enabled',True) else 'paused')
    return {'id':job['id'],'profile':name,'scope':bound.chat_id,'space':bound.space,'name':job.get('name') or '',
        'schedule':job.get('schedule_display') or (job.get('schedule') or {}).get('display') or '',
        'timezone':job.get('timezone') if isinstance(job.get('timezone'),str) else None,
        'enabled':bool(job.get('enabled',True)),'state':state if saved or state=='completed' else 'not_saved','saved':saved,
        'next_run_at':job.get('next_run_at') if saved else None,'last_run_at':job.get('last_run_at'),'last_status':job.get('last_status'),
        'last_error':job.get('last_error'),'last_delivery_error':job.get('last_delivery_error'),
        'running':bool(job.get('nocheh_running')),'pending':bool(job.get('nocheh_pending')),
        'set_in_chat':not job.get('nocheh_create_id'),'deliver':job.get('deliver','local'),
        'repeat':{'times':repeat.get('times'),'completed':repeat.get('completed',0)},'created_at':job.get('created_at')}


def owner_schedules(admin,body,call=None):
    """The owner's Schedules pages (ADR-0266): every chat's schedules, or one schedule paused, resumed, run now or deleted,
    each with the grant Nocheh issued for that press (ADR-0290)."""
    operation=body.get('operation')
    if operation=='list':
        found,seen=[],set()
        for _,home,bound in profiles(admin):
            if home.name in seen:continue
            seen.add(home.name);found+=[listed(job,home.name,bound) for job in inspect(home) if not job.get('nocheh_removed')]
        return {'schedules':found}
    if operation not in SCHEDULE_ACTIONS:raise ValueError('cron_operation_unavailable')
    job_id,profile=body.get('job_id'),body.get('profile')
    if not isinstance(job_id,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}',job_id):raise ValueError('cron_job_not_found')
    if not isinstance(profile,str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}',profile):raise ValueError('profile_scope_denied')
    # The request id names Nocheh's grant for this one press (ADR-0290), so it is required for every change.
    method,suffix=SCHEDULE_ACTIONS[operation];request=body.get('request_id')
    if not isinstance(request,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}',request):raise ValueError('cron_request_identity_required')
    result=manage(admin,'/api/cron/jobs/'+job_id+suffix,method,{'profile':[profile]},{'request_id':request},{},call)
    return {'ok':True} if operation=='delete' else {'schedule':listed(result,profile,admin.binding(admin.profile(profile)[0]))}
