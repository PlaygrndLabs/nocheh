import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/archive.js';
import {parseKnowledgeProposal,learnedOrganization,organizationIdentity,proposalPrivateChats,type OrganizationProposal} from '../src/stores/knowledge-contract.js';

const source=digest('original-evidence'),project=digest('existing-project');
const organization=():OrganizationProposal=>({kind:'organization',reason:'Evidence identifies a project',creates:[{key:'new_project',name:'Project Aurora',description:'Evidence-backed project',evidence_ids:[source]}],
  assignments:[{space_id:'-1000',project_key:'new_project',expected_revision:0,evidence_ids:[source],reason:'This group exists for that project',purpose_evidence:true}]});

test('organization proposals are evidence-backed typed effects, not administrative authority',()=>{
  assert.deepEqual(parseKnowledgeProposal(organization()),organization());
  for(const field of ['admin','approved','delegation_id','authorization','guard_epoch','operation_id'])
    assert.throws(()=>parseKnowledgeProposal({...organization(),[field]:true}),{code:'unknown_knowledge_field'});
  assert.throws(()=>parseKnowledgeProposal({...organization(),creates:[{...organization().creates[0],evidence_ids:[]}]}),{code:'organization_evidence_required'});
  assert.throws(()=>parseKnowledgeProposal({...organization(),assignments:[{...organization().assignments[0],purpose_evidence:'true'}]}),{code:'invalid_organization_assignment'});
});

test('project references and conversation assignments are exact and unambiguous',()=>{
  const proposal=organization();
  assert.throws(()=>parseKnowledgeProposal({...proposal,assignments:[{...proposal.assignments[0],project_id:project}]}),{code:'invalid_organization_assignment'});
  assert.throws(()=>parseKnowledgeProposal({...proposal,assignments:[{...proposal.assignments[0],project_key:'missing'}]}),{code:'unknown_project_key'});
  assert.throws(()=>parseKnowledgeProposal({...proposal,assignments:[proposal.assignments[0],proposal.assignments[0]]}),{code:'duplicate_organization_assignment'});
  assert.throws(()=>parseKnowledgeProposal({...proposal,creates:[proposal.creates[0],{...proposal.creates[0],key:'another',name:'PROJECT AURORA'}]}),{code:'duplicate_project_creation'});
  assert.throws(()=>parseKnowledgeProposal({...proposal,assignments:[{...proposal.assignments[0],expected_revision:-1}]}),{code:'invalid_revision'});
});

test('discovery can create a project without changing conversation membership',()=>{
  const proposal={...organization(),assignments:[]};
  assert.deepEqual(parseKnowledgeProposal(proposal),proposal);
  assert.throws(()=>parseKnowledgeProposal({...proposal,creates:[]}),{code:'organization_batch_limit'});
});

test('deduplication identity excludes descriptive rationale and normalizes original evidence',()=>{
  const a=organization(),b=organization();b.reason='Reprocessed evidence';b.assignments[0]!.reason='Different model wording';b.creates[0]!.description='Different summary';
  assert.deepEqual(organizationIdentity(a),organizationIdentity(b));
  b.assignments[0]!.space_id='-1001';assert.notDeepEqual(organizationIdentity(a),organizationIdentity(b));
  const duplicate={...a,creates:[{...a.creates[0]!,evidence_ids:[source,source]}]};
  assert.deepEqual((parseKnowledgeProposal(duplicate) as OrganizationProposal).creates[0]!.evidence_ids,[source]);
});

