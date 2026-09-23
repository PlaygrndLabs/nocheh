import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {graphGroupLabel} from '../graph-labels.js';

type Row={scope:string;user_id?:string;payload:Buffer};
type Person={id:string;name:string|null;username:string|null};
type Group={id:string;name:string|null;users:Person[]};

const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const clean=(value:unknown)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,200):'';
const numeric=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)?String(value):typeof value==='string'&&/^[1-9]\d{0,18}$/.test(value)?value:'';
const body=(payload:Buffer)=>{try{return record(JSON.parse(payload.toString()));}catch{return {};}};
const message=(value:Record<string,unknown>)=>record(value.message??value.edited_message??value.channel_post??value.edited_channel_post);

/** Names come only from captured Telegram originals. An ID remains the authority. */
function person(value:unknown,id:string):Person|null {
  const actor=record(value);
  if(numeric(actor.id)!==id||actor.is_bot===true)return null;
  const name=[clean(actor.first_name),clean(actor.last_name)].filter(Boolean).join(' ')||null;
  const username=clean(actor.username).replace(/^@+/, '')||null;
  return {id,name,username:username?'@'+username:null};
}

export async function telegramDirectory(archive:pg.Pool,principal:Reader):Promise<{groups:Group[];truncated:boolean}> {
  admin(principal);
  const groupRows=(await archive.query<Row>(`SELECT DISTINCT ON (e.scope) e.scope,e.payload FROM events e
    WHERE e.channel='telegram' AND e.origin='live' AND e.kind='telegram_update'
      AND e.scope ~ '^-[1-9][0-9]{0,18}$'
      AND convert_from(e.payload,'UTF8')::jsonb ?| ARRAY['message','edited_message','channel_post','edited_channel_post']
    ORDER BY e.scope,e.received_at DESC,e.id DESC LIMIT 101`)).rows;
  const groups=groupRows.slice(0,100).map(row=>({id:row.scope,name:graphGroupLabel(row.payload,row.scope)??null,users:[] as Person[]}));
  if(!groups.length)return {groups,truncated:groupRows.length>100};
  const byGroup=new Map(groups.map(group=>[group.id,group]));
  const authors=(await archive.query<Row>(`SELECT DISTINCT ON (e.scope,o.external_id) e.scope,o.external_id AS user_id,e.payload
    FROM source_relations r JOIN source_objects o ON o.id=r.target_id JOIN events e ON e.id=r.event_id
    WHERE r.kind='authored_by' AND o.platform='telegram' AND o.namespace='bot-api' AND o.kind='actor'
      AND o.external_id ~ '^[1-9][0-9]{0,18}$' AND e.channel='telegram' AND e.origin='live' AND e.kind='telegram_update'
      AND e.scope=ANY($1::text[])
    ORDER BY e.scope,o.external_id,e.received_at DESC,e.id DESC LIMIT 5001`,[groups.map(group=>group.id)])).rows;
  const users=new Map(groups.map(group=>[group.id,new Map<string,Person>()]));
  for(const row of authors.slice(0,5000)) {
    const id=row.user_id??'',actor=message(body(row.payload)).from,found=person(actor,id);
    if(found)users.get(row.scope)?.set(id,found);
  }
  const arrivals=(await archive.query<Row>(`SELECT e.scope,e.payload FROM events e WHERE e.channel='telegram'
    AND e.origin='live' AND e.kind='telegram_update' AND e.scope=ANY($1::text[])
    AND (convert_from(e.payload,'UTF8')::jsonb #> '{message,new_chat_members}') IS NOT NULL
    ORDER BY e.received_at DESC,e.id DESC LIMIT 1001`,[groups.map(group=>group.id)])).rows;
  for(const row of arrivals.slice(0,1000)) {
    const members=message(body(row.payload)).new_chat_members;
    if(!Array.isArray(members))continue;
    const known=users.get(row.scope);if(!known)continue;
    for(const value of members.slice(0,100)) {
      const id=numeric(record(value).id),found=id?person(value,id):null;
      if(found&&!known.has(id))known.set(id,found);
    }
  }
  for(const group of groups)group.users=[...users.get(group.id)!.values()].sort((a,b)=>(a.name??a.username??a.id).localeCompare(b.name??b.username??b.id));
  return {groups,truncated:groupRows.length>100||authors.length>5000||arrivals.length>1000};
}
