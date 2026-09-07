"""Live native memory rehearsal without Telegram sends or real conversation data."""

from integrations.hermes.environment import secret as environment_secret
import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.request
from datetime import datetime,timezone
from pathlib import Path

from .assistant_gateway import native_turn
from .capture import canonical,digest
from .scopes import Scopes
from .subscription import resolve_credentials


async def main():
    secret=environment_secret('SERVICE_TOKEN')
    model=os.environ.get('NOCHEH_MODEL','gpt-5.6-sol')
    root=Path(os.environ['HERMES_HOME'])/'synthetic-assistant-rehearsal'
    scopes=Scopes({'enabled':True,'owner_id':'9000000000123','group_ids':['-9000000000020','-9000000000030']})
    def archive(event):
        request=urllib.request.Request(os.environ.get('ARCHIVE_URL','http://archive:8780')+'/v1/ingest',data=canonical(event),headers={'Authorization':'Bearer '+secret,'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=20) as response:return json.load(response)['id']
    async def turn(chat,label,prompt):
        update={'update_id':label,'message':{'message_id':label,'chat':{'id':chat,'type':'group'},'from':{'id':9000000000123,'is_bot':False},'text':prompt}}
        scope=scopes.resolve(update,str(chat));key='synthetic:assistant:'+str(chat)+':'+label
        event_id=archive({'version':1,'key':key,'origin':'import','kind':'telegram_update','bot_id':'synthetic-assistant','scope':str(chat),'source_id':label,'revision':'0','occurred_at':None,'text':prompt,'payload':update})
        body=base64.urlsafe_b64encode(canonical({'scope':str(chat),'event_id':event_id,'expires':time.time()*1000+600000,'audience':'nocheh-assistant'})).decode().rstrip('=')
        signature=base64.urlsafe_b64encode(hmac.new(secret.encode(),body.encode(),hashlib.sha256).digest()).decode().rstrip('=')
        request={'event_id':event_id,'source_key':key,'payload':update,'text':prompt,'archive_credential':'turn.'+body+'.'+signature,'transcripts':[]}
        return await native_turn(root,scope,request,model,resolve_credentials())
    checks=[]
    async def check(name,chat,prompt,predicate):
        start=time.monotonic()
        try:
            result=await turn(chat,name,prompt)
            passed=result.get('state')=='done' and predicate(result.get('text',''))
            row={'name':name,'status':'passed' if passed else 'failed','state':result.get('state'),'error_code':result.get('error_code'),'error_type':result.get('error_type')}
        except Exception as error:row={'name':name,'status':'failed','error_type':type(error).__name__}
        row['duration_ms']=round((time.monotonic()-start)*1000);checks.append(row);print(json.dumps(row),flush=True)
    await check('store',-9000000000020,'Use the native memory tool to remember our synthetic launch label: JUNIPER-FALCON-7642. Then reply exactly STORED.',lambda text:'STORED' in text)
    memory=root/'profiles'/Scopes.profile('-9000000000020')/'memories'
    stored=any(path.exists() and 'JUNIPER-FALCON-7642' in path.read_text() for path in (memory/'MEMORY.md',memory/'USER.md'))
    checks.append({'name':'native-memory-file','status':'passed' if stored else 'failed'})
    await check('recall',-9000000000020,'What is our saved synthetic launch label? Reply with only the label.',lambda text:text.strip()=='JUNIPER-FALCON-7642')
    await check('other-group',-9000000000030,'What is our saved synthetic launch label? If you have no record, reply exactly UNKNOWN.',lambda text:'JUNIPER-FALCON-7642' not in text and 'UNKNOWN' in text)
    report={'recorded_at':datetime.now(timezone.utc).isoformat(),'environment':'local-compose','synthetic_only':True,'telegram_messages_sent':0,'checks':checks,
            'note':'Native per-profile memory rehearsal; live Telegram, groups and approval delivery still require bot credentials.'}
    Path('/reports/assistant-memory.json').write_text(json.dumps(report,indent=2)+'\n')
    return 0 if all(row['status']=='passed' for row in checks) else 1


if __name__=='__main__':raise SystemExit(asyncio.run(main()))
