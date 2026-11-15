import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/archive.js';
import {chatDirectory,chatIdFor,type ChatIdRow,type ChatRow,type ChatSnapshot} from '../src/chats.js';
import type {ChatListing} from '../src/stores/chats.js';
import {OwnerSupervisionRepository,type OwnerSupervisionDependencies} from '../src/stores/owner-supervision.js';
import {installChatsForTest} from '../src/chats.js';
import {legacyDirectory} from './fixture-groups.js';

// The chats these tests name, as the seeder makes their rows (ADR-0251): what a topic is comes from its row.
installChatsForTest(legacyDirectory([...Array.from({length:125},(_,index)=>String(-1000-index)),'-1000/topic/7','-1000/topic/99','-9999'],{owner:'42',served:['-1000']}));

const owner={admin:true,scope:null},date='2026-10-03T00:00:00.000Z';
const detail=(value:Partial<ChatListing>):ChatListing=>({title_source:null,username:null,seen_at:null,closed:null,refreshed:null,...value});
const group=(id:string,title:string|null,state:ChatRow['state']='off'):ChatRow=>({id,app:'telegram',kind:'group',parent_id:null,topic_key:null,state,title,is_forum:true,account_id:null,app_type:'supergroup'});
const topic=(id:string,parent:string,key:string,title:string|null=null):ChatRow=>({id,app:'telegram',kind:'topic',parent_id:parent,topic_key:key,state:'off',title,is_forum:false,account_id:null,app_type:null});
const current=(chat:string,external:string):ChatIdRow=>({app:'telegram',external_id:external,chat_id:chat,state:'current'});
function repository(query:(store:string,sql:string,params:unknown[])=>any,snapshot:ChatSnapshot={chats:[],ids:[],owner_chat:null},details=new Map<string,ChatListing>()) {
  const queries:{store:string;sql:string}[]=[];
  const pool=(store:string)=>({query:async(sql:string,params:unknown[]=[])=>{queries.push({store,sql});assert.match(sql.trim(),/^(SELECT|WITH)\b/,'supervision reads must not mutate saved state');return {rows:await query(store,sql,params)};}});
  const services={stores:{archive:pool('archive'),control:pool('control'),derived:pool('derived')},
    projects:{effective:async(space:string)=>({space,own_assignment:null,assignment:null,project:null,inherited:false})},
    controlledActions:{inspect:async()=>{throw Error('unexpected action read');}},telegramActions:{inspect:async()=>{throw Error('unexpected Telegram read');}},
    knowledge:{proposal:async()=>{throw Error('unexpected proposal read');}},
    chats:{listing:async()=>({directory:chatDirectory(snapshot),rows:details})},memory:{status:async()=>({guard:{generation:'generation',epoch:4,mode:'on'},
      connection:{attached:true,verified:true,revision:2},workspace:null,sessions:[],receipts:[],syncing:false,limited_memory:true})}} as unknown as OwnerSupervisionDependencies;
  return {value:new OwnerSupervisionRepository(services),queries,services};
}

