import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical,digest} from '../src/archive.js';
import {DerivativePortabilityRepository,portableDerivativeTypes,type PortableRecord} from '../src/stores/derivative-portability.js';
import type {StorePools} from '../src/stores/connections.js';
import type {ArchiveRepository} from '../src/stores/archive.js';

const time='2026-01-01T00:00:00.000Z',identity='a'.repeat(64);
function record(type:string,key:string,value:Record<string,unknown>):PortableRecord {
  return {format:'nocheh-derivative-record-v1',type,key,value,sha256:digest(canonical({type,key,value}))};
}
test('portable control authority remains inspectable history without reactivating permissions or queued work',async()=>{
  const queries:string[]=[],records=new Set<string>();
  const query=async(sql:string,args?:unknown[])=>{queries.push(sql);if(sql.startsWith('INSERT INTO portable_records'))records.add(String(args?.[0]));
    return {rows:[],rowCount:sql.startsWith('SELECT 1 FROM portable_records')?Number(records.has(String(args?.[0]))):1};};
  const stores={control:{query:async()=>{throw Error('portable history must never reach the authority store');}},derived:{query,connect:async()=>({query,release:()=>{}})}} as unknown as StorePools;
  const port=new DerivativePortabilityRepository(stores,{} as ArchiveRepository),owner={admin:true,scope:null};
  const inputs=[
    record('organization_delegations',identity,{id:identity,name:'Synthetic delegation',enabled:true,scopes:['-100'],project_ids:[],allow_create:true,expires_at:null,capture_watermark:'9007199254740993',baselines:{},revision:1,created_at:time,updated_at:time}),
    record('organization_delegation_history','synthetic-command',{operation_id:'synthetic-command',delegation_id:identity,request_hash:identity,record:{enabled:true},created_at:time}),
    record('knowledge_proposals',identity,{id:identity,request_hash:identity,kind:'organization',origin:'learning',source_reference:{id:identity},source_scope:'-100',logical_profile:null,source_job_id:identity,proposal_reference:{id:identity},binding:{},dependencies:{},delegation_id:identity,delegation_revision:1,state:'queued',revision:1,approved:true,result:null,error_code:null,created_at:time,updated_at:time}),
    record('knowledge_decisions','synthetic-decision',{operation_id:'synthetic-decision',proposal_id:identity,request_hash:identity,result:{approved:true},created_at:time}),
    record('organization_project_origins',identity,{project_id:identity,delegation_id:identity,proposal_id:identity,draft_key:'project'}),
    record('memory_access_settings','-100',{destination:'-100',suggestions:'on',notify_owner:true,auto_followup:true,request_ttl_seconds:3600,default_grant_mode:'persistent',revision:1,updated_at:time}),
  ];
  for(const input of inputs)assert.ok(portableDerivativeTypes.includes(input.type));
  assert.deepEqual(await port.restore(owner,inputs),{retained:inputs.length,activated:false});
  assert.deepEqual(await port.verify(owner,inputs),{verified:inputs.length,activated:false});
  assert.equal(records.size,inputs.length);assert.equal(queries.some(sql=>sql.includes('workflow_registry')||sql.includes('workflow_outbox')),false);
});
