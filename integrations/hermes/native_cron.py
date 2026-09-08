"""Native Hermes job definitions, with managed execution fields and strict locking."""
import contextlib
import fcntl
import hashlib
import json
import os
import re
import uuid
from datetime import datetime,timezone
from pathlib import Path
from urllib.request import Request,urlopen
from .capture import canonical


def archive(route,body,token):
    request=Request(os.environ.get('ARCHIVE_URL','http://archive:8780')+'/v1/scheduler/'+route,
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
        'preferences':job.get('nocheh_preferences',{})}


def revision(job,profile):return hashlib.sha256(canonical(definition(job,profile))).hexdigest()


def fields(body,model):
    allowed={'name','prompt','schedule','deliver','repeat','profile','nocheh_preferences','_nocheh_revision'}
    empty_fields={'skills','skill','base_url','script','no_agent','context_from','enabled_toolsets','workdir','monitor_script','monitor_url','attach_to_session','failure_deliver','continuity'}
    for key,value in body.items():
        if key in allowed:continue
        if key in empty_fields and value in (None,'',False,[]):continue
        if key=='provider' and value in (None,'','openai-codex'):continue
        if key=='model' and value in (None,'',model):continue
        raise ValueError('cron_setting_unavailable')
    values={key:body[key] for key in ('name','prompt','schedule','deliver','repeat','nocheh_preferences') if key in body}
    if 'prompt' in values and (not isinstance(values['prompt'],str) or not values['prompt'].strip() or len(values['prompt'])>100000):raise ValueError('invalid_cron_prompt')
    if 'name' in values and (not isinstance(values['name'],str) or len(values['name'])>200):raise ValueError('invalid_cron_name')
    if 'schedule' in values and (not isinstance(values['schedule'],str) or len(values['schedule'])>256):raise ValueError('invalid_cron_schedule')
    if values.get('deliver','local') not in ('local','telegram'):raise ValueError('cron_delivery_denied')
    if 'repeat' in values and values['repeat'] is not None and (type(values['repeat']) is not int or not 1<=values['repeat']<=10000):raise ValueError('invalid_cron_repeat')
    if 'nocheh_preferences' in values:
        from .policy_config import validate
        validate(values['nocheh_preferences'])
    return values


def profiles(admin):
    for item in admin.profiles()['profiles']:
        name,home=admin.profile(item['name']);bound=admin.binding(name)
        logical=admin.preference_home(name,home)
        yield name,logical,bound


def annotate(job,home,selected):
    return {**job,'profile':selected,'profile_name':selected,'hermes_home':str(home),
        '_nocheh_revision':revision(job,home.name),'managed':bool(job.get('nocheh_registered')),
        'delivery_policy':'local' if job.get('deliver','local')=='local' else 'review_each_result'}


