export interface ReactionPreview {change:string;actor:string|null;target:string}

const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const identifier=(value:unknown):string|null=>typeof value==='number'&&Number.isSafeInteger(value)?String(value):
  typeof value==='string'&&value.length>0&&value.length<256&&!/[\x00-\x1f\x7f]/.test(value)?value:null;
const reaction=(value:unknown):string=>{
  const item=object(value);
  if(item.type==='emoji'&&typeof item.emoji==='string'&&item.emoji.length<=16)return item.emoji;
  if(item.type==='custom_emoji')return 'Custom emoji'+(identifier(item.custom_emoji_id)?' #'+item.custom_emoji_id:'');
  if(item.type==='paid')return 'Paid reaction';
  return 'Unknown reaction';
};
const reactions=(value:unknown):string[]|null=>Array.isArray(value)&&value.length<=100?value.map(reaction):null;

/** An owner-facing summary of the observed update, without inferring reaction meaning or current state. */
export function reactionPreview(kind:string,payload:unknown):ReactionPreview|null {
  if(kind!=='telegram_update')return null;
  const body=object(payload),individual=body.message_reaction!==undefined;
  if(!individual&&body.message_reaction_count===undefined)return null;
  const update=object(individual?body.message_reaction:body.message_reaction_count);
  const target=identifier(update.message_id);
  if(!target)return null;
  const user=object(update.user),chat=object(update.actor_chat);
  const name=[user.first_name,user.last_name].filter(part=>typeof part==='string'&&part.length>0).join(' ').slice(0,120);
  const actor=individual?(name||
    (typeof user.username==='string'&&user.username?'@'+user.username:null)||
    (identifier(user.id)?'User #'+user.id:null)||
    (typeof chat.title==='string'&&chat.title?chat.title:null)||
    (identifier(chat.id)?'Chat #'+chat.id:null)):null;
  if(!individual){
    const counts=update.reactions;
    const values=Array.isArray(counts)&&counts.length<=100?counts.filter(item=>Number.isSafeInteger(object(item).total_count)&&Number(object(item).total_count)>=0)
      .map(item=>reaction(object(item).type)+' '+object(item).total_count):[];
    return {change:values.length?'Counts: '+values.join(' · '):'Counts updated',actor:null,target};
  }
  const before=reactions(update.old_reaction),after=reactions(update.new_reaction);
  if(!before||!after)return {change:'Reaction updated',actor,target};
  const removed=before.filter(value=>!after.includes(value)),added=after.filter(value=>!before.includes(value));
  const change=removed.length&&added.length?'Changed '+removed.join(', ')+' → '+added.join(', '):
    added.length?'Added '+added.join(', '):removed.length?'Removed '+removed.join(', '):'Reaction updated';
  return {change,actor,target};
}
