"""Real, synthetic-only Honcho gates. Missing credentials are pending, never passes."""
import json
import subprocess
import time
import uuid
from datetime import datetime,timezone
from .control import STATE,ROOT,COMPOSE
from .compare import request

NAMES=('subscription_reasoning','ingestion','retrieval','embedding_guarded','restart','provider_failure')

def main():
    report={'format':'nocheh-honcho-live-v1','recorded_at':datetime.now(timezone.utc).isoformat(),'status':'incomplete','synthetic_only':True,'checks':{name:'pending' for name in NAMES}}
    path=STATE/'reports/live-memory.json'
    def save():path.write_text(json.dumps(report,indent=2)+'\n')
    def checked(name,fn):
        try:fn();report['checks'][name]='passed'
        except Exception as error:report['checks'][name]='failed';report.setdefault('errors',{})[name]=type(error).__name__
        save();print(json.dumps({'check':name,'status':report['checks'][name]}),flush=True)
        return report['checks'][name]=='passed'
    if not (STATE/'temporary_embedding_key').read_text().strip() or not list((STATE/'bridge-auth').glob('*.json')):
        report['status']='credentials_pending';save();print('Dedicated embeddings credential and separate bridge login are required.');return 2
    subprocess.run(COMPOSE+['up','-d','--no-build','--wait','--wait-timeout','180'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
    subprocess.run(COMPOSE+['up','-d','--no-build','--force-recreate','--wait','meter'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
    model={'model':'gpt-5.6-sol','messages':[{'role':'user','content':'Reply exactly HONCHO_PROXY_OK.'}],'max_completion_tokens':256}
    def reasoning():
        text=request('meter','/v1/chat/completions',model)['choices'][0]['message']['content']
        if 'HONCHO_PROXY_OK' not in text:raise ValueError('subscription_contract')
    if not checked('subscription_reasoning',reasoning):return 1
    workspace='acceptance'+uuid.uuid4().hex;base='/v3/workspaces/'+workspace
    text='My preferred drink is oolong tea. Database credentials are in my password manager.'
    ledger_before=request('meter','/ledger');before=len(ledger_before['calls'])
    def ingestion():
        request('honcho','/v3/workspaces',{'id':workspace});request('honcho',base+'/peers',{'id':'source'})
        request('honcho',base+'/sessions',{'id':'source','peers':{'source':{'observe_me':True,'observe_others':False}}})
        result=request('honcho',base+'/sessions/source/messages',{'messages':[{'peer_id':'source','content':text,'metadata':{'guarded_revision':2,'synthetic':True}}]})
        if len(result)!=1 or result[0]['content']!=text:raise ValueError('message_contract')
        deadline=time.monotonic()+300
        while time.monotonic()<deadline:
            queue=request('honcho',base+'/queue/status')
            if queue['completed_work_units']>0 and queue['pending_work_units']+queue['in_progress_work_units']==0:return
            time.sleep(2)
        raise TimeoutError('derivation_pending')
    if not checked('ingestion',ingestion):return 1
    def recall():
        value=request('honcho',base+'/peers/source/chat',{'query':'What drink do I prefer and where are the database credentials?','reasoning_level':'low','stream':False})['content']
        if 'oolong' not in value.lower() or 'password manager' not in value.lower():raise ValueError('recall_contract')
    checked('retrieval',recall)
    def embeddings():
        calls=request('meter','/ledger')['calls'][before:]
        embeddings=[c for c in calls if c['route']=='/v1/embeddings' and c['status']==200]
        if not embeddings:raise ValueError('embedding_evidence_missing')
        audits=[json.loads(c.get('audit') or '{}') for c in embeddings]
        if not any(a.get('owner_wording') for a in audits) or any(a.get('synthetic_raw_canary') for a in audits):raise ValueError('guarded_embedding_evidence_missing')
    checked('embedding_guarded',embeddings)
    def restart():
        subprocess.run(COMPOSE+['restart','honcho','deriver'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
        subprocess.run(COMPOSE+['up','-d','--no-build','--wait','--wait-timeout','180'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
        rows=request('honcho',base+'/sessions/source/messages/list',{})['items']
        if len(rows)!=1 or rows[0]['content']!=text:raise ValueError('restart_source_changed')
        recall()
    checked('restart',restart)
    def failure():
        subprocess.run(COMPOSE+['stop','bridge'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
        failed=False
        try:
            try:request('meter','/v1/chat/completions',model)
            except Exception:failed=True
            if not failed:raise ValueError('failure_not_observed')
        finally:subprocess.run(COMPOSE+['up','-d','--no-build','bridge'],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
        reasoning()
    checked('provider_failure',failure)
    report['status']='passed' if all(v=='passed' for v in report['checks'].values()) else 'incomplete';report['ledger']=request('meter','/ledger');save()
    return 0 if report['status']=='passed' else 1
