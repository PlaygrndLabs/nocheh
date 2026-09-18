"""Exercise both storage layouts and native receipt wire formats on isolated PG."""
import argparse
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from integrations.hermes.capture import Capture
from scripts import reset_effects
from scripts.store_recovery import StoreRecovery

BOOTSTRAP = r'''
import pg from 'pg';
import {initialize} from './dist/src/database.js';
import {digest,ingest} from './dist/src/archive.js';
import {initializeStoreDatabases,connectStores} from './dist/src/stores/connections.js';
import {ArchiveRepository} from './dist/src/stores/archive.js';
const config={host:'nocheh-postgres',user:'nocheh',database:'nocheh',password:'synthetic-reset-effects-only'};
const legacy=new pg.Pool(config);
if((await legacy.query("SELECT current_setting('cluster_name') AS name")).rows[0].name!=='nocheh-reset-effects-fixture')throw Error('wrong_cluster');
await initialize(legacy);
const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
await initializeStoreDatabases(config,passwords);
const stores=connectStores(config,passwords);
const event={version:1,key:'telegram:123:update:1',bot_id:'123',origin:'live',scope:'123',source_id:'1',revision:'0',kind:'telegram_update',occurred_at:null,text:'Synthetic source',payload:{update_id:1,message:{message_id:1,chat:{id:123},text:'Synthetic source'}}};
const id=digest(event.key),captured=await new ArchiveRepository(stores.archive).capture(event);
await ingest(legacy,event,false);
await legacy.query("INSERT INTO dispatches(event_id,state,attempts) VALUES($1,'ambiguous',1) ON CONFLICT(event_id) DO UPDATE SET state='ambiguous',attempts=1",[id]);
await stores.control.query("INSERT INTO dispatches(event_id,source_reference,state,attempts) VALUES($1,$2,'ambiguous',1)",[id,captured.source.reference]);
for(const db of [legacy,stores.control]) {
 await db.query("INSERT INTO workflow_registry(id,family,job_id,version,generation,state) VALUES($1,'telegram',$2,1,1,'ambiguous')",['d'.repeat(64),id]);
 await db.query("INSERT INTO workflow_receipts(workflow_id,step,attempt,state) VALUES($1,'send',1,'ambiguous')",['d'.repeat(64)]);
}
await stores.close();await legacy.end();
'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--management-image',required=True)
    args=parser.parse_args();directory=args.directory.resolve();directory.mkdir(mode=0o700)
    project='nocheh-reset-effects-'+uuid.uuid4().hex[:12]
    compose={'name':project,'services':{
        'nocheh-postgres':{'image':'postgres:17-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0',
            'command':['postgres','-c','cluster_name=nocheh-reset-effects-fixture'],
            'environment':{'POSTGRES_USER':'nocheh','POSTGRES_DB':'nocheh','POSTGRES_PASSWORD':'synthetic-reset-effects-only'},
            'volumes':['fixture:/var/lib/postgresql/data'],
            'healthcheck':{'test':['CMD-SHELL','pg_isready -U nocheh -d nocheh'],'interval':'2s','retries':30}},
        'checks':{'image':args.management_image,'entrypoint':['node','--input-type=module','-e',BOOTSTRAP],
            'profiles':['checks'],'depends_on':{'nocheh-postgres':{'condition':'service_healthy'}}}},
        'volumes':{'fixture':{}},'networks':{'default':{'internal':True}}}
    file=directory/'compose.json';file.write_text(json.dumps(compose));command=['docker','compose','-p',project,'-f',str(file)]
    environment=dict(os.environ);recovery=StoreRecovery(command,environment)
    try:
        subprocess.run(command+['up','-d','--no-build','--wait','nocheh-postgres'],check=True)
        subprocess.run(command+['run','--rm','--no-deps','checks'],check=True)
        checks=[]
        with recovery.maintenance():
            assert recovery.query(None,"SELECT current_setting('cluster_name')").strip()=='nocheh-reset-effects-fixture'
            for layout in ('legacy','original-only-v1'):
                state=directory/layout;state.mkdir();observed=reset_effects.snapshot(recovery.query,layout)
                assert len(observed['dispatches'])==1 and len(observed['workflows'])==1
                result=reset_effects.evaluate(state,observed)
                assert result['settled'] and result['results'][0]['outcome']=='stopped_without_delivery_attempt'
                capture=Capture(state/'spool','123');parameters={'chat_id':123,'text':'Synthetic private receipt — سلام'}
                key,_=capture.outbound('sendMessage',parameters,'telegram:123:update:1')
                unresolved=reset_effects.evaluate(state,observed)
                assert not unresolved['settled'] and unresolved['blockers'][0]['reason']=='external_outcome_unconfirmed'
                capture.complete(key,'sendMessage',parameters,(200,b'{"ok":true,"result":{"message_id":2}}'))
                confirmed=reset_effects.evaluate(state,observed)
                assert confirmed['settled'] and confirmed['results'][0]['outcome']=='delivery_receipts_reconciled'
                assert reset_effects.snapshot(recovery.query,layout)==observed,'inspection must not rewrite ambiguous database receipts'
                assert 'Synthetic private receipt' not in json.dumps(confirmed)
                recovery.assert_maintenance();checks.append({'layout':layout,'passed':True})
        report={'passed':True,'project':project,'checks':checks,'native_transport':'real capture journal with synthetic responses',
            'network':'internal only','provider_calls':0,'live_state_changed':False,
            'limitations':['Snapshot/evidence integration only; complete shutdown and reset orchestration are separate gates.']}
        (directory/'result.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
    finally:
        subprocess.run(command+['down','--volumes'],check=True)


if __name__=='__main__':main()
