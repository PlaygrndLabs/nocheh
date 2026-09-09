"""Synthetic saved-copy acceptance with the real subscription runtime; no Telegram sends."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime,timezone
from .environment import secret as environment_secret
from .scopes import Scopes
from .turn_process import run_process
from types import SimpleNamespace

async def main():
    secret=environment_secret('SERVICE_TOKEN');base=os.environ.get('ARCHIVE_URL','http://archive:8780')
    def call(path,body=None,credential=secret):
        request=urllib.request.Request(base+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),headers={'Authorization':'Bearer '+credential,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request,timeout=240) as response:return json.load(response)
        except urllib.error.HTTPError as error:
            try:code=json.loads(error.read(4096)).get('error','request_rejected')
            except Exception:code='request_rejected'
            raise RuntimeError(str(error.code)+':'+str(code)) from None
    checks=[];run=uuid.uuid4().hex
    def record(name,ok):checks.append({'name':name,'status':'passed' if ok else 'failed'});print(json.dumps(checks[-1]),flush=True)
    original='Database password: mango123';edited='Database credentials are in my password manager.'
    scope_id=os.environ['TELEGRAM_OWNER_ID']
    def capture(label,text):return call('/v1/ingest',{'version':1,'key':'synthetic:guarded:'+run+':'+label,'origin':'import','kind':'message','bot_id':'synthetic-guarded','scope':scope_id,'source_id':label,'revision':'1','occurred_at':None,'text':text,'payload':{}})['id']
    try:
        source=capture('source',original)
        record('original_capture',True)
        selected=call('/v1/guarded/prepare',{'event_id':source})['projections']
        projection=next(p for p in selected if p['kind']=='events')
        deadline=time.monotonic()+120
        while projection['state']=='pending' and time.monotonic()<deadline:
            await asyncio.sleep(2)
            projection=next(p for p in call('/v1/data/'+source+'/guarded')['projections'] if p['kind']=='events')
        record('import_prepared',projection['state']=='ready' and projection['content']['text']=='Database password: ***')
        call('/v1/data/'+source+'/guarded',{'source_id':'events:'+source,'expected_revision':projection['active_revision'],'content':{'text':edited,'payload':{}}})
        record('original_unchanged',call('/v1/events/'+source)['event']['text']==original)
        question='Use nocheh_archive_read to read nocheh:event:'+source+'. Reply with the exact sentence in its text, without commentary.'
        event=capture('question',question);call('/v1/guarded/prepare',{'event_id':event})
        status=call('/v1/memory/honcho');epoch=status['guard']['epoch'];revision=status['policy']
        claims={'scope':None,'event_id':event,'expires':int(time.time()*1000)+600000,'audience':'nocheh-assistant','guard_epoch':epoch,'space':scope_id,'revision':revision}
        payload=base64.urlsafe_b64encode(json.dumps(claims,separators=(',',':')).encode()).decode().rstrip('=')
        signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),payload.encode(),hashlib.sha256).digest()).decode().rstrip('=');credential='turn.'+payload+'.'+signature
        selected=call('/v1/events/'+source,credential=credential)
        record('scoped_owner_wording_exact',selected['event']['text']==edited)
        for _ in range(2):
            value=call('/v1/context/prepare',{'text':selected['event']['text']},credential)
            if value['text']!=edited:raise ValueError('prepared_reuse_changed')
        record('saved_copy_reused',True)
        scopes=Scopes({'enabled':True,'owner_id':scope_id,'group_ids':[]})
        scope=scopes.resolve({'message':{'chat':{'id':int(scope_id),'type':'private'},'from':{'id':int(scope_id)}}},scope_id)
        root=Path(os.environ['HERMES_HOME'])/'synthetic-guarded-rehearsal'
        body={'channel':'browser','event_id':event,'text':question,'archive_credential':credential,'guard_mode':'on'}
        start=time.monotonic()
        credentials_request=urllib.request.Request('http://127.0.0.1:8781/internal/browser-credentials',data=json.dumps({'profile':Scopes.profile(scope_id),'scope':scope_id,'event_id':event,'archive_credential':credential}).encode(),headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json'})
        with urllib.request.urlopen(credentials_request,timeout=30) as response:credentials=json.load(response)
        result=await run_process(root,scope,body,credentials['model'],SimpleNamespace(access_token=credentials['access_token']),'guarded-'+run)
        record('native_archive_recall',result.get('state')=='done' and edited in result.get('text','') and 'mango123' not in result.get('text',''))
        checks[-1]['duration_ms']=round((time.monotonic()-start)*1000)
        if result.get('state')!='done':checks[-1]['error_code']=result.get('error_code')
    except Exception as error:checks.append({'name':'workflow','status':'failed','error_type':type(error).__name__,'error_code':str(error) if isinstance(error,RuntimeError) else None});print(json.dumps(checks[-1]),flush=True)
    report={'recorded_at':datetime.now(timezone.utc).isoformat(),'environment':'local-compose','synthetic_only':True,'telegram_messages_sent':0,'checks':checks,
            'honcho_live':'pending','note':'Subscription archive recall; Honcho ingestion/embeddings are separate live gates. Fixture imports do not grant learning consent.'}
    Path('/reports/guarded-copies.json').write_text(json.dumps(report,indent=2)+'\n')
    return 0 if checks and all(c['status']=='passed' for c in checks) else 1
if __name__=='__main__':raise SystemExit(asyncio.run(main()))
