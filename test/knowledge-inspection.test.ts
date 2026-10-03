import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/archive.js';
import {KnowledgeManagementRepository,type KnowledgeManagementServices} from '../src/stores/knowledge-management.js';

const entityId='a'.repeat(64),factId='b'.repeat(64),grantId='c'.repeat(64),sourceId='d'.repeat(64);
test('runtime knowledge inspection guards contents and retains exact claims, disabled rules, revisions and independent cursors',async()=>{
  let allowed=true,prepared=0;const queries:{sql:string;args:unknown[]}[]=[];
  const binding={generation:'synthetic-generation',epoch:2,mode:'on' as const},principal={admin:false,scope:null};
  const fact={id:factId,subject_entity_id:entityId,predicate:'status',revision:3,content:'sensitive-fixture-text',evidence:[{id:sourceId}]};
  const services={stores:{control:{query:async(sql:string,args:unknown[]=[])=>{
    queries.push({sql,args});
    if(sql.includes('FROM projects WHERE'))return {rows:[{id:entityId,name:'sensitive-fixture-text',revision:3}]};
    if(sql.includes('FROM memory_entities WHERE'))return {rows:[{id:entityId,kind:'person',name:'sensitive-fixture-text',revision:3}]};
    if(sql.includes('FROM organization_delegations'))return {rows:[]};
    if(sql.includes('FROM project_assignments'))return {rows:[]};
    if(sql.includes('FROM sharing_rules'))return {rows:[{id:grantId,name:'sensitive-fixture-text',enabled:false,revision:4}]};
    if(sql.includes('FROM memory_fact_grants'))return {rows:[{id:grantId,fact_id:factId,fact_revision:3,revision:2,state:'active',binding:{...binding,epoch:1},expires_at:null,guard_revision:1,text_hash:digest('wording'),representation_reference:{id:grantId}}]};
    throw Error('unexpected query '+sql);
  }},derived:{query:async(sql:string,args:unknown[])=>{queries.push({sql,args});return {rows:[fact]};}}},
  guards:{state:async()=>binding},access:{canRead:async()=>allowed},
  entities:{list:async()=>({entities:[{id:entityId,name:'sensitive-fixture-text'}],next:factId})},
  projects:{effective:async()=>({space:'-10',own_assignment:{space_id:'-10',revision:2}})},
  prepared:{prepare:async(_principal:unknown,result:unknown)=>{prepared++;return JSON.parse(JSON.stringify(result).replaceAll('sensitive-fixture-text','***'));},
    allow:async()=>{throw Error('raw values must not be whitelisted');}},turns:{assertAudience:async()=>binding},detect:async()=>[]
  } as unknown as KnowledgeManagementServices;
  const knowledge=new KnowledgeManagementRepository(services);
  (knowledge as any).ownerTurn=async()=>({binding}); // Authorization is covered by broker and storage boundary tests.
  const context=await knowledge.inspect(principal,{space:'-10',q:'Example',after:entityId,sharing_after:factId});
  assert.equal(JSON.stringify(context).includes('sensitive-fixture-text'),false);
  assert.deepEqual(context.sharing_rules,[{id:grantId,name:'***',enabled:false,revision:4}]);
  assert.equal((context.entities as any).next,factId);
  const ruleQuery=queries.find(query=>query.sql.includes('FROM sharing_rules'))!;
  assert.deepEqual(ruleQuery.args,['-10',factId]);assert.equal(/AND enabled/.test(ruleQuery.sql),false);
  const detail=await knowledge.inspect(principal,{entity_id:entityId,claims_after:grantId});
  assert.equal((detail.claims as any[])[0].revision,3);assert.equal((detail.claims as any[])[0].content,'***');
  assert.equal((detail.entity as any).id,entityId);assert.equal(JSON.stringify(detail).includes('sensitive-fixture-text'),false);
  const selected=await knowledge.inspect(principal,{fact_id:factId,grants_after:entityId});
  assert.equal((selected.fact as any).id,factId);assert.equal((selected.grants as any[])[0].id,grantId);
  assert.equal((selected.grants as any[])[0].effective_state,'suspended','an old guard binding is not reported as usable authority');
  assert.equal(prepared,3);
  allowed=false;
  assert.deepEqual((await knowledge.inspect(principal,{entity_id:entityId})).claims,[],'retired or inaccessible original evidence cannot enter management context');
  await assert.rejects(knowledge.inspect(principal,{fact_id:factId}),{code:'memory_fact_not_found'});
  await assert.rejects(knowledge.inspect(principal,{entity_id:entityId,fact_id:factId}),{code:'knowledge_inspection_target_conflict'});
});
