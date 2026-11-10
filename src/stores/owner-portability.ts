import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,object,string} from '../http.js';
import {limit} from '../retrieval.js';
import type {StorePools} from './connections.js';

/**
 * The owner's own work and choices in the control store, which the derivative
 * format does not carry: tasks, chat-to-project links, sharing rules, hidden
 * sources, learning choices, topic names, edited built-in texts and settings.
 * Rows travel as Postgres renders them and come back through
 * json_populate_record, so dates, times, arrays and decimals keep their type.
 *
 * Nothing imported can act on its own: sharing rules arrive switched off, and
 * reminders whose time has passed or whose sending was interrupted arrive
 * skipped. The freedom level, Telegram policy, grants, approvals and job
 * history stay out, as they do for derivatives.
 */
type Table={key:string[];singleton?:boolean;serial?:string};
// Parents before children. Projects and people arrive earlier, with the derivatives.
const tables:Record<string,Table>={
  owner_task_settings:{key:['singleton'],singleton:true},
  owner_tasks:{key:['id']},
  owner_task_people:{key:['task_id','role','entity_id']},
  owner_task_links:{key:['task_id','kind','other_id']},
  owner_task_reminders:{key:['id']},
  owner_task_comments:{key:['id']},
  owner_task_activity:{key:['id'],serial:'id'},
  owner_task_attachments:{key:['task_id','position']},
  project_assignments:{key:['space_id']},
  sharing_rules:{key:['id']},
  learning_consent:{key:['event_id']},
  source_retirements:{key:['object_id']},
  source_retirement_history:{key:['object_id','revision']},
  telegram_topic_registrations:{key:['chat_id','topic_id']},
  owner_prompts:{key:['singleton'],singleton:true},
  owner_notion:{key:['singleton'],singleton:true},
  background_settings:{key:['singleton'],singleton:true},
};
export const portableOwnerTables=Object.keys(tables);
export interface OwnerRecord {format:'nocheh-owner-record-v1';table:string;key:string[];row:Record<string,unknown>;sha256:string}
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const seal=(table:string,key:string[],row:Record<string,unknown>):OwnerRecord=>({format:'nocheh-owner-record-v1',table,key,row,sha256:digest(canonical({table,key,row}))});

function parse(input:unknown):{record:OwnerRecord;definition:Table} {
  const value=object(input),table=string(value.table,80),definition=Object.hasOwn(tables,table)?tables[table]:undefined;
  if(value.format!=='nocheh-owner-record-v1'||!definition)throw new HttpError(400,'invalid_owner_record');
  const row=object(value.row),key=value.key;
  if(!Array.isArray(key)||key.length!==definition.key.length||key.some((part,i)=>typeof part!=='string'||part.length>1024||String(row[definition.key[i]!])!==part))
    throw new HttpError(400,'invalid_owner_record_key');
  if(digest(canonical({table,key,row}))!==value.sha256)throw new HttpError(409,'owner_record_integrity');
  return {record:{format:'nocheh-owner-record-v1',table,key:key as string[],row,sha256:String(value.sha256)},definition};
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
    const parsed=inputs.map(parse);let added=0,unchanged=0,kept=0;
    const db=await this.stores.control.connect();
    try {
      for(const {record,definition} of parsed) {
        // A setting nobody changed on the old installation has nothing to bring.
        if(definition.singleton&&record.row.revision===0){unchanged++;continue;}
        const columns=await this.names(record.table),present=Object.keys(record.row);
        if(present.some(name=>!columns.includes(name)))throw new HttpError(400,'invalid_owner_record_fields');
        const row=this.safe(record.table,record.row),list=present.map(quote).join(','),
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
          await db.query('COMMIT');
          if(inserted)added++;else if(same?.same)unchanged++;else kept++;
        } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
      }
    } finally{db.release();}
    return {received:parsed.length,added,unchanged,kept,activated:false};
  }
  /** Imported rows never act by themselves. */
  private safe(table:string,row:Record<string,unknown>):Record<string,unknown> {
    if(table==='sharing_rules')return {...row,enabled:false};
    if(table==='owner_task_reminders') {
      const due=Date.parse(String(row.remind_at));
      if(row.state==='sending'||row.state==='uncertain'||row.state==='pending'&&!(due>Date.now()))return {...row,state:'skipped'};
    }
    return row;
  }
}
