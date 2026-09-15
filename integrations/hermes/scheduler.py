"""One supervised scheduler over native jobs; every fire is captured before execution."""
import fcntl
import json
import threading
import uuid
from datetime import datetime,timezone,timedelta
from pathlib import Path
from .capture import canonical,digest
from .native_cron import archive,store,inspect,profiles,definition,revision,workflow_cursor,sync_job
from .native_memory import save_receipt


def now():return datetime.now(timezone.utc)
def date(value):return datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone.utc)


class Scheduler:
    def __init__(self,admin,credentials,call=None,runner=None):
        self.admin,self.credentials=admin,credentials
        self.root=Path(admin.root);self.actor=uuid.uuid4().hex
        self.call=call or (lambda route,body:archive(route,body,admin.token))
        self.stopping=threading.Event();self.thread=None;self.status='starting'
        self.receipts=self.root/'nocheh-scheduler-receipts'
        self.managed_flush=lambda:None

    def publish(self,receipt):
        outcome=self.call('finish',receipt['finish'])
        delivery=self.call('delivery',{'event_id':receipt['finish']['event_id']})
        home=self.root/'profiles'/receipt['logical_profile']
        from cron import jobs as native
        with store(home):
            job=next((j for j in inspect(home) if j['id']==receipt['job_id']),None)
            if job and job.get('nocheh_running')==receipt['finish']['event_id']:
                native.update_job(job['id'],{'nocheh_running':None,'last_run_at':receipt['at'],
                    'last_status':'success' if outcome['state']=='done' else 'error',
                    'last_error':None if outcome['state']=='done' else receipt['finish'].get('error_code') or outcome['state'],
                    'last_delivery_error':delivery.get('reason'),'nocheh_delivery':delivery,'nocheh_workflow_synced':False})
        return outcome

    def flush(self):
        self.receipts.mkdir(parents=True,exist_ok=True,mode=0o700)
        for path in sorted(self.receipts.glob('*.json')):
            receipt=json.loads(path.read_text())
            if path.name!=receipt['finish']['event_id']+'.json':raise ValueError('scheduler_receipt_invalid')
            self.publish(receipt);path.unlink()

    def recover(self):
        self.flush();self.call('recover',{})

    def _advance(self,target,expected,epoch,at=None):
        at=at or now();self.flush()
        ownership=self.call('ownership',{})
        if not ownership.get('admission',True):return {'state':'waiting','next_attempt':int((at+timedelta(seconds=30)).timestamp()*1000)}
        if not target or not isinstance(epoch,int) or ownership.get('owner')!='inngest' or ownership.get('epoch')!=epoch:raise ValueError('workflow_owner_changed')
        from cron import jobs as native
        for name,home,bound in profiles(self.admin):
            if target and home.name!=target[0]:continue
            if not (home/'cron/jobs.json').exists():continue
            with store(home):
                for job in inspect(home):
                    if target and job['id']!=target[1]:continue
                    if self.stopping.is_set():return
                    if expected and expected!=workflow_cursor(job,home.name):return {'state':'skipped'}
                    if not job.get('nocheh_registered'):
                        if target:return {'state':'waiting','next_attempt':int((at+timedelta(seconds=30)).timestamp()*1000)}
                        continue
                    if job.get('nocheh_removed'):
                        if target:return {'state':'completed'}
                        continue
                    pending=job.get('nocheh_pending')
                    due=job.get('next_run_at')
                    if not pending and (not job.get('enabled',True) or not due or date(due)>at):
                        if target:return {'state':'waiting','next_attempt':int(date(due).timestamp()*1000)} if job.get('enabled',True) and due else {'state':'completed'}
                        continue
                    scheduled_for=pending['at'] if pending else due
                    reason=pending['reason'] if pending else 'scheduled'
                    if job.get('nocheh_running'):reason='overlap'
                    elif not pending and (at-date(due)).total_seconds()>60:reason='missed'
                    request_id=pending['id'] if pending else due
                    fire=digest(canonical({'profile':home.name,'job':job['id'],'request':request_id,'type':'manual' if pending else 'scheduled'}))
                    snapshot=definition(job,home.name)
                    captured=self.call('input',{'id':fire,'conversation':job['id'],'scope':bound.chat_id,'profile':bound.profile,
                        'space':bound.space,'revision':bound.revision,'text':job['prompt'],'files':[],
                        'job_id':job['id'],'job_revision':revision(job,home.name),'scheduled_for':scheduled_for,
                        'fire_reason':reason,'definition':snapshot,'owner_epoch':epoch})
                    reason=captured.get('fire_reason',reason)
                    updates={'nocheh_pending':None,'nocheh_workflow_synced':False}
                    if not pending:
                        if reason=='missed' and job['schedule']['kind']=='interval':
                            seconds=job['schedule']['minutes']*60
                            slots=int((at-date(due)).total_seconds()//seconds)+1
                            next_run=(date(due)+timedelta(seconds=seconds*slots)).isoformat()
                        else:next_run=native.compute_next_run(job['schedule'],at.isoformat() if reason=='missed' else due)
                        if job['schedule']['kind']=='once':next_run=None
                        completed=(job.get('repeat') or {}).get('completed',0)+1
                        times=(job.get('repeat') or {}).get('times')
                        updates.update(next_run_at=next_run,repeat={'completed':completed,'times':times})
                        if not next_run or times is not None and completed>=times:updates.update(enabled=False,state='completed',next_run_at=None)
                    if reason in ('missed','overlap'):
                        updates.update(nocheh_missed={'from':scheduled_for,'until':at.isoformat(),'reason':reason},last_status='skipped',last_error='scheduled_'+reason)
                        saved=native.update_job(job['id'],updates)
                        if target:sync_job(self.call,saved,home,bound);return {'state':'completed'}
                        continue
                    # Schedule advancement follows durable capture, before execution.
                    # Retrying the same fire can only return its previous claim.
                    updates['nocheh_running']=captured['event_id']
                    if reason=='catch_up':updates['nocheh_missed']=None
                    saved=native.update_job(job['id'],updates)
                    sync_job(self.call,saved,home,bound);return {'state':'completed'}
        if target:return {'state':'skipped'}

    def advance(self,body):
        if (self.root/'scheduler-inactive').exists():return {'state':'waiting','next_attempt':int((now()+timedelta(seconds=30)).timestamp()*1000)}
        return self._advance(target=(body['logical_profile'],body['job_id']),expected=body['cursor'],epoch=body['owner_epoch'])

    def sync(self):
        from cron import jobs as native
        for _,home,bound in profiles(self.admin):
            if not (home/'cron/jobs.json').exists():continue
            with store(home):
                for job in inspect(home):
                    if job.get('nocheh_workflow_synced'):continue
                    if not job.get('nocheh_definition_version'):job=native.update_job(job['id'],{'nocheh_definition_version':uuid.uuid4().hex})
                    sync_job(self.call,job,home,bound)

    def context(self,body,claim=False):
        if (self.root/'scheduler-inactive').exists():return {'state':'waiting'}
        context=self.call('workflow-context',body)
        for _,home,bound in profiles(self.admin):
            if home.name!=context['logical_profile']:continue
            with store(home):
                job=next((job for job in inspect(home) if job['id']==context['job_id']),None)
                if not job or job.get('nocheh_removed') or bound.profile!=context['profile'] or job.get('nocheh_definition_version')!=context['definition'].get('execution_version'):
                    self.call('cancel',{'event_id':context['event_id']});return {'state':'cancelled'}
                if job.get('nocheh_running')!=context['event_id']:return {'state':'waiting'}
                return {'state':'ready','context':context,'scope':bound,**({'claim':self.call('claim',context)} if claim else {})}
        self.call('cancel',{'event_id':context['event_id']});return {'state':'cancelled'}

    def serve(self):
        with (self.root/'.nocheh-scheduler.lock').open('a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:self.status='already_supervised';return
            recovered=False
            while not self.stopping.is_set():
                if (self.root/'scheduler-inactive').exists():self.status='inactive_restore'
                else:
                    try:
                        if not recovered:self.recover();recovered=True
                        self.managed_flush();self.sync()
                        self.flush();self.status='workflow_owned'
                    except Exception:self.status='waiting_for_archive'
                save_receipt(self.root/'scheduler-status.json',json.dumps({'state':self.status,'actor':self.actor,'at':now().isoformat()}))
                self.stopping.wait(2)
            self.status='stopped'

    def start(self):
        self.thread=threading.Thread(target=self.serve,daemon=True);self.thread.start()

    def stop(self):
        self.stopping.set()
        if self.thread:self.thread.join(timeout=45)
