import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {reader} from '../src/access.js';
import {HttpError,json} from '../src/http.js';
import {storeSchemas} from '../src/stores/schema.js';
import {connectStores,initializeStoreDatabases,storeNames} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import {OwnerStorageApi} from '../src/stores/owner-api.js';

test('portable bundle transfers exact sources, two engine versions, durable owner edits, and inactive native history through owner HTTP APIs',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const namespaces=['bundle_source_','bundle_target_'].map(prefix=>prefix+randomUUID().replaceAll('-',''));
  for(const schema of namespaces)for(const name of storeNames){
    const db=new pg.Client({...config,database:'nocheh_'+name});await db.connect();try{
      await db.query(`CREATE SCHEMA ${schema} AUTHORIZATION nocheh_${name}_owner; SET search_path=${schema},pg_catalog; SET ROLE nocheh_${name}_owner`);
      await db.query(storeSchemas[name]);if(name==='control')await db.query('INSERT INTO installation(singleton,generation) VALUES(true,$1)',[randomUUID()]);
      await db.query(`GRANT USAGE ON SCHEMA ${schema} TO nocheh_${name}; GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA ${schema} TO nocheh_${name}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO nocheh_${name}`);
      if(name==='archive')await db.query('GRANT UPDATE(file_hash,byte_size) ON artifacts TO nocheh_archive');
      else if(name==='derived')await db.query('GRANT UPDATE(active_revision,state) ON guard_sources TO nocheh_derived; GRANT UPDATE(active_revision,imported) ON derivative_selections,learned_entries TO nocheh_derived');
      else await db.query(`GRANT UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO nocheh_control`);
    }finally{await db.end();}
  }
  const connections=namespaces.map(schema=>connectStores({...config,options:'-c search_path='+schema+',pg_catalog'},passwords));
  const root=await mkdtemp(join(tmpdir(),'nocheh-bundle-')),token=digest(root),owner={admin:true,scope:null};
  const services=connections.map((stores,i)=>storageServices(stores,{dataDir:join(root,String(i)),detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[]}),runtime:async()=>({literals:[]}),honcho:async()=>{throw Error('no providers');}}));
  const servers=services.map(s=>{const api=new OwnerStorageApi(s);return createServer((req,res)=>{void(async()=>{
    if(!await api.handle(reader(req,token),req,res,new URL(req.url!,'http://fixture')))throw new HttpError(404,'not_found');
  })().catch(error=>json(res,error instanceof HttpError?error.status:503,{error:error instanceof HttpError?error.code:'service_unavailable'}));});});
  const ports=[];for(const server of servers){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');ports.push(address.port);}
  const [source,target]=services;
  try{
    const event:Envelope={version:1,key:root,origin:'live',bot_id:'fixture',kind:'telegram_update',scope:'123',source_id:'1',revision:'1',occurred_at:null,text:'Original evidence \r\n متن',payload:{message:{message_id:1,chat:{id:123,type:'private'},voice:{file_id:root}}}};
    const original=(await source!.capture.capture(event)).source,bytes=Buffer.from([79,103,103,0,255]),file=await source!.attachments.commit(original.artifact_ids[0]!,bytes);
    await source!.guards.prepare(original.reference,'fixture',async()=>[]);
    const outputs=[];
    for(const version of ['one','two']){
      const output=await source!.derived.record({operation_id:root+version,source:original.reference,file,kind:'transcript',content:Buffer.from('Engine '+version),producer:'fixture',producer_version:version,configuration:{}});
      await source!.guards.prepare(output,'fixture',async()=>[]);outputs.push(output);
    }
    await source!.guards.edit('derived_artifacts:'+outputs[0]!.id,1,{text:'Durable owner correction',kind:'transcript',provenance:{}},root+':edit');
    await source!.selections.activate(outputs[0]!,null,root+':first');await source!.selections.activate(outputs[1]!,1,root+':second');
    const script=`import json,os,sqlite3,urllib.request
from pathlib import Path
from scripts.portable import export_all,import_all,validate_package
root=Path(os.environ['BUNDLE_ROOT']);home=root/'source/hermes/profiles'/('nocheh-'+'a'*24);(home/'memories').mkdir(parents=True)
(home/'.memory.lock').touch();(home/'memories/USER.md').write_bytes(b'Exact native owner note\\r\\n')
db=sqlite3.connect(home/'state.db');db.execute('CREATE TABLE messages(text text)');db.execute("INSERT INTO messages VALUES('Native history')");db.commit();db.close()
class API:
 storage_layout='original-only-v1'
 def __init__(self,port):self.url='http://127.0.0.1:'+port
 def call(self,path,body=None,binary=False):
  request=urllib.request.Request(self.url+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+os.environ['BUNDLE_TOKEN']})
  with urllib.request.urlopen(request,timeout=60) as response:return response.read() if binary else json.load(response)
manifest=export_all(root/'source',root/'package',API(os.environ['BUNDLE_SOURCE']),honcho_export=lambda *_:{'included':False,'reason':'not_configured'})
assert manifest==validate_package(root/'package')
result=import_all(root/'package',root/'inactive',API(os.environ['BUNDLE_TARGET']))
assert result['complete'] and not result['automatic_activation']
assert (root/'inactive/native'/home.name/'memories/USER.md').read_bytes()==b'Exact native owner note\\r\\n'
again=import_all(root/'package',root/'inactive',API(os.environ['BUNDLE_TARGET']));assert again['bundle']==result['bundle']
print(json.dumps({'events':manifest['archive']['events'],'derivatives':manifest['derivatives']['records'],'native_profiles':result['native_profiles']}))
`;
    const child=spawn('python3',['-c',script],{env:{...process.env,BUNDLE_ROOT:root,BUNDLE_TOKEN:token,BUNDLE_SOURCE:String(ports[0]),BUNDLE_TARGET:String(ports[1])},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,stderr);const report=JSON.parse(stdout);assert.equal(report.events,1);assert.ok(report.derivatives>8);assert.equal(report.native_profiles,1);
    assert.equal((await target!.sourcePortability.record(owner,original.reference.id)).event.text,event.text);assert.deepEqual(await target!.sourcePortability.bytes(owner,file.id),bytes);
    assert.equal((await connections[1]!.derived.query('SELECT count(*)::int AS n FROM derived_artifacts WHERE event_id=$1 AND kind=$2',[original.reference.id,'transcript'])).rows[0].n,2);
    const edit=(await connections[1]!.derived.query("SELECT content FROM guard_revisions WHERE source_id=$1 AND author='owner'",['derived_artifacts:'+outputs[0]!.id])).rows[0];assert.equal(JSON.parse(edit.content.toString()).text,'Durable owner correction');
    await assert.rejects(target!.guards.read('derived_artifacts:'+outputs[0]!.id,await target!.guards.state()),{code:'guard_preparation_pending'});
    assert.equal(await target!.access.canLearn(original.reference,await target!.guards.state()),false);
    assert.equal((await connections[1]!.control.query("SELECT 1 FROM workflow_registry WHERE family='telegram'")).rowCount,0);
  }finally{
    for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()));for(const stores of connections)await stores.close();
    for(const schema of namespaces)for(const name of storeNames){const db=new pg.Client({...config,database:'nocheh_'+name});await db.connect();try{await db.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await db.end();}}
    await rm(root,{recursive:true,force:true});
  }
});
