import {canonical,digest,type Envelope} from './archive.js';
import {telegramTopicId} from './spaces.js';
import {legacySource,sourceDescriptor,type SourceDescriptor,type SourceIdentity,type SourceRelation} from './source-model.js';

const record=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const external=(v:unknown):string|undefined=>typeof v==='number'&&Number.isSafeInteger(v)?String(v):
  typeof v==='string'&&v.length>0&&v.length<256&&!/[\x00-\x1f\x7f]/.test(v)?v:undefined;
export interface ObservedAudience {chat_id:string;topic_state:'known'|'none'|'unknown';topic_id?:string}
export interface ObservedReaction {
  mode:'individual'|'aggregate';date:string|null;sequence:string|null;
  before:Record<string,unknown>[]|null;after:Record<string,unknown>[]|null;
  added:Record<string,unknown>[]|null;removed:Record<string,unknown>[]|null;
  counts:{type:Record<string,unknown>;total_count:number}[]|null;
}
const messageIdentity=(chat:string,id:string):SourceIdentity=>({platform:'telegram',namespace:canonical(['bot-api','chat',chat]),kind:'message',external_id:id});
const conversation=(id:string):SourceIdentity=>({platform:'telegram',namespace:'bot-api',kind:'conversation',external_id:id});
function reactionList(value:unknown):Record<string,unknown>[]|null {
  if(!Array.isArray(value)||value.length>100)return null;
  // Unknown reaction types remain original observations, with no assigned meaning.
  if(value.some(v=>!v||typeof v!=='object'||Array.isArray(v)||typeof v.type!=='string'))return null;
  return value;
}
export function telegramMessageAudience(message:Record<string,any>,chatId:string):ObservedAudience {
  const thread=external(telegramTopicId(message)),chat=record(message.chat);
  if(thread)return {chat_id:chatId,topic_state:'known',topic_id:thread};
  // A reply chain's id in a chat that is provably not a forum is not a topic.
  if(external(message.message_thread_id)&&message.is_topic_message!==true&&
    (chat.type==='group'||chat.type==='private'||chat.type==='supergroup'&&chat.is_forum!==true))return {chat_id:chatId,topic_state:'none'};
  // Bot API omits both topic fields for General (see Client::get_forum_topic_id
  // and Client::is_topic_message). An incomplete/malformed topic marker is not
  // General. Reactions never enter this message-only normalization path.
  if(Object.hasOwn(message,'message_thread_id')||
    Object.hasOwn(message,'is_topic_message')&&message.is_topic_message!==false)
    return {chat_id:chatId,topic_state:'unknown'};
  if(chat.type==='supergroup')return {chat_id:chatId,topic_state:'none'};
  if(['private','group','channel'].includes(chat.type)||chat.is_forum===false)return {chat_id:chatId,topic_state:'none'};
  return {chat_id:chatId,topic_state:'unknown'};
}

// Telegram Desktop names a supergroup or channel by its bare id; the Bot API prefixes it with -100.
const desktopChannels=new Set(['private_supergroup','public_supergroup','private_channel','public_channel']);
const desktopActor=(value:unknown):SourceIdentity|undefined=>{
  const match=/^(user|channel)([1-9][0-9]{0,15})$/.exec(external(value)??'');
  return !match?undefined:match[1]==='user'?{platform:'telegram',namespace:'bot-api',kind:'actor',external_id:match[2]!}:conversation('-100'+match[2]);
};

/**
 * Desktop export identities that are proven, not guessed: a user or channel sender id is the same
 * account the bot sees, and a supergroup or channel numbers its messages once for everyone. So an
 * export mapped to that same live chat observes the live message objects. Basic groups number
 * messages per member, so their messages stay in the Desktop namespace.
 */
function desktopSource(value:Envelope,base:SourceDescriptor):SourceDescriptor {
  if(base.adapter!=='telegram.desktop')return base;
  const body=record(value.payload),chat=record(body.chat),id=external(chat.id),type=external(chat.type);
  const live=id&&type&&desktopChannels.has(type)&&/^[1-9][0-9]{0,15}$/.test(id)&&value.scope==='-100'+id?'-100'+id:undefined;
  const relations=base.relations.map(relation=>{
    if(relation.kind==='authored_by'){const target=desktopActor(record(body.message).from_id);return target?{...relation,target}:relation;}
    if(!live)return relation;
    if(relation.kind==='contained_in')return {...relation,target:conversation(live)};
    if(relation.kind==='reply_to'||relation.kind==='in_thread')return {...relation,target:{...messageIdentity(live,relation.target.external_id),kind:relation.target.kind}};
    return relation;
  });
  const descriptor:SourceDescriptor={...base,adapter_version:'2',object:live?messageIdentity(live,base.object.external_id):base.object,relations};
  try{return sourceDescriptor(descriptor);}catch{return base;}
}

