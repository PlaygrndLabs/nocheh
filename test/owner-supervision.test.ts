import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/archive.js';
import {OwnerSupervisionRepository,type OwnerSupervisionDependencies} from '../src/stores/owner-supervision.js';

const owner={admin:true,scope:null},date='2026-10-03T00:00:00.000Z';
function repository(query:(store:string,sql:string,params:unknown[])=>any) {
  const queries:{store:string;sql:string}[]=[];
  const pool=(store:string)=>({query:async(sql:string,params:unknown[]=[])=>{queries.push({store,sql});assert.match(sql.trim(),/^(SELECT|WITH)\b/,'supervision reads must not mutate saved state');return {rows:await query(store,sql,params)};}});
  const services={stores:{archive:pool('archive'),control:pool('control'),derived:pool('derived')},
    projects:{effective:async(space:string)=>({space,own_assignment:null,assignment:null,project:null,inherited:false})},
    controlledActions:{inspect:async()=>{throw Error('unexpected action read');}},telegramActions:{inspect:async()=>{throw Error('unexpected Telegram read');}},
    knowledge:{proposal:async()=>{throw Error('unexpected proposal read');}},memory:{status:async()=>({guard:{generation:'generation',epoch:4,mode:'on'},
      connection:{attached:true,verified:true,revision:2},workspace:null,sessions:[],receipts:[],syncing:false,limited_memory:true})}} as unknown as OwnerSupervisionDependencies;
  return {value:new OwnerSupervisionRepository(services),queries,services};
}

test('conversation directory preserves exact identities, named topics, unknown names and pagination beyond 100',async()=>{
  const {value,queries}=repository((store,sql)=>{
    if(store==='archive')return Array.from({length:125},(_,index)=>({space_id:String(-1000-index),chat:{id:-1000-index,title:'Same display name',type:'supergroup'},observed_at:date}))
      .concat([{space_id:'-1000/topic/7',chat:{id:-1000,title:'Same display name',type:'supergroup'},observed_at:date,topic_name:'Delivery'}] as any);
    if(sql.includes('runtime_configuration'))return [{document:{enabled:true,owner_id:'42',group_ids:['-1000']},revision:5}];
    if(sql.includes('project_assignments'))return [{space_id:'-9999'}];
    throw Error('unexpected query');
  });
  const first=await value.conversations(owner,{limit:100});
  assert.equal(first.total,128);assert.equal(first.items.length,100);assert.ok(first.next_cursor);
  const next=await value.conversations(owner,{limit:100,after:first.next_cursor!});
  assert.equal(next.items.length,28);assert.equal(next.next_cursor,null);
  assert.equal(new Set([...first.items,...next.items].map(item=>item.space_id)).size,128);
  const topic=(await value.conversations(owner,{q:'Delivery'})).items[0]!;
  assert.equal(topic.kind,'topic');assert.equal(topic.space_id,'-1000/topic/7');assert.equal(topic.parent_name,'Same display name');
  assert.equal((await value.conversations(owner,{q:'-9999'})).items[0]!.name,null);
  assert.equal((await value.conversations(owner,{q:'Same display name',limit:100})).total,126);
  assert.ok(queries.filter(query=>query.store==='archive').every(query=>!query.sql.includes('AS payload')),'source bodies must not cross the archive projection');
});

test('every supervision entry point rejects non-owner capabilities before querying',async()=>{
  const {value,queries}=repository(()=>{throw Error('must not query');}),reader={admin:false,scope:'-1000'};
  for(const call of [()=>value.conversations(reader),()=>value.context(reader,'-1000'),()=>value.decisions(reader),()=>value.decision(reader,'entity',digest('id')),()=>value.projectContext(reader,digest('project'))])
    await assert.rejects(call,{code:'owner_required'});
  assert.equal(queries.length,0);
});

test('exact memory decision exposes changed fact revision as stale without reconciliation or an access claim',async()=>{
  const id=digest('request'),content=Buffer.from('Exact reviewed wording'),reference={id:digest('artifact'),input_hash:digest(content)};
  const {value,queries}=repository((store,sql)=>{
    if(sql.includes('memory_access_requests'))return [{id,state:'pending',revision:2,source_scope:'42',destination:'-1000',created_at:date,
      fact_id:digest('fact'),fact_revision:3,proposal_reference:reference,binding:{generation:'generation',epoch:4},expires_at:'2099-01-01'}];
    if(sql.includes('derived_artifacts'))return [{content,content_hash:digest(content),provenance:{}}];
    if(sql.includes('entity_claims'))return [{active_revision:4}];
    if(sql.includes('guard_state'))return [{generation:'generation',epoch:4}];
    throw Error(store+':unexpected query');
  });
  const result=await value.decision(owner,'memory_access',id);
  assert.equal(result.observation,'stale');assert.equal((result.detail as any).current_fact_revision,4);
  assert.equal((result.detail as any).wording,'Exact reviewed wording');assert.equal(result.revision,2);
  assert.equal(queries.length,4);
});

test('unknown conversation context does not inherit a parent sharing grant or equate connection with available memory',async()=>{
  const topic='-1000/topic/99';
  const {value}=repository((store,sql,params)=>{
    if(store==='archive')return [];
    if(sql.includes('runtime_configuration'))return [{document:{enabled:true,owner_id:'42',group_ids:['-1000'],group_access:{'-1000':{granted:['73'],denied:['91']}}},revision:2}];
    if(sql.includes('SELECT space_id FROM project_assignments'))return [];
    if(sql.includes('WHERE destination=$1')||sql.includes('p.destination=$1')||sql.includes('a.space_id=$1')||sql.includes('WHERE scopes ?'))assert.equal(params[0],topic);
    if(sql.includes('security_policy'))return [{revision:1,document:{version:1,rules:[]}}];
    return [];
  });
  const context=await value.context(owner,topic);
  assert.equal(context.conversation.name,null);assert.equal(context.conversation.kind,'topic');
  assert.equal(context.addressing.group_enabled,true);assert.deepEqual(context.addressing.granted,['73']);
  assert.deepEqual(context.knowledge_access.sharing_rules,[]);assert.deepEqual(context.knowledge_access.fact_grants,[]);
  assert.equal(context.memory.connection.attached,true);assert.equal(context.memory.availability,'limited');
  assert.equal(context.memory.syncing,false);assert.equal(context.organization.effective.project,null);
});

test('inbox uses database totals rather than visible page length and retains exact review identity',async()=>{
  const rows=Array.from({length:101},(_,index)=>({kind:'entity',id:digest('suggestion:'+index),state:'pending',revision:7,created_at:date,title:'Same entity name'}));
  const {value}=repository((_store,sql)=>{assert.match(sql,/count\(\*\)/);return [{items:rows,total:145,totals:{entity:145,memory_access:20}}];});
  const result=await value.decisions(owner,{kind:'entity',limit:100});
  assert.equal(result.total,145);assert.equal(result.totals.memory_access,20);assert.equal(result.items.length,100);
  assert.equal(result.next_cursor,'entity:'+rows[99]!.id);assert.equal(result.items[0]!.review.expected_revision,7);
  assert.equal(result.items[0]!.review.href,'#activity?kind=entity&decision='+rows[0]!.id);
});
