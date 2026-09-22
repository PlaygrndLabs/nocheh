/** Keep compact graph labels human-readable without hiding distinct identities. */
export function evidenceNodeLabel(text:string|null|undefined,kind:string,id:string) {
  if(text)return text;
  const words=kind.replace(/[_-]+/g,' ').trim()||'observation';
  const readable=words[0]!.toUpperCase()+words.slice(1);
  return readable+' · '+id.slice(0,8);
}

const record=(value:unknown):Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const clean=(value:unknown):string=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,200):'';
const external=(value:unknown):string=>typeof value==='string'?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):'';
const payload=(value:unknown):Record<string,any>=>{
  try{return record(Buffer.isBuffer(value)?JSON.parse(value.toString()):typeof value==='string'?JSON.parse(value):value);}
  catch{return {};}
};
const message=(value:unknown):Record<string,any>=>{
  const body=payload(value);
  return record(body.message??body.edited_message??body.channel_post??body.edited_channel_post??body);
};
const username=(value:unknown):string=>{const name=clean(value).replace(/^@+/, '');return name?'@'+name:'';};
const personName=(value:Record<string,any>):string=>username(value.username)||[clean(value.first_name),clean(value.last_name)].filter(Boolean).join(' ');
const chatName=(value:Record<string,any>):string=>clean(value.title)||username(value.username)||[clean(value.first_name),clean(value.last_name)].filter(Boolean).join(' ');
export type GraphChatType='private'|'group'|'supergroup'|'channel';
const chat=(value:unknown):Record<string,any>=>{const body=payload(value),item=message(body);return record(body.chat??item.chat);};

/** Labels are presentation metadata from the same original Telegram observation; IDs remain authoritative. */
export function graphUserLabel(value:unknown,externalId:string):string|undefined {
  const body=payload(value),item=message(body),actor=record(item.from??item.sender??body.from);
  if(external(actor.id)===externalId)return personName(actor)||undefined;
  const senderChat=record(item.sender_chat);
  if(external(senderChat.id)===externalId)return chatName(senderChat)||undefined;
  return undefined;
}

export function graphGroupLabel(value:unknown,externalId:string):string|undefined {
  const item=chat(value);if(external(item.id)!==externalId)return undefined;
  const name=chatName(item);
  if(item.type==='private')return 'Private chat · '+(name||externalId);
  return name||undefined;
}

/** Telegram's chat subtype is presentation metadata; the graph entity remains a stable conversation node. */
export function graphChatType(value:unknown,externalId:string):GraphChatType|undefined {
  const item=chat(value);if(external(item.id)!==externalId)return undefined;
  const type=clean(item.type);
  return ['private','group','supergroup','channel'].includes(type)?type as GraphChatType:undefined;
}
