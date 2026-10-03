import {test} from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../src/archive.js';
import {parseKnowledgeProposal,organizationIdentity,type OrganizationProposal} from '../src/stores/knowledge-contract.js';

const source=digest('original-evidence'),project=digest('existing-project');
const organization=():OrganizationProposal=>({kind:'organization',reason:'Evidence identifies a project',creates:[{key:'new_project',name:'Project Aurora',description:'Evidence-backed project',evidence_ids:[source]}],
  assignments:[{space_id:'-1000/topic/7',project_key:'new_project',expected_revision:0,evidence_ids:[source],reason:'This topic exists for that project',purpose_evidence:true}]});

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
  b.assignments[0]!.space_id='-1000/topic/8';assert.notDeepEqual(organizationIdentity(a),organizationIdentity(b));
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
