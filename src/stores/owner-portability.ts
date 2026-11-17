import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {limit} from '../retrieval.js';
import type {StorePools} from './connections.js';
import {chats as directory} from '../chats.js';
import {legacyChat,legacyChatValue} from '../chats-telegram.js';
import {ChatSeeder,chatValuesOf} from './chat-seed.js';
import {assertChatDirectory,bumpChatRevision,ensureConnection,reloadChats} from './chats.js';

/**
 * The owner's own work and choices in the control store, which the derivative
 * format does not carry: tasks, chat-to-project links, sharing rules, hidden
 * sources, learning choices, the chats and their app ids with the names the
 * owner gave topics, edited built-in texts, settings and the tool switches of each chat.
 * Rows travel as Postgres renders them and come back through
 * json_populate_record, so dates, times, arrays and decimals keep their type.
 *
 * Nothing imported can act on its own: sharing rules arrive switched off, tool
 * switches arrive off or inherited, and reminders whose time has passed or
 * whose sending was interrupted arrive skipped, and chats arrive off until the owner turns them on here.
 * The freedom level, Telegram policy, grants, approvals and job history stay out, as they do for derivatives.
 * A reminder keeps who set it and where, and a task who last wrote it where, by account (ADR-0255); the names people
 * wrote for themselves stay out, and so do people's merged reminders, which are a send log.
 *
 * Chats (ADR-0252): a chat keeps its Nocheh id, so every row naming it means the same chat here. A record exported
 * before step 2b names chats by the old values and carries topic names as telegram_topic_registrations; on import
 * each chat it names gets its row the way the seeder gives one, and a topic name becomes that topic's row.
 */
type Table={key:string[];singleton?:boolean;serial?:string};
// Parents before children. Projects and people arrive earlier, with the derivatives. Chats come in kind order, so a
// topic follows its chat.
const tables:Record<string,Table>={
  chats:{key:['kind','id']},
  chat_ids:{key:['connection_id','external_id']},
  owner_task_settings:{key:['singleton'],singleton:true},
  owner_tasks:{key:['id']},
  owner_task_people:{key:['task_id','role','entity_id']},
  owner_task_links:{key:['task_id','kind','other_id']},
  owner_task_reminders:{key:['id']},
  owner_task_writers:{key:['task_id','field']},
  owner_task_comments:{key:['id']},
  owner_task_activity:{key:['id'],serial:'id'},
  owner_task_attachments:{key:['task_id','position']},
  project_assignments:{key:['space_id']},
  sharing_rules:{key:['id']},
  learning_consent:{key:['event_id']},
  source_retirements:{key:['object_id']},
  source_retirement_history:{key:['object_id','revision']},
  owner_prompts:{key:['singleton'],singleton:true},
  owner_notion:{key:['singleton'],singleton:true},
  background_settings:{key:['singleton'],singleton:true},
  chat_tool_settings:{key:['space_id']},
};
export const portableOwnerTables=Object.keys(tables);
/** Tables of older records that import into the current ones. */
const formerTables:Record<string,Table>={telegram_topic_registrations:{key:['chat_id','topic_id']}};
export interface OwnerRecord {format:'nocheh-owner-record-v1';table:string;key:string[];row:Record<string,unknown>;sha256:string}
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const seal=(table:string,key:string[],row:Record<string,unknown>):OwnerRecord=>({format:'nocheh-owner-record-v1',table,key,row,sha256:digest(canonical({table,key,row}))});

function parse(input:unknown):{record:OwnerRecord;definition:Table} {
  const value=object(input),table=string(value.table,80),definition=Object.hasOwn(tables,table)?tables[table]:Object.hasOwn(formerTables,table)?formerTables[table]:undefined;
  if(value.format!=='nocheh-owner-record-v1'||!definition)throw new HttpError(400,'invalid_owner_record');
  const row=object(value.row),key=value.key;
  if(!Array.isArray(key)||key.length!==definition.key.length||key.some((part,i)=>typeof part!=='string'||part.length>1024||String(row[definition.key[i]!])!==part))
    throw new HttpError(400,'invalid_owner_record_key');
  if(digest(canonical({table,key,row}))!==value.sha256)throw new HttpError(409,'owner_record_integrity');
  return {record:{format:'nocheh-owner-record-v1',table,key:key as string[],row,sha256:String(value.sha256)},definition};
}

