import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KnowledgeManagementRepository,type KnowledgeManagementServices} from '../src/stores/knowledge-management.js';

test('knowledge management requires a bound live owner-private assistant turn and status never re-exposes old evidence',async()=>{
 const identity='a'.repeat(64),reference={store:'archive',kind:'event',id:identity},binding={generation:'fixture',epoch:1,mode:'on'};
 let turn:any={owner:true,scope:'42',reference,logical_profile:'hermes'},origin='live',transport='capture',ready='ready',lookups=0;
 const source={reference,kind:'telegram_update',get origin(){return origin;}};
 const service={stores:{control:{query:async(sql:string)=>{
  if(sql.includes('source_intakes'))return {rows:[{transport,state:ready}]};
  if(sql.includes('knowledge_proposals'))return {rows:[{id:identity,kind:'organization',state:'stale',revision:2,approved:false,error_code:'knowledge_dependencies_changed',
   proposal_reference:{id:'unavailable'},dependencies:{sources:[{private:'retired evidence'}]},result:{private:'retired result'}}]};
  throw Error('unexpected query');
 }}},turns:{binding:async()=>{lookups++;return turn;},assertAudience:async()=>binding},
 access:{archive:{verify:async()=>source},policy:()=>({owner_id:'42'})},guards:{state:async()=>binding},
 prepared:{allow:async(_principal:unknown,result:unknown)=>assert.equal(JSON.stringify(result).includes('retired'),false)}
 } as unknown as KnowledgeManagementServices;
 const knowledge=new KnowledgeManagementRepository(service),principal={admin:false,scope:null};
 for(const denied of [{admin:true,scope:null},{admin:false,scope:'42'},{admin:false,scope:null,purpose:'memory-review' as const}]){
  if(!denied.admin)await assert.rejects(knowledge.inspect(denied),{code:'owner_private_turn_required'});
  await assert.rejects(knowledge.propose(denied,{operation_id:'fake-owner',proposal:{admin:true}}),{code:'owner_private_turn_required'});
 }
 assert.equal(lookups,0,'caller-supplied authority claims cannot reach stored context');
 for(const mutation of [()=>{origin='import';},()=>{transport='import';},()=>{ready='pending';},()=>{turn={...turn,job:'scheduled'};},()=>{turn={...turn,scope:'-42'};}]){
  origin='live';transport='capture';ready='ready';turn={owner:true,scope:'42',reference,logical_profile:'hermes'};mutation();
  await assert.rejects(knowledge.proposal(principal,identity),{code:'owner_private_turn_required'});
 }
 origin='live';transport='capture';ready='ready';turn={owner:true,scope:'42',reference,logical_profile:'hermes'};
 assert.deepEqual(await knowledge.proposal(principal,identity),{id:identity,kind:'organization',state:'stale',revision:2,approved:false,error_code:'knowledge_dependencies_changed'});
});