def manage(admin,path,method,query,body,headers,call=None):
    call=call or (lambda route,payload:archive(route,payload,admin.token))
    if path=='/api/cron/delivery-targets':return {'targets':[
        {'id':'local','name':'Local (save only)','home_target_set':True,'home_env_var':None},
        {'id':'telegram','name':'Telegram to this scope (review each result)','home_target_set':True,'home_env_var':None}]}
    if path=='/api/cron/blueprints':return {'blueprints':[]}
    match=re.fullmatch(r'/api/cron/jobs(?:/([a-zA-Z0-9_-]{1,128})(?:/(runs|pause|resume|trigger|catch-up|cancel))?)?',path)
    if not match:raise ValueError('cron_operation_unavailable')
    job_id,operation=match.groups();selected=query.get('profile',['default'])[0]
    if selected=='all' and method=='GET' and not job_id:
        return [annotate(job,home,name) for name,home,_ in profiles(admin) for job in inspect(home) if not job.get('nocheh_removed')]
    name,physical=admin.profile(selected);bound=admin.binding(name);home=admin.preference_home(name,physical)
    if bound.space!=bound.chat_id:raise ValueError('cron_topic_scope_unavailable')
    if operation=='runs' and method=='GET':
        result=call('runs',{'profile':home.name,'job_id':job_id})
        return {'runs':[{'id':row['native_session'],'source':'scheduler','title':row['state']+': '+(row.get('error_code') or 'scheduled run'),
            'started_at':datetime.fromisoformat(row['created_at'].replace('Z','+00:00')).timestamp(),'is_active':row['state']=='running',
            'message_count':0,'profile':name,'nocheh_event_id':row['event_id']} for row in result['runs'] if row.get('native_session') and row['payload']['profile']==name],'limit':100}
    jobs=inspect(home)
    if method=='GET':
        if not job_id:return [annotate(job,home,name) for job in jobs if not job.get('nocheh_removed')]
        job=next((job for job in jobs if job['id']==job_id and not job.get('nocheh_removed')),None)
        if not job:raise ValueError('cron_job_not_found')
        return annotate(job,home,name)
    from cron import jobs as native
    with store(home):
        jobs=inspect(home);job=next((job for job in jobs if job['id']==job_id and not job.get('nocheh_removed')),None)
        if job_id and not job:raise ValueError('cron_job_not_found')
        if operation in ('trigger','catch-up') and method=='POST':
            if not job.get('nocheh_registered'):raise ValueError('cron_definition_not_captured')
            if job.get('nocheh_pending') or job.get('nocheh_running'):raise ValueError('cron_already_pending')
            identity=body.get('request_id') or headers.get(b'idempotency-key',b'').decode()
            if not isinstance(identity,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}',identity):raise ValueError('cron_request_identity_required')
            if job.get('nocheh_last_request')==identity:return annotate(job,home,name)
            if operation=='catch-up' and not job.get('nocheh_missed'):raise ValueError('cron_no_missed_run')
            job=native.update_job(job_id,{'nocheh_pending':{'id':identity,'reason':'catch_up' if operation=='catch-up' else 'manual','at':datetime.now(timezone.utc).isoformat()},'nocheh_last_request':identity})
        elif operation=='cancel' and method=='POST':
            if event:=job.get('nocheh_running'):call('cancel',{'event_id':event})
            job=native.update_job(job_id,{'nocheh_pending':None})
        elif not job_id and method=='POST':
            values=fields(body,admin.model)
            if not values.get('prompt') or not values.get('schedule'):raise ValueError('cron_prompt_and_schedule_required')
            request_id=headers.get(b'idempotency-key',b'').decode() or uuid.uuid4().hex
            existing=next((j for j in jobs if j.get('nocheh_create_id')==request_id),None)
            if existing:return annotate(existing,home,name)
            preferences=values.pop('nocheh_preferences',{})
            job=native.create_job(**values,provider='openai-codex',model=admin.model)
            job=native.update_job(job['id'],{'prompt':values['prompt'],'nocheh_create_id':request_id,'nocheh_preferences':preferences,'nocheh_registered':False})
        elif method=='PUT' and not operation:
            changes=fields(body.get('updates',body),admin.model)
            expected=body.get('updates',body).get('_nocheh_revision')
            if expected!=revision(job,home.name):raise ValueError('configuration_conflict')
            job=native.update_job(job_id,{**changes,'nocheh_registered':False})
        elif operation in ('pause','resume') and method=='POST':
            job=native.update_job(job_id,{'enabled':operation=='resume','state':'scheduled' if operation=='resume' else 'paused','nocheh_registered':False})
        elif method=='DELETE' and not operation:
            if event:=job.get('nocheh_running'):call('cancel',{'event_id':event})
            job=native.update_job(job_id,{'enabled':False,'state':'paused','nocheh_removed':True,'nocheh_registered':False,'nocheh_pending':None})
        else:raise ValueError('cron_operation_unavailable')
        if not job.get('nocheh_registered'):
            # A failed archive write leaves the native definition intact but inert.
            # Resume retries capture; the scheduler never executes an uncaptured job.
            call('definition',{'scope':bound.chat_id,'profile':home.name,'job_id':job['id'],'definition':definition(job,home.name)})
            job=native.update_job(job['id'],{'nocheh_registered':True})
        return {'ok':True} if method=='DELETE' else annotate(job,home,name)
