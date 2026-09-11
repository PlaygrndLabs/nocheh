"""One supervised scheduler over native jobs; every fire is captured before execution."""
import asyncio
import fcntl
import json
import threading
import uuid
from datetime import datetime,timezone,timedelta
from pathlib import Path
from .capture import canonical,digest,immutable_file
from .native_cron import archive,store,inspect,profiles,definition,revision,workflow_cursor,sync_job
from .native_memory import save_receipt


def now():return datetime.now(timezone.utc)
def date(value):return datetime.fromisoformat(value.replace('Z','+00:00')).astimezone(timezone.utc)


class Scheduler:
    def __init__(self,admin,credentials,call=None,runner=None):
        self.admin,self.credentials=admin,credentials
        self.root=Path(admin.root);self.actor=uuid.uuid4().hex
        self.call=call or (lambda route,body:archive(route,body,admin.token))
        if runner is None:
            from .turn_process import run_process
            runner=run_process
        self.runner=runner;self.stopping=threading.Event();self.active={};self.thread=None;self.status='starting'
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
        if self.call('ownership',{}).get('owner')=='inngest':return
        from cron import jobs as native
        for _,home,_ in profiles(self.admin):
            if not (home/'cron/jobs.json').exists():continue
            with store(home):
                for job in inspect(home):
                    if job.get('nocheh_running'):
                        native.update_job(job['id'],{'nocheh_running':None,'last_status':'error','last_error':'scheduler_restarted'})

    def tick(self,at=None,target=None,expected=None,epoch=None):
        at=at or now();self.flush()
        ownership=self.call('ownership',{})
        if not ownership.get('admission',True):return {'state':'waiting','next_attempt':int((at+timedelta(seconds=30)).timestamp()*1000)}
        owner=ownership.get('owner','legacy')
        if epoch is not None and (owner!='inngest' or ownership.get('epoch')!=epoch):raise ValueError('workflow_owner_changed')
        if epoch is None and owner!='legacy':return
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
                    if job.get('nocheh_running') or bound.profile in self.active or len(self.active)>=4:reason='overlap'
                    elif not pending and (at-date(due)).total_seconds()>60:reason='missed'
                    request_id=pending['id'] if pending else due
                    fire=digest(canonical({'profile':home.name,'job':job['id'],'request':request_id,'type':'manual' if pending else 'scheduled'}))
                    snapshot=definition(job,home.name)
                    captured=self.call('input',{'id':fire,'conversation':job['id'],'scope':bound.chat_id,'profile':bound.profile,
                        'space':bound.space,'revision':bound.revision,'text':job['prompt'],'files':[],
                        'job_id':job['id'],'job_revision':revision(job,home.name),'scheduled_for':scheduled_for,
                        'fire_reason':reason,'definition':snapshot,**({'owner_epoch':epoch} if epoch is not None else {})})
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
                    if epoch is not None:
                        sync_job(self.call,saved,home,bound);return {'state':'completed'}
                    try:claim=self.call('claim',{'event_id':captured['event_id'],'actor':self.actor,'scope':bound.chat_id,'profile':bound.profile})
                    except Exception:
                        # No child has started. Retire this uncertain claim; never
                        # retry its model turn or leave the job permanently blocked.
                        native.update_job(job['id'],{'nocheh_running':None,'last_status':'error','last_error':'claim_unconfirmed'})
                        try:self.call('cancel',{'event_id':captured['event_id']})
                        except Exception:pass  # The archive lease will expire.
                        continue
                    if not claim.get('claimed'):
                        native.update_job(job['id'],{'nocheh_running':None,'last_status':'error','last_error':'previous_fire_'+claim['state']});continue
                    cancelled=threading.Event()
                    thread=threading.Thread(target=self.execute,args=(home,bound,job,claim,cancelled),daemon=True)
                    self.active[bound.profile]=(thread,cancelled);thread.start()
        if target:return {'state':'skipped'}

    def advance(self,body):
        if (self.root/'scheduler-inactive').exists():return {'state':'waiting','next_attempt':int((now()+timedelta(seconds=30)).timestamp()*1000)}
        return self.tick(target=(body['logical_profile'],body['job_id']),expected=body['cursor'],epoch=body['owner_epoch'])

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

    def execute(self,home,bound,job,claim,cancelled):
        event=claim['event_id'];session='cron_'+job['id']+'_'+event[:24]
        stopped=threading.Event();lost=threading.Event()
        def heartbeat():
            while not stopped.wait(5):
                try:
                    status=self.call('heartbeat',{'event_id':event,'actor':self.actor})
                    if status.get('cancel_requested'):cancelled.set()
                except Exception:lost.set();cancelled.set();return
        monitor=threading.Thread(target=heartbeat,daemon=True);monitor.start()
        result={'state':'failed','text':'','session_id':session,'error_code':'scheduled_run_failed'}
        try:
            from .scopes import verify_capability
            verify_capability(claim['archive_credential'],self.admin.token,bound,event)
            credentials=self.credentials()
            body={**claim,'channel':'scheduler','job_id':job['id'],'job_preferences':job.get('nocheh_preferences',{})}
            result=asyncio.run(self.runner(self.root,bound,body,self.admin.model,credentials,session,cancelled=cancelled))
        except Exception as error:
            code=str(error) if str(error) in ('profile_busy','quota_paused','subscription_unavailable','browser_audience_changed','space_policy_changed') else 'scheduled_run_failed'
            result.update(error_code=code)
        finally:
            stopped.set();monitor.join(timeout=1)
            state='interrupted' if lost.is_set() else 'cancelled' if cancelled.is_set() else result['state']
            receipt={'logical_profile':home.name,'job_id':job['id'],'scope':bound.chat_id,'deliver':job.get('deliver','local'),
                'at':now().isoformat(),
                'finish':{'event_id':event,'actor':self.actor,'session':result.get('session_id',session),'state':state,
                    'text':result.get('text',''),'error_code':result.get('error_code')}}
            try:
                self.receipts.mkdir(parents=True,exist_ok=True,mode=0o700)
                immutable_file(self.receipts,event+'.json',canonical(receipt))
                self.publish(receipt);(self.receipts/(event+'.json')).unlink(missing_ok=True)
            except Exception:pass  # Receipt is durable; external execution is never repeated.
            self.active.pop(bound.profile,None)

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
                        ownership=self.call('ownership',{})
                        self.managed_flush();self.sync()
                        if ownership.get('owner')=='inngest':self.flush();self.status='workflow_owned'
                        else:self.tick();self.status='ready'
                    except Exception:self.status='waiting_for_archive'
                save_receipt(self.root/'scheduler-status.json',json.dumps({'state':self.status,'actor':self.actor,'at':now().isoformat(),'active':len(self.active)}))
                self.stopping.wait(2)
            for _,cancelled in list(self.active.values()):cancelled.set()
            for thread,_ in list(self.active.values()):thread.join(timeout=30)
            self.status='stopped'

    def start(self):
        self.thread=threading.Thread(target=self.serve,daemon=True);self.thread.start()

    def stop(self):
        self.stopping.set()
        if self.thread:self.thread.join(timeout=45)
