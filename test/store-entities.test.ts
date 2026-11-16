import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {GuardRepository} from '../src/stores/guards.js';
import {SourceAccessRepository} from '../src/stores/access.js';
import {ProjectRepository} from '../src/stores/projects.js';
import {EntityRepository,attributedSpeaker} from '../src/stores/entities.js';
import {installChatsForTest} from '../src/chats.js';
import {seededDirectory} from './fixture-seeded-chats.js';

test('direct entity claims can omit the trusted speaker ID without weakening attribution',()=>{
  const trusted=digest('trusted-speaker'),other=digest('other-speaker');
  assert.equal(attributedSpeaker('direct',trusted,undefined,trusted),trusted);
  assert.equal(attributedSpeaker('direct',trusted,trusted,trusted),trusted);
  assert.throws(()=>attributedSpeaker('direct',trusted,other,trusted),{code:'entity_attribution_mismatch'});
  assert.throws(()=>attributedSpeaker('direct',other,undefined,trusted),{code:'entity_attribution_mismatch'});
  assert.throws(()=>attributedSpeaker('reported',other,undefined,trusted),{code:'entity_attribution_mismatch'});
  assert.equal(attributedSpeaker('reported',other,trusted,trusted),trusted);
});

test('malformed model candidate IDs remain unbound while unknown canonical IDs are dropped',async()=>{
  const source={id:digest('suggestion-source'),kind:'event',store:'archive',revision:'1',input_hash:digest('source-input')} as any;
  const known=digest('known-person'),unknown=digest('unknown-person'),seen:(string|undefined)[]=[];
  const entities=Object.create(EntityRepository.prototype) as EntityRepository;
  (entities as any).suggest=async(_kind:string,_name:string,_source:unknown,_reason:string,candidate?:string)=>{
    seen.push(candidate);return {candidate};
  };
  const context:any={source,evidence:[{reference:source,text:'synthetic evidence',space:'synthetic'}],
    entities:{speaker:{id:known,kind:'person',name:'Synthetic person'},project:null,mentioned_projects:[],mentioned_people:[]}};
  const input=(candidate_id:unknown)=>({entity_suggestions:[{kind:'person',name:'Synthetic newcomer',reason:'synthetic evidence',
    evidence_ids:[source.id],candidate_id}],entity_claims:[]});
  await entities.publishDiscoveries(context,input('placeholder'),'suggest:invalid');
  assert.deepEqual(seen,[undefined]);
  await entities.publishDiscoveries(context,input(known),'suggest:known');
  assert.deepEqual(seen,[undefined,known]);
  assert.deepEqual((await entities.publishDiscoveries(context,input(unknown),'suggest:unknown')).rejected,[{section:'entity_suggestions',code:'entity_candidate_unavailable'}]);
  assert.deepEqual(seen,[undefined,known]);
});

test('one invalid model entity item is dropped and recorded while valid items are kept',async()=>{
  const source={id:digest('claim-source'),kind:'event',store:'archive',revision:'1',input_hash:digest('claim-input')} as any;
  const speaker=digest('claim-speaker'),project=digest('claim-project'),claims:any[]=[],suggested:string[]=[];
  const entities=Object.create(EntityRepository.prototype) as EntityRepository;
  (entities as any).suggest=async(_kind:string,name:string)=>{suggested.push(name);return {name};};
  (entities as any).publishClaim=async(input:any)=>{claims.push(input);return {id:digest(String(claims.length)),revision:1};};
  // Code finds the cited message to be the speaker's own typing, so a direct claim stays direct.
  (entities as any).spoken=async()=>()=>'direct';
  const context:any={source,evidence:[{reference:source,text:'synthetic evidence',space:'synthetic'}],binding:{},
    entities:{speaker:{id:speaker,kind:'person',name:'Synthetic person'},project:null,mentioned_projects:[{id:project,kind:'project',name:'Synthetic project'}],mentioned_people:[]}};
  const claim={subject_id:speaker,predicate:'commitment',content:'Synthetic commitment.',attribution:'direct',uncertainty:'supported',evidence_ids:[source.id]};
  const result=await entities.publishDiscoveries(context,{
    entity_suggestions:[{kind:'person',name:'Kept',reason:'synthetic',evidence_ids:[source.id],candidate_id:null},
      {kind:'person',name:'Dropped',reason:'synthetic',evidence_ids:[digest('unknown')]}],
    entity_claims:[
      {...claim,object_entity_id:null,relationship_kind:null,speaker_entity_id:null},
      {...claim,predicate:'relationship without object',relationship_kind:'contextual'},
      {...claim,predicate:'object without relationship',object_entity_id:project},
      {...claim,predicate:'unknown relationship',object_entity_id:project,relationship_kind:'friend'},
      {...claim,predicate:'linked',object_entity_id:project,relationship_kind:'depends_on'},
    ]},'discoveries:partial');
  assert.deepEqual(suggested,['Kept']);
  assert.deepEqual(claims.map(c=>c.predicate),['commitment','relationship without object','linked']);
  assert.equal(claims[1].relationship_kind,undefined,'a relationship label without an object links nothing');
  assert.equal(claims[2].relationship_kind,'depends_on');
  assert.deepEqual(result.rejected,[{section:'entity_suggestions',code:'entity_evidence_unavailable'},
    ...Array(2).fill({section:'entity_claims',code:'invalid_entity_relationship'})]);
});