/** New projection only. Frozen legacy projections and every original byte stay intact. */
export function observedSource(value:Envelope):SourceDescriptor {
  if(value.source)return value.source;
  const fallback=legacySource(value),body=record(value.payload);
  if((value.channel??'telegram')==='telegram'&&value.kind.startsWith('telegram_desktop_'))return desktopSource(value,fallback);
  if((value.channel??'telegram')!=='telegram'||!['telegram_update','telegram_delivered_message'].includes(value.kind))return fallback;
  const change=record(body.message_reaction??body.message_reaction_count),chatId=external(record(change.chat).id),target=external(change.message_id);
  if(chatId&&target) {
    const aggregate=body.message_reaction_count!==undefined;
    const before=aggregate?null:reactionList(change.old_reaction),after=aggregate?null:reactionList(change.new_reaction);
    const difference=(a:Record<string,unknown>[]|null,b:Record<string,unknown>[]|null)=>a&&b?a.filter(v=>!b.some(w=>canonical(w)===canonical(v))):null;
    const rawCounts=change.reactions;
    const counts=aggregate&&Array.isArray(rawCounts)&&rawCounts.length<=100&&rawCounts.every(v=>
      reactionList([v?.type])&&Number.isSafeInteger(v?.total_count)&&v.total_count>=0)?rawCounts:null;
    const reaction:ObservedReaction={mode:aggregate?'aggregate':'individual',date:external(change.date)??null,
      sequence:external(body.update_id)??null,before,after,added:difference(after,before),removed:difference(before,after),counts};
    const relations:SourceRelation[]=[{kind:'contained_in',target:conversation(chatId)},{kind:'reaction_to',target:messageIdentity(chatId,target)}];
    const user=external(record(change.user).id),actorChat=external(record(change.actor_chat).id);
    if(user)relations.push({kind:'authored_by',target:{platform:'telegram',namespace:'bot-api',kind:'actor',external_id:user}});
    else if(actorChat)relations.push({kind:'authored_by',target:conversation(actorChat)});
    const descriptor:SourceDescriptor={version:1,adapter:'telegram.bot-api',adapter_version:'2',
      object:{platform:'telegram',namespace:canonical(['bot-api','updates',value.bot_id]),kind:aggregate?'reaction_counts':'reaction_change',
        external_id:external(body.update_id)??digest(value.key)},operation:aggregate?'reaction_counts':'reaction_change',completeness:'partial',relations,
      metadata:{audience:{chat_id:chatId,topic_state:'unknown'},reaction},provenance:{connector_id:value.bot_id}};
    // Malformed or future payloads are always captured; unsupported normalization cannot block the spool.
    try{return sourceDescriptor(descriptor);}catch{return fallback;}
  }
  const message=record(body.message??body.edited_message??body.channel_post??body.edited_channel_post),chat=external(record(message.chat).id),id=external(message.message_id);
  if(!chat||!id)return fallback;
  const base=value.kind==='telegram_delivered_message'?legacySource({...value,kind:'telegram_update',source_id:id}):fallback;
  const relations=[...base.relations];
  const foreign=record(message.external_reply),foreignChat=external(record(foreign.chat).id),foreignId=external(foreign.message_id);
  if(foreignChat&&foreignId&&!relations.some(r=>r.kind==='reply_to'&&canonical(r.target)===canonical(messageIdentity(foreignChat,foreignId))))
    relations.push({kind:'reply_to',target:messageIdentity(foreignChat,foreignId),metadata:{external:true}});
  const descriptor:SourceDescriptor={...base,adapter_version:'3',relations,
    metadata:{...base.metadata,audience:telegramMessageAudience(message,chat)},completeness:'full'};
  try{return sourceDescriptor(descriptor);}catch{return fallback;}
}
