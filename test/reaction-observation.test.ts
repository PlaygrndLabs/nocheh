import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reactionObservation} from '../src/reaction-observation.js';

test('reaction evidence distinguishes an observed removal from missing or aggregate state',()=>{
  assert.equal(reactionObservation({message:{text:'ordinary note'}}),null);
  assert.equal(reactionObservation({message_reaction:[]}),null);
  assert.deepEqual(reactionObservation({message_reaction:{date:1,user:{id:7},old_reaction:[{type:'emoji',emoji:'✅'}],new_reaction:[],unrelated:'private metadata'}}),
    {mode:'individual',date:1,user:{id:7},old_reaction:[{type:'emoji',emoji:'✅'}],new_reaction:[]});
  assert.deepEqual(reactionObservation({message_reaction:{date:2}}),{mode:'individual',date:2},'missing state is never invented as an empty list');
  assert.deepEqual(reactionObservation({message_reaction_count:{date:3,reactions:[],user:{id:7}}}),{mode:'aggregate',date:3,reactions:[]});
  assert.deepEqual(reactionObservation({message_reaction_count:{reactions:['x'.repeat(7000)]}}),{mode:'aggregate',unavailable:'observation_size_limit'});
});