test('the owner and other known authors are never suggested again as new people',async()=>{
  const source={id:digest('known-source'),kind:'event',store:'archive',revision:'1',input_hash:digest('known-input')} as any;
  const bot=digest('bot'),owner=digest('owner'),member=digest('member'),suggested:string[]=[];
  const entities=Object.create(EntityRepository.prototype) as EntityRepository;
  (entities as any).suggest=async(_kind:string,name:string)=>{suggested.push(name);return {name};};
  const context:any={source,evidence:[{reference:source,text:'synthetic evidence',space:'synthetic'}],
    entities:{speaker:{id:bot,kind:'person',name:'My Nocheh'},project:null,mentioned_projects:[],mentioned_people:[],
      owner:{id:owner,kind:'person',name:'Alex Morgan'},participants:[{id:member,kind:'person',name:'Sara Reed'}]}};
  const person=(name:string)=>({kind:'person',name,reason:'synthetic',evidence_ids:[source.id]});
  const result=await entities.publishDiscoveries(context,{entity_suggestions:[person('Alex Morgan'),person('Alex Morgan (AM76)'),person('sara reed'),
    person('Jordan'),{...person('Alex Morgan'),kind:'project'}],entity_claims:[]},'known:people');
  assert.deepEqual(suggested,['Jordan','Alex Morgan'],'only someone new, or a project, is suggested');
  assert.deepEqual(result.rejected,Array(3).fill({section:'entity_suggestions',code:'entity_already_known'}));
});