test('review proposals cannot smuggle owner operation routing or grant whole project access',()=>{
  const rename={kind:'entity_rename',reason:'Owner correction',target_id:digest('entity'),payload:{name:'Aurora',expected_revision:3}};
  assert.deepEqual(parseKnowledgeProposal(rename),rename);
  assert.throws(()=>parseKnowledgeProposal({...rename,payload:{...rename.payload,operation_id:'override'}}),{code:'unknown_knowledge_field'});
  assert.throws(()=>parseKnowledgeProposal({...rename,kind:'call_owner_api'}),{code:'unsupported_knowledge_operation'});
  assert.throws(()=>parseKnowledgeProposal({kind:'fact_grant',reason:'Share project',payload:{project_id:project,destination:'-1000',wording:'Whole project'}}),{code:'unknown_knowledge_field'});
  assert.throws(()=>parseKnowledgeProposal({kind:'sharing_rule',reason:'Invalid scope expansion',payload:{name:'Same source and destination',sources:['-1000'],destination:'-1000',enabled:true,mode:'filtered',expected_revision:0}}),{code:'invalid_sharing_rule'});
});

test('a learning answer\'s null lists and fields mean absent, so a lone assignment is kept',()=>{
  const assignment={space_id:'-1000',project_id:project,project_key:null,expected_revision:2,reason:'This group exists for that project',purpose_evidence:true,evidence_ids:[source]};
  const proposal=learnedOrganization({reason:'Evidence identifies a project',creates:null,assignments:[assignment]})!;
  assert.deepEqual(proposal.creates,[]);
  assert.deepEqual(proposal.assignments,[{space_id:'-1000',project_id:project,expected_revision:2,evidence_ids:[source],reason:'This group exists for that project',purpose_evidence:true}]);
  assert.equal(learnedOrganization({reason:null,creates:[{key:'new_project',name:'Project Aurora',description:null,evidence_ids:[source]}],assignments:null})!.creates.length,1);
  assert.throws(()=>learnedOrganization({reason:'Nothing to organize',creates:null,assignments:null}),{code:'organization_batch_limit'});
});

test('a private chat, the owner\'s included, never joins a project or a sharing rule through a proposal',()=>{
  const assignment=(space_id:string)=>({...organization().assignments[0]!,space_id});
  for(const space of ['123','123/topic/5','desktop:personal_chat:9','system']){
    assert.throws(()=>parseKnowledgeProposal({...organization(),assignments:[assignment(space)]}),{code:'project_private_chat'},space);
    assert.throws(()=>parseKnowledgeProposal({kind:'project_assignment',reason:'Move it',payload:{space_id:space,project_id:project,mode:'assigned',expected_revision:0}}),{code:'project_private_chat'},space);
    const rule={name:'Share',sources:['-1000'],destination:'-1001',enabled:true,mode:'approved',instructions:'',expected_revision:0};
    assert.throws(()=>parseKnowledgeProposal({kind:'sharing_rule',reason:'Share',payload:{...rule,sources:['-1000',space]}}),{code:'sharing_private_chat'},space);
    assert.throws(()=>parseKnowledgeProposal({kind:'sharing_rule',reason:'Share',payload:{...rule,destination:space}}),{code:'sharing_private_chat'},space);
    assert.throws(()=>parseKnowledgeProposal({kind:'fact_grant',reason:'Share',payload:{fact_id:project,fact_revision:1,destination:space,wording:'A fact'}}),{code:'memory_grant_private_destination'},space);
  }
  // A private chat may still be kept out of every project.
  assert.equal(parseKnowledgeProposal({kind:'project_assignment',reason:'Keep it out',payload:{space_id:'123',mode:'none',expected_revision:1}}).kind,'project_assignment');
  // The agent cannot confirm a private source for the owner.
  assert.throws(()=>parseKnowledgeProposal({kind:'fact_grant',reason:'Share',payload:{fact_id:project,fact_revision:1,destination:'-1000',wording:'A fact',private_evidence_confirmed:true}}),{code:'unknown_knowledge_field'});
});