/**
 * A record exported before projects stopped sharing between their groups, converted as starting the stores converts
 * the rows they hold (ADR-0247): a rule a project's share box kept is not brought at all (null), never as the owner's
 * own; an owner's rule and a chat's project lose the share box's fields; and a topic's own project choice becomes
 * "follows its group". Any other record, or one already in the current form, is returned as it is.
 */
export function retire(table:string,row:Record<string,unknown>):Record<string,unknown>|null {
  if(table==='sharing_rules'&&'project_id' in row){
    const {project_id:project,...rest}=row;
    return project===null||project===undefined?rest:null;
  }
  // A reminder exported before reminders named who set them was the owner's.
  if(table==='owner_task_reminders'&&!('set_by' in row))return {...row,set_by:'owner'};
  if(table==='project_assignments'){
    const {share_into:_share,...rest}=row;
    const topic=legacyChat(rest.space_id)?.kind==='topic'||directory().kind(rest.space_id as string)==='topic';
    return topic&&rest.mode!=='inherit'?{...rest,mode:'inherit',project_id:null}:rest;
  }
  return row;
}

export class OwnerPortabilityRepository {
  private columns=new Map<string,string[]>();
  constructor(readonly stores:StorePools){}
  private async names(table:string):Promise<string[]> {
    let names=this.columns.get(table);
    if(!names) {
      names=(await this.stores.control.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position`,[table])).rows.map(r=>String(r.column_name));
      if(!names.length)throw new HttpError(500,'owner_table_missing');
      this.columns.set(table,names);
    }
    return names;
  }
  /** One table, in key order. The cursor is the last key, as text. */
  async page(principal:Reader,table:string,after:string|null,count=50) {
    admin(principal);limit(count,50,100);
    const definition=Object.hasOwn(tables,table)?tables[table]:undefined;if(!definition)throw new HttpError(400,'invalid_owner_table');
    let cursor:string[]|null=null;
    if(after) {
      try{cursor=JSON.parse(string(after,4096));}catch{cursor=null;}
      if(!Array.isArray(cursor)||cursor.length!==definition.key.length||cursor.some(part=>typeof part!=='string')||definition.serial&&!/^\d{1,18}$/.test(cursor[0]!))throw new HttpError(400,'invalid_export_cursor');
    }
    // A log keeps its numeric order, so the destination numbers its rows in the same order.
    const keys=definition.serial?[`t.${quote(definition.serial)}`]:definition.key.map(name=>`t.${quote(name)}::text COLLATE "C"`),
      where=cursor?`WHERE (${keys.join(',')})>(${cursor.map((_,i)=>definition.serial?`$${i+2}::bigint`:`$${i+2}::text COLLATE "C"`).join(',')})`:'',
      rows=(await this.stores.control.query(`SELECT row_to_json(t)::text AS row FROM ${table} t ${where} ORDER BY ${keys.join(',')} LIMIT $1`,[count,...(cursor??[])])).rows;
    const records=rows.map(r=>{const row=JSON.parse(r.row as string) as Record<string,unknown>;return seal(table,definition.key.map(name=>String(row[name])),row);});
    return {format:'nocheh-owner-data-v1',table,records,next:rows.length===count?JSON.stringify(records.at(-1)!.key):null};
  }
  /** Add rows that are not here yet. A row already here with other content is
   * kept as it is and reported, except a setting nobody has changed yet. */
  async restore(principal:Reader,inputs:unknown[]) {
    admin(principal);if(!Array.isArray(inputs)||!inputs.length||inputs.length>100)throw new HttpError(400,'portable_batch_limit');
    const parsed=inputs.map(parse);let added=0,unchanged=0,kept=0,chatsAdded=false;
    // Every chat an older record names gets its row first, off until the owner turns it on here (ADR-0253).
    const seeder=new ChatSeeder(this.stores,{owner_id:null}),names=new Map<string,{title:string;source:'owner'}>();
    for(const {record} of parsed) {
      for(const value of chatValuesOf(record.table,record.row))seeder.value(value);
      if(record.table==='telegram_topic_registrations')try {
        const topic=legacyChatValue(String(record.row.chat_id),Number(record.row.topic_id));seeder.value(topic);
        if(typeof record.row.name==='string'&&record.row.name.trim())names.set(topic,{title:record.row.name.replace(/\s+/g,' ').trim().slice(0,128),source:'owner'});
      } catch{throw new HttpError(400,'invalid_owner_record_value');}
    }
    // The topics named here that had no row yet: seeding gives them the owner's name, which counts as added.
    const before=new Set(seeder.plan.size?(await this.stores.control.query('SELECT id FROM chats WHERE id=ANY($1::text[])',[[...names.keys()]])).rows.map(row=>row.id as string):[]);
    if(seeder.plan.size){const seeded=await seeder.values([],names);chatsAdded=seeded.chats+seeded.topics>0;}
    if(parsed.some(({record})=>record.table==='chats'||record.table==='chat_ids'))await ensureConnection(this.stores.control);
    const db=await this.stores.control.connect();
    try {
      for(const {record,definition} of parsed) {
        // A topic name from before step 2b is its topic's row now, named by the owner. A topic already here takes it
        // unless the owner here named it otherwise.
        if(record.table==='telegram_topic_registrations') {
          const topic=legacyChatValue(String(record.row.chat_id),Number(record.row.topic_id)),wanted=names.get(topic)?.title??null;
          const row=(await db.query(`SELECT c.id,c.title,c.title_source FROM chat_ids i JOIN chats p ON p.id=i.chat_id
            JOIN chats c ON c.parent_id=p.id AND c.topic_key=$2 WHERE i.external_id=$1`,[String(record.row.chat_id),String(record.row.topic_id)])).rows[0];
          if(!row||!wanted)kept++;
          else if(row.title_source==='owner')row.title!==wanted?kept++:before.has(row.id)?unchanged++:added++;
          else{await db.query(`UPDATE chats SET title=$2,title_source='owner',updated_at=now() WHERE id=$1 AND title_source IS DISTINCT FROM 'owner'`,[row.id,wanted]);added++;}
          continue;
        }
        // A setting nobody changed on the old installation has nothing to bring.
        if(definition.singleton&&record.row.revision===0){unchanged++;continue;}
        // A record from before projects stopped sharing comes back as the stores convert their own rows (ADR-0247).
        const retired=retire(record.table,record.row);
        if(!retired){unchanged++;continue;}
        const columns=await this.names(record.table),present=Object.keys(retired);
        if(present.some(name=>!columns.includes(name)))throw new HttpError(400,'invalid_owner_record_fields');
        const row=this.safe(record.table,retired),list=present.map(quote).join(','),
          match=definition.key.map((name,i)=>`t.${quote(name)}::text=$${i+2}`).join(' AND ');
        await db.query('BEGIN');
        try {
          await db.query('SAVEPOINT owner_row');
          let inserted:number;
          try {
            if(definition.serial) {
              // A log row gets a new number here; an identical row already here is the same entry.
              const others=present.filter(name=>name!==definition.serial).map(quote);
              inserted=(await db.query(`INSERT INTO ${record.table}(${others.join(',')}) SELECT ${others.map(n=>'x.'+n).join(',')} FROM json_populate_record(NULL::${record.table},$1::json) x
                WHERE NOT EXISTS(SELECT 1 FROM ${record.table} t WHERE (${others.map(n=>'t.'+n).join(',')}) IS NOT DISTINCT FROM (${others.map(n=>'x.'+n).join(',')}))`,[JSON.stringify(row)])).rowCount??0;
              await db.query('COMMIT');if(inserted)added++;else unchanged++;continue;
            }
            inserted=(await db.query(`INSERT INTO ${record.table}(${list}) SELECT ${list} FROM json_populate_record(NULL::${record.table},$1::json) ON CONFLICT DO NOTHING`,[JSON.stringify(row)])).rowCount??0;
          } catch(error) {
            await db.query('ROLLBACK TO SAVEPOINT owner_row');
            if((error as {code?:string}).code==='23503')throw new HttpError(409,record.table==='owner_tasks'&&row.parent_id?'portable_parent_pending':'owner_reference_missing');
            if((error as {code?:string}).code==='23505')throw new HttpError(409,'owner_identity_conflict');
            if(['23502','23514','22P02','22007','22008'].includes((error as {code?:string}).code??''))throw new HttpError(400,'invalid_owner_record_value');
            throw error;
          }
          if(!inserted&&definition.singleton) {
            // A fresh installation already has the default row; replace it only while nobody has changed it.
            inserted=(await db.query(`UPDATE ${record.table} t SET (${list})=(SELECT ${list} FROM json_populate_record(NULL::${record.table},$1::json)) WHERE t.revision=0`,[JSON.stringify(row)])).rowCount??0;
          }
          const same=(await db.query(`SELECT (SELECT to_jsonb(x) FROM json_populate_record(NULL::${record.table},$1::json) x)-$${definition.key.length+2}::text[]
            =to_jsonb(t)-$${definition.key.length+2}::text[] AS same FROM ${record.table} t WHERE ${match}`,[JSON.stringify(row),...record.key,columns.filter(name=>!present.includes(name))])).rows[0];
          // A chat row from elsewhere must leave a directory every process can still load (ADR-0252).
          if(inserted&&(record.table==='chats'||record.table==='chat_ids')){
            await assertChatDirectory(db).catch(error=>{throw error instanceof HttpError?new HttpError(400,'invalid_owner_record_value'):error;});
            await bumpChatRevision(db);chatsAdded=true;
          }
          await db.query('COMMIT');
          if(inserted)added++;else if(same?.same)unchanged++;else kept++;
        } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
      }
    } finally{db.release();}
    if(chatsAdded)await reloadChats();
    return {received:parsed.length,added,unchanged,kept,activated:false};
  }
  /** Imported rows never act by themselves. */
  private safe(table:string,row:Record<string,unknown>):Record<string,unknown> {
    if(table==='sharing_rules')return {...row,enabled:false};
    // A chat arrives off and names no person, add or update order of this installation's: an import never turns a chat on
    // or counts as an add, and only the owner turns it on here (ADR-0253). Only a name the owner gave travels: a name
    // Telegram showed was written by the chat's people, maybe strangers.
    if(table==='chats')return {...row,state:'off',account_id:null,added_by_account_id:null,add_event:null,state_seq:null,state_bot:null,state_at:null,
      ...(row.title_source==='owner'?{}:{title:null,title_source:null})};
    // A tool switch arrives off or inherited, never on: an import never turns a tool on that this installation turned off.
    // Only a real false stays off; anything else, such as "t" or 1 that the database would read as on, arrives inherited.
    if(table==='chat_tool_settings')return Object.fromEntries(Object.entries(row).map(([key,value])=>
      [key,['shell','browser','mcp'].includes(key)?(value===false?false:null):key==='revision'?1:value]));
    // A name a person wrote for themselves stays out (labels read the name their account has here); a merged message's
    // id and the tries of a send belong to the installation that sent it.
    if(table==='owner_task_reminders') {
      const due=Date.parse(String(row.remind_at)),cleared={...row,set_by_name:null,batch_id:null,tries:0};
      if(row.state==='sending'||row.state==='uncertain'||row.state==='pending'&&!(due>Date.now()))return {...cleared,state:'skipped'};
      return cleared;
    }
    if(table==='owner_task_writers')return {...row,name:null};
    return row;
  }
}
