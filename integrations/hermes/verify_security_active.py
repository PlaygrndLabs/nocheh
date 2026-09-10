"""Verify active managed isolation with synthetic archive data; never send Telegram."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from datetime import datetime,timezone
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from .environment import secret as environment_secret
from .scopes import Scopes
from .turn_process import run_process
from .subscription import SubscriptionCredentials

async def main():
    secret=environment_secret('SERVICE_TOKEN');base=os.environ['ARCHIVE_URL'];owner=os.environ['TELEGRAM_OWNER_ID']
    checks=[];run=uuid.uuid4().hex
    report={'recorded_at':datetime.now(timezone.utc).isoformat(),'synthetic_only':True,'telegram_messages_sent':0,'checks':checks}
    def call(path,body=None,credential=secret,url=base):
        request=Request(url+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+credential,'Content-Type':'application/json'})
        with urlopen(request,timeout=120) as response:return json.load(response)
    def record(name,ok):checks.append({'name':name,'passed':bool(ok)});print(json.dumps(checks[-1]),flush=True)
    try:
        record('isolated_mode',os.environ.get('NOCHEH_SECURITY_RUNTIME')=='isolated')
        record('complete_memory_evidence',os.environ.get('NOCHEH_MEMORY_CONTEXT')=='evidence')
        if not all(check['passed'] for check in checks):raise ValueError('security_modes_inactive')
        expected='The synthetic security acceptance colour is ultramarine.'
        event=call('/v1/ingest',{'version':1,'key':'synthetic:security:'+run,'origin':'import','kind':'message','bot_id':'synthetic-security','scope':owner,'source_id':run,'revision':'1','occurred_at':None,'text':expected,'payload':{}})['id']
        call('/v1/guarded/prepare',{'event_id':event})
        deadline=time.monotonic()+120
        while True:
            projection=next(p for p in call('/v1/data/'+event+'/guarded')['projections'] if p['kind']=='events')
            if projection['state']=='ready':break
            if time.monotonic()>deadline:raise ValueError('synthetic_projection_pending')
            await asyncio.sleep(.5)
        report['detector_changed_synthetic_text']=projection['content']['text']!=expected
        # A synthetic owner edit verifies ADR-0033's exact-copy contract and
        # separates detector false positives from the new transport's behavior.
        call('/v1/data/'+event+'/guarded',{'source_id':'events:'+event,'expected_revision':projection['active_revision'],'content':{'text':expected,'payload':{}}})
        status=call('/v1/memory/honcho')
        claims={'scope':None,'event_id':event,'expires':int(time.time()*1000)+600000,'audience':'nocheh-assistant','guard_epoch':status['guard']['epoch'],'space':owner,'revision':status['policy']}
        encoded=base64.urlsafe_b64encode(json.dumps(claims,separators=(',',':')).encode()).decode().rstrip('=')
        signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),encoded.encode(),hashlib.sha256).digest()).decode().rstrip('=');credential='turn.'+encoded+'.'+signature
        record('saved_owner_copy_exact',call('/v1/events/'+event,credential=credential)['event']['text']==expected)
        runtime=call('/internal/browser-credentials',{'profile':Scopes.profile(owner),'scope':owner,'event_id':event,'archive_credential':credential},url='http://127.0.0.1:8781')
        binding=call('/v1/security/binding',credential=credential,url='http://security:8786')
        record('provider_context_preserved',binding['model_context_length']>0 and binding['model']==runtime['model'])
        report['model']=binding['model'];report['model_context_length']=binding['model_context_length']
        scope=Scopes({'enabled':True,'owner_id':owner,'group_ids':[]}).resolve({'message':{'chat':{'id':int(owner),'type':'private'},'from':{'id':int(owner)}}},owner)
        text='Read nocheh:event:'+event+' using the archive read tool. Reply with only the exact sentence from its text. This is a synthetic acceptance check; do not change memories or request external effects.'
        body={'channel':'browser','event_id':event,'text':text,'archive_credential':credential,'guard_mode':status['guard']['mode']}
        result=await run_process(Path(os.environ['HERMES_HOME']),scope,body,runtime['model'],SubscriptionCredentials(runtime['api_key'],runtime['base_url'],runtime['provider'],runtime['api_mode']),'security-acceptance-'+run)
        answer=result.get('text','').strip()
        report['existing_memory_limitation_notice']='\n\nMemory is limited;' in answer
        record('active_isolated_archive_recall',result.get('state')=='done' and answer.split('\n\nMemory is limited;',1)[0]==expected)
        if result.get('state')!='done':report['turn_error_code']=result.get('error_code')
        from hermes_state import SessionDB
        from .isolated_profile import database_path
        database=SessionDB(database_path(Path(os.environ['HERMES_HOME'])/'profiles'/binding['profile']),read_only=True)
        try:history=database.get_messages_as_conversation(result.get('session_id','security-acceptance-'+run))
        finally:database.close()
        record('native_history_persisted',any(message.get('role')=='user' and event in str(message.get('content')) for message in history)
               and any(message.get('role')=='assistant' and expected in str(message.get('content')) for message in history))
        events=[];cursor='0'
        while True:
            log=call('/v1/security/effects?after='+str(cursor));events.extend(entry for entry in log['events'] if entry.get('source_event_id')==event)
            if not log.get('next'):break
            cursor=log['next']
        record('active_provider_receipt',any(entry['kind']=='model.request' and entry['state']=='completed' for entry in events))
        record('routine_work_without_approval',not any(entry['state']=='awaiting_approval' for entry in events))
        report['source']=event
    except Exception as error:
        record('workflow_completed',False);report['error_type']=type(error).__name__
        if isinstance(error,HTTPError):report['http_status']=error.code
    report['status']='passed' if checks and all(check['passed'] for check in checks) else 'pending'
    Path('/reports/security-service-active.json').write_text(json.dumps(report,indent=2)+'\n')
    return 0 if report['status']=='passed' else 1

if __name__=='__main__':raise SystemExit(asyncio.run(main()))