test('people and projects keep stable identity, attributed evidence, connected recall paths and audience privacy',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async t=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},check=new pg.Pool(config);
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),archive=new ArchiveRepository(stores.archive),guards=new GuardRepository(stores,archive);
  const stamp=String(Date.now()),atlasGroup='-'+stamp,privateGroup='-'+String(Number(stamp)+1),userBase=Number(stamp.slice(-7))*10,owner:Reader={admin:true,scope:null};
  const policy=()=>({enabled:true,owner_id:'42',group_ids:[atlasGroup,privateGroup]});
  // The chats as Part A's seeder leaves groups stored before step 2b (ADR-0252).
  t.after(installChatsForTest(seededDirectory(policy)));
  const access=new SourceAccessRepository(stores,archive,guards,policy);
  const projects=new ProjectRepository(stores.control),entities=new EntityRepository(stores,access,projects);
  const capture=async(label:string,user:number,text:string,group=atlasGroup)=>{
    const envelope:Envelope={version:1,key:`entities:${stamp}:${label}`,origin:'live',kind:'telegram_update',bot_id:'fixture',scope:group,
      source_id:label,revision:'1',occurred_at:null,text,payload:{update_id:Number(stamp.slice(-8))+user,message:{message_id:Number(label.replace(/\D/g,''))||user,
        date:1,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:user,first_name:'Alex'},text}}};
    return (await archive.capture(envelope)).source.reference;
  };
  try {
    const atlas=await projects.save(owner,{name:'Atlas',description:'Atlas project',state:'active',expected_revision:0,operation_id:`${stamp}:atlas`});
    const beacon=await projects.save(owner,{name:'Beacon',description:'Beacon project',state:'active',expected_revision:0,operation_id:`${stamp}:beacon`});
    await projects.assign(owner,{space_id:atlasGroup,project_id:atlas.id,mode:'assigned',expected_revision:0,operation_id:`${stamp}:assign`});
    const samSource=await capture('1',userBase+1,'Beacon needs Alex to deliver Friday.');
    const otherAlexSource=await capture('2',userBase+2,'I am a different Alex.');
    const sam=await entities.ensureParticipant(samSource),samAgain=await entities.ensureParticipant(samSource),otherAlex=await entities.ensureParticipant(otherAlexSource);
    assert.ok(sam&&otherAlex);assert.equal(sam!.name,'Alex');assert.equal(otherAlex!.name,'Alex');
    assert.equal(sam!.id,samAgain!.id);assert.notEqual(sam!.id,otherAlex!.id,'same display name never merges exact platform identities');
    const react=async(label:string,user:Record<string,unknown>)=>(await archive.capture({version:1,key:`entities:${stamp}:${label}`,origin:'live',kind:'telegram_update',
      bot_id:'fixture',scope:atlasGroup,source_id:label,revision:'1',occurred_at:null,text:'',payload:{update_id:Number(stamp.slice(-8))+900+Number(label.replace(/\D/g,'')),
        message_reaction:{chat:{id:Number(atlasGroup),type:'supergroup'},message_id:1,date:2,user,old_reaction:[],new_reaction:[{type:'emoji',emoji:'👍'}]}}})).source.reference;
    assert.equal((await entities.ensureParticipant(await react('r1',{id:userBase+1,is_bot:false})))!.name,'Alex','an update without a name keeps the known one');
    assert.equal((await entities.ensureParticipant(await react('r2',{id:userBase+1,is_bot:false,first_name:'Alex',last_name:'Reed'})))!.name,'Alex Reed',
      'a reaction names its actor');
    assert.equal((await entities.ensureParticipant(await react('r3',{id:userBase+1,is_bot:false,first_name:'Alex'})))!.name,'Alex');
    const ownerSource=await capture('3',42,'Please remember Jordan.'),self=await entities.ensureParticipant(ownerSource);
    const people=await entities.knownPeople([samSource,otherAlexSource,ownerSource],sam);
    assert.equal(people.owner?.id,self!.id,'the configured owner account is always a known person');
    assert.deepEqual(people.participants.map(item=>item.id),[otherAlex!.id],'other authors are known; the speaker and owner are not repeated');
    const first=await entities.suggest('person','Jordan',samSource,'first'),again=await entities.suggest('person','jordan',otherAlexSource,'again');
    assert.equal(again.id,first.id,'the same name from new evidence never adds another card');
    assert.equal(again.reason,'first');
    const ambiguous=await entities.connected(owner,'What did Alex promise?');assert.ok((ambiguous.ambiguities[0]?.entity_ids.length??0)>=2,'owner-private natural-language questions retain same-name ambiguity');

    const context=await entities.context(samSource,[beacon],'Beacon needs Alex to deliver Friday.');
    assert.equal(context.project?.project_id,atlas.id);assert.equal(context.mentioned_projects[0]?.project_id,beacon.id);
    const binding=await guards.state(),prepared:any={source:samSource,source_object:'fixture',space:atlasGroup,binding,evidence:[{reference:samSource,text:'',space:atlasGroup}],
      dependencies:[],observations:[],rules:[],rule_ids:[],rule_inputs:[],projects:[],entities:context,limitations:[]};
    await entities.publishDiscoveries(prepared,{entity_suggestions:[],entity_claims:[{subject_id:context.mentioned_projects[0]!.id,predicate:'commitment',
      content:'Alex promised Friday according to the speaker.',attribution:'reported',speaker_entity_id:sam!.id,uncertainty:'supported',evidence_ids:[samSource.id]}]},`${stamp}:discover`);

    const atlasReader=access.principal(atlasGroup),privateReader=access.principal(privateGroup);
    const connected=await entities.connected(atlasReader,'Atlas');
    assert.equal(connected.entities[0]!.entity.name,'Atlas');
    assert.match(connected.entities.find(item=>item.entity.name==='Beacon')!.path.join(' '),/contextual: Beacon/);
    const fromBeacon=await entities.connected(atlasReader,'Beacon');
    assert.equal(new Set(fromBeacon.entities.map(item=>item.entity.id)).size,fromBeacon.entities.length,'cycles never duplicate an entity');
    assert.ok(fromBeacon.entities.some(item=>item.entity.id===sam!.id),'useful multi-step paths reach a participant');
    assert.equal((await entities.connectedFrom(atlasReader,[context.project!.id],1)).partial,true,'bounded traversal reports partial results');
    const beaconMemory=await entities.inspect(atlasReader,context.mentioned_projects[0]!.id);
    const reported=beaconMemory.claims.find((claim:any)=>claim.predicate==='commitment');
    assert.equal(reported.attribution,'reported');assert.equal(reported.speaker_entity_id,sam!.id);
    // A direct claim stands only on the speaker's own typing, which code checks from the originals, never from the model:
    // one resting on a forward is what the speaker passed on, and one resting on someone else's message is inferred.
    const forwardText='Beacon ships in May.',forwarded=(await archive.capture({version:1,key:`entities:${stamp}:5`,origin:'live',kind:'telegram_update',bot_id:'fixture',
      scope:atlasGroup,source_id:'5',revision:'1',occurred_at:null,text:forwardText,payload:{update_id:Number(stamp.slice(-8))+700,message:{message_id:5,date:1,
        chat:{id:Number(atlasGroup),type:'supergroup',is_forum:false},from:{id:userBase+1,first_name:'Alex'},text:forwardText,
        forward_origin:{type:'channel',chat:{id:-1009,type:'channel',title:'News'},message_id:3,date:1}}}})).source.reference;
    // A direct claim is the speaker's own word about themselves.
    const cite=(predicate:string,source:{id:string})=>({subject_id:sam!.id,predicate,content:`Synthetic ${predicate}.`,attribution:'direct',
      uncertainty:'supported',evidence_ids:[source.id]});
    const batch=(observed:{id:string}[])=>({...prepared,evidence:[samSource,forwarded,otherAlexSource].map(reference=>({reference,text:'',space:atlasGroup})),
      observations:observed.map(source=>({source,value:{},derivatives:[]}))});
    const direct=await entities.publishDiscoveries(batch([samSource]),{entity_suggestions:[],entity_claims:[cite('typed',samSource),cite('forwarded',forwarded),
      cite('someone else',otherAlexSource)]},`${stamp}:direct`);
    const passedOn=await entities.publishDiscoveries(batch([samSource,forwarded]),{entity_suggestions:[],entity_claims:[cite('typed beside a forward',samSource)]},`${stamp}:passed-on`);
    assert.deepEqual([direct.rejected,passedOn.rejected],[[],[]]);
    const checked=new Map((await entities.inspect(atlasReader,sam!.id)).claims.map((claim:any)=>[claim.predicate,claim]));
    assert.deepEqual(['typed','forwarded','someone else','typed beside a forward'].map(predicate=>[checked.get(predicate)?.attribution,checked.get(predicate)?.speaker_entity_id??null]),
      [['direct',sam!.id],['reported',sam!.id],['inferred',null],['reported',sam!.id]],
      'the speaker\'s own typing stays direct; a forward, or typing sent with one, is reported; another person\'s message is inferred');
    // The owner's reply quoting Nocheh's own learned message is the owner's own words, found through the archive's reply
    // relation and never an id's shape; a reply quoting Nocheh's card is what the owner passed on, as before.
    const chat={id:Number(atlasGroup),type:'supergroup',is_forum:false},bot={id:userBase+9,is_bot:true,first_name:'Nocheh'};
    const said=async(id:number,send_class:string)=>(await archive.capture({version:1,key:`entities:${stamp}:said:${id}`,origin:'live',kind:'telegram_delivered_message',
      bot_id:'fixture',scope:atlasGroup,source_id:String(id),revision:'1',occurred_at:null,text:'Book the 9am train.',
      payload:{message:{message_id:id,date:1,chat,text:'Book the 9am train.'},send_class}})).source.reference;
    const quoting=async(id:number)=>(await archive.capture({version:1,key:`entities:${stamp}:quoting:${id}`,origin:'live',kind:'telegram_update',bot_id:'fixture',
      scope:atlasGroup,source_id:String(id+1),revision:'1',occurred_at:null,text:'I will take the 9am.',payload:{update_id:Number(stamp.slice(-8))+800+id,
        message:{message_id:id+1,date:2,chat,from:{id:42,first_name:'Owner'},text:'I will take the 9am.',quote:{text:'Book the 9am',position:0},
          reply_to_message:{message_id:id,date:1,chat,from:bot,text:'Book the 9am train.'}}}})).source.reference;
    const learned=await said(60,'reply'),card=await said(62,'card'),ofLearned=await quoting(60),ofCard=await quoting(62);
    const ownerContext=await entities.context(ofLearned,[],'I will take the 9am.');assert.equal(ownerContext.speaker?.id,self!.id);
    const ownClaim=(predicate:string,source:{id:string})=>({subject_id:self!.id,predicate,content:`Synthetic ${predicate}.`,attribution:'direct',
      uncertainty:'supported',evidence_ids:[source.id]});
    for(const [predicate,quote,target] of [['quoting Nocheh',ofLearned,learned],['quoting a card',ofCard,card]] as const)
      assert.deepEqual((await entities.publishDiscoveries({...prepared,source:quote,entities:ownerContext,
        evidence:[quote,target].map(reference=>({reference,text:'',space:atlasGroup})),observations:[quote,target].map(source=>({source,value:{},derivatives:[]}))},
        {entity_suggestions:[],entity_claims:[ownClaim(predicate,quote)]},`${stamp}:${predicate}`)).rejected,[]);
    const own=new Map((await entities.inspect(owner,self!.id)).claims.map((claim:any)=>[claim.predicate,claim]));
    assert.deepEqual(['quoting Nocheh','quoting a card'].map(predicate=>[own.get(predicate)?.attribution,own.get(predicate)?.speaker_entity_id??null]),
      [['direct',self!.id],['reported',self!.id]],'the owner\'s quote of Nocheh\'s learned message is the owner\'s own words; a quote of a card is passed on');
    await assert.rejects(entities.inspect(privateReader,context.mentioned_projects[0]!.id),{code:'entity_not_found'});
    assert.equal((await entities.list(privateReader,{query:'Beacon'})).entities.length,0,'private entity names do not leak through search');

    const renamed=await entities.rename(owner,sam!.id,{name:'Alex Morgan',expected_revision:sam!.revision,operation_id:`${stamp}:rename`});
    assert.equal(renamed.name,'Alex Morgan');assert.equal((await stores.control.query('SELECT name FROM memory_entities WHERE id=$1',[sam!.id])).rows[0].name,'Alex Morgan');
    await assert.rejects(entities.rename(owner,sam!.id,{name:'Stale name',expected_revision:sam!.revision,operation_id:`${stamp}:stale-rename`}),{code:'entity_revision_conflict'});

    await entities.merge(owner,otherAlex!.id,{target_id:sam!.id,expected_revision:otherAlex!.revision,operation_id:`${stamp}:merge`});
    assert.equal((await stores.control.query('SELECT entity_id FROM memory_entity_bindings WHERE source_object_id IS NOT NULL AND entity_id=$1',[sam!.id])).rowCount,2);
    await entities.unmerge(owner,otherAlex!.id,{expected_revision:otherAlex!.revision+1,operation_id:`${stamp}:unmerge`});
    assert.equal((await stores.control.query('SELECT entity_id FROM memory_entity_bindings WHERE source_object_id IS NOT NULL AND entity_id=$1',[otherAlex!.id])).rowCount,1,
      'undo restores original identity bindings');
  } finally {await stores.close();}
 });