test('a proposal saved before private chats were refused is read as saved and names them',()=>{
  const older=[{...organization(),assignments:[{...organization().assignments[0]!,space_id:'123'}]},
    {kind:'project_assignment',reason:'Move it',payload:{space_id:'123/topic/5',project_id:project,mode:'assigned',expected_revision:0}},
    {kind:'sharing_rule',reason:'Share',payload:{name:'Share',sources:['123','-1000'],destination:'-1001',enabled:true,mode:'approved',instructions:'',expected_revision:0}},
    {kind:'fact_grant',reason:'Share',payload:{fact_id:project,fact_revision:1,destination:'123',wording:'A fact'}}];
  assert.deepEqual(older.map(value=>proposalPrivateChats(parseKnowledgeProposal(value,{stored:true}))),[['123'],['123/topic/5'],['123'],['123']]);
  for(const value of older)assert.throws(()=>parseKnowledgeProposal(value),{code:/private/},'applying it re-checks it as new');
  assert.deepEqual(proposalPrivateChats(parseKnowledgeProposal({kind:'project_assignment',reason:'Keep it out',payload:{space_id:'123',mode:'none',expected_revision:1}})),[],'keeping a chat out names no private chat');
  // Everything else is still checked on a saved proposal.
  assert.throws(()=>parseKnowledgeProposal({kind:'project_assignment',reason:'Move it',payload:{space_id:'-1000/topic/0',project_id:project,mode:'assigned',expected_revision:0}},{stored:true}),{code:'invalid_space'});
  assert.throws(()=>parseKnowledgeProposal({kind:'project_assignment',reason:'Move it',payload:{space_id:'123',project_id:'not an id',mode:'assigned',expected_revision:0}},{stored:true}),{code:'invalid_knowledge_identity'});
});

test('learning drops a private chat\'s assignment and keeps the groups; only private ones propose nothing',()=>{
  const assignment=(space_id:string)=>({space_id,project_id:project,project_key:null,expected_revision:0,reason:'This chat exists for that project',purpose_evidence:true,evidence_ids:[source]});
  const kept=learnedOrganization({reason:'Evidence identifies a project',creates:null,assignments:[assignment('123'),assignment('-1000'),assignment('123/topic/4')]})!;
  assert.deepEqual(kept.assignments.map(a=>a.space_id),['-1000']);
  assert.equal(learnedOrganization({reason:'Only the owner',creates:null,assignments:[assignment('123')]}),null,'not an organization_batch_limit error');
  const created=learnedOrganization({reason:'A project',creates:[{key:'new_project',name:'Project Aurora',description:null,evidence_ids:[source]}],assignments:[assignment('123')]})!;
  assert.deepEqual([created.creates.length,created.assignments.length],[1,0]);
});

test('a topic always follows its group\'s project: a proposal never gives it one, and learning drops its assignment',()=>{
  const topic='-1000/topic/7',assignment=(space_id:string)=>({...organization().assignments[0]!,space_id});
  assert.throws(()=>parseKnowledgeProposal({...organization(),assignments:[assignment(topic)]}),{code:'project_topic_follows_group'});
  for(const mode of ['assigned','none'])
    assert.throws(()=>parseKnowledgeProposal({kind:'project_assignment',reason:'Move it',payload:{space_id:topic,mode,...(mode==='assigned'?{project_id:project}:{}),expected_revision:0}}),
      {code:'project_topic_follows_group'},mode);
  assert.equal(parseKnowledgeProposal({kind:'project_assignment',reason:'Follow the group',payload:{space_id:topic,mode:'inherit',expected_revision:1}}).kind,'project_assignment');
  // A proposal saved before that rule still opens as saved; applying it re-checks it as new.
  const older={kind:'project_assignment',reason:'Move it',payload:{space_id:topic,project_id:project,mode:'assigned',expected_revision:0}};
  assert.equal(parseKnowledgeProposal(older,{stored:true}).kind,'project_assignment');
  const learned=(space_id:string)=>({space_id,project_id:project,project_key:null,expected_revision:0,reason:'This chat exists for that project',purpose_evidence:true,evidence_ids:[source]});
  assert.deepEqual(learnedOrganization({reason:'A project',creates:null,assignments:[learned(topic),learned('-1000')]})!.assignments.map(a=>a.space_id),['-1000']);
  assert.equal(learnedOrganization({reason:'Only a topic',creates:null,assignments:[learned(topic)]}),null);
});