test('conversation directory lists chat records with exact identities, named topics, unknown values and pagination beyond 100',async()=>{
  // Both families: old-shaped groups keep their Telegram id as their Nocheh id, newer ones have digest ids.
  const groups=Array.from({length:125},(_,index)=>{const external=String(-1001000000100-index);return {id:index%2?chatIdFor('telegram',external):external,external};});
  const named=chatIdFor('telegram',groups[1]!.external,'7'),unseen=chatIdFor('telegram',groups[3]!.external,'8'),seen=groups[0]!.id+'/topic/9';
  const snapshot:ChatSnapshot={chats:[...groups.map(item=>group(item.id,'Same display name')),topic(named,groups[1]!.id,'7','Delivery'),
    topic(unseen,groups[3]!.id,'8'),topic(seen,groups[0]!.id,'9','Seen topic')],ids:groups.map(item=>current(item.id,item.external)),owner_chat:null};
  const details=new Map([[named,detail({title_source:'owner'})],[seen,detail({title_source:'observed',seen_at:new Date(date),closed:true})],
    [groups[0]!.id,detail({seen_at:new Date(date),refreshed:{state:'available',to:null,at:new Date(date)}})]]);
  const {value,queries}=repository((_store,sql)=>{
    if(sql.includes('runtime_configuration'))return [{document:{enabled:true,owner_id:'42',group_ids:[groups[1]!.external]},revision:5}];
    if(sql.includes('project_assignments'))return [{space_id:'-9999'}];
    throw Error('unexpected query');
  },snapshot,details);
  const first=await value.conversations(owner,{limit:100});
  // 125 groups, two listed topics (a topic nothing saw or named is left out), and the two values with no chat record.
  assert.equal(first.total,129);assert.equal(first.items.length,100);assert.ok(first.next_cursor);
  const next=await value.conversations(owner,{limit:100,after:first.next_cursor!});
  assert.equal(next.items.length,29);assert.equal(next.next_cursor,null);
  const all=[...first.items,...next.items];
  assert.equal(new Set(all.map(item=>item.space_id)).size,129);assert.ok(!all.some(item=>item.space_id===unseen));
  const delivery=(await value.conversations(owner,{q:'Delivery'})).items[0]!;
  assert.equal(delivery.kind,'topic');assert.equal(delivery.space_id,named);assert.equal(delivery.parent_space,groups[1]!.id);
  assert.equal(delivery.parent_name,'Same display name');assert.equal(delivery.registered,true);assert.equal(delivery.topic_key,'7');
  assert.deepEqual(delivery.app_ids,[{app:'telegram',external:groups[1]!.external,state:'current'}]);assert.equal(delivery.observed_at,null);
  const observed=all.find(item=>item.space_id===seen)!;
  assert.equal(observed.closed,true);assert.equal(observed.registered,undefined);assert.equal(observed.observed_at,date);
  const configured=all.find(item=>item.space_id===groups[1]!.id)!;assert.equal(configured.configured,true);assert.equal(configured.kind,'group');
  assert.deepEqual(all.find(item=>item.space_id===groups[0]!.id)!.telegram,{state:'available',migrate_to_chat_id:null,observed_at:date});
  for(const unknown of ['-9999','42']) {
    const item=(await value.conversations(owner,{q:unknown})).items.find(entry=>entry.space_id===unknown)!;
    assert.equal(item.name,null);assert.equal(item.kind,'unknown');assert.equal(item.configured,true);assert.deepEqual(item.app_ids,[]);
  }
  assert.equal((await value.conversations(owner,{q:'Same display name',limit:100})).total,127);
  assert.equal(queries.filter(query=>query.store==='archive').length,0,'the directory is read from chat records, never from source bodies');
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
  // A topic Nocheh knows only by its record: its group's access is keyed by the group's Telegram id.
  const external='-1002000000001',parent=chatIdFor('telegram',external),space=chatIdFor('telegram',external,'99');
  const snapshot:ChatSnapshot={chats:[group(parent,null,'active'),topic(space,parent,'99')],ids:[current(parent,external)],owner_chat:null};
  const run=async(id:string)=>{
    const {value}=repository((store,sql,params)=>{
      if(store==='archive')return [];
      if(sql.includes('runtime_configuration'))return [{document:{enabled:true,owner_id:'42',group_ids:[external],group_access:{[external]:{granted:['73'],denied:['91']}}},revision:2}];
      if(sql.includes('SELECT space_id FROM project_assignments'))return [];
      if(sql.includes('WHERE destination=$1')||sql.includes('p.destination=$1')||sql.includes('a.space_id=$1')||sql.includes('WHERE scopes ?'))assert.equal(params[0],id);
      if(sql.includes('destination=ANY'))assert.ok((params[0] as string[]).includes(id));
      if(sql.includes('security_policy'))return [{revision:1,document:{version:1,rules:[]}}];
      return [];
    },snapshot);
    return value.context(owner,id);
  };
  const context=await run(space);
  assert.equal(context.conversation.name,null);assert.equal(context.conversation.kind,'topic');assert.equal(context.conversation.parent_space,parent);
  assert.equal(context.addressing.group_enabled,true);assert.deepEqual(context.addressing.granted,['73']);
  assert.deepEqual(context.knowledge_access.sharing_rules,[]);assert.deepEqual(context.knowledge_access.fact_grants,[]);
  assert.equal(context.memory.connection.attached,true);assert.equal(context.memory.availability,'limited');
  assert.equal(context.memory.syncing,false);assert.equal(context.organization.effective.project,null);
  // A value no chat record names is unknown: it borrows nothing from a group its text looks like.
  const unknown=await run(external+'/topic/99');
  assert.equal(unknown.conversation.kind,'unknown');assert.equal(unknown.addressing.group_enabled,false);assert.deepEqual(unknown.addressing.granted,[]);
  assert.equal(unknown.knowledge_access.owner_access,false);
});

test('a group Telegram upgraded shows the access lists under both its ids joined, deny winning, as the turn gate applies them',async()=>{
  const before='-2000000000002',after='-1002000000002',chat=chatIdFor('telegram',before);
  const snapshot:ChatSnapshot={chats:[group(chat,null,'active')],ids:[{app:'telegram',external_id:before,chat_id:chat,state:'old'},current(chat,after)],owner_chat:null};
  // Alice was let in before the upgrade; Bob was let in before it and turned away after it.
  const access={[before]:{granted:['301','302'],denied:[]},[after]:{granted:[],denied:['302']}};
  const {value}=repository((store,sql)=>{
    if(store==='archive')return [];
    if(sql.includes('runtime_configuration'))return [{document:{enabled:true,owner_id:'42',group_ids:[after],group_access:access},revision:2}];
    if(sql.includes('security_policy'))return [{revision:1,document:{version:1,rules:[]}}];
    return [];
  },snapshot);
  const context=await value.context(owner,chat);
  assert.deepEqual([context.addressing.granted,context.addressing.denied],[['301','302'],['302']]);
  assert.equal(context.addressing.group_enabled,true);
});

test('inbox uses database totals rather than visible page length and retains exact review identity',async()=>{
  const rows=Array.from({length:101},(_,index)=>({kind:'entity',id:digest('suggestion:'+index),state:'pending',revision:7,created_at:date,title:'Same entity name'}));
  // The second read lists names folded into the page's person and project cards.
  const {value}=repository((_store,sql)=>{if(/merged_into=ANY/.test(sql))return [];assert.match(sql,/count\(\*\)/);return [{items:rows,total:145,totals:{entity:145,memory_access:20}}];});
  const result=await value.decisions(owner,{kind:'entity',limit:100});
  assert.equal(result.total,145);assert.equal(result.totals.memory_access,20);assert.equal(result.items.length,100);
  assert.equal(result.next_cursor,'entity:'+rows[99]!.id);assert.equal(result.items[0]!.review.expected_revision,7);
  assert.equal(result.items[0]!.review.href,'#inbox?kind=entity&decision='+rows[0]!.id);
  assert.deepEqual((result.items[0] as any).also_called,[]);
});
