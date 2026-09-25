import test from 'node:test';
import assert from 'node:assert/strict';
import {reactionPreview} from '../src/reaction-preview.js';

const reaction=(old_reaction:unknown,new_reaction:unknown)=>({message_reaction:{message_id:42,user:{id:7,first_name:'Alex'},old_reaction,new_reaction}});
const thumb={type:'emoji',emoji:'👍'},heart={type:'emoji',emoji:'❤️'};

test('reaction row preview distinguishes additions, changes, and removals',()=>{
  assert.deepEqual(reactionPreview('telegram_update',reaction([],[thumb])),{change:'Added 👍',actor:'Alex',target:'42'});
  assert.deepEqual(reactionPreview('telegram_update',reaction([thumb],[heart])),{change:'Changed 👍 → ❤️',actor:'Alex',target:'42'});
  assert.deepEqual(reactionPreview('telegram_update',reaction([heart],[])),{change:'Removed ❤️',actor:'Alex',target:'42'});
});

test('aggregate and incomplete reaction updates do not invent an actor or meaning',()=>{
  assert.deepEqual(reactionPreview('telegram_update',{message_reaction_count:{message_id:5,reactions:[{type:thumb,total_count:2}]}}),
    {change:'Counts: 👍 2',actor:null,target:'5'});
  assert.deepEqual(reactionPreview('telegram_update',reaction(null,[{type:'future',emoji:'?'}])),
    {change:'Reaction updated',actor:'Alex',target:'42'});
  assert.deepEqual(reactionPreview('telegram_update',{message_reaction:{message_id:5,actor_chat:{title:'Channel'},old_reaction:[],new_reaction:[{type:'future'}]}}),
    {change:'Added Unknown reaction',actor:'Channel',target:'5'});
  assert.equal(reactionPreview('telegram_update',{message:{message_id:5,text:'hello'}}),null);
});
