import type {Reader} from '../access.js';
import {admin} from '../access.js';
import {HttpError,object,string} from '../http.js';
import type {StorePools} from './connections.js';
import type {ArchiveRepository,SourceReference} from './archive.js';
import {OwnerCommands} from './owner-commands.js';
import {archiveReplyPreviews} from './archive-reply-links.js';

/** Verbatim excerpts long enough to identify a reply that repeats a message. */
export function quotedExcerpts(text:string):string[] {
  const whole=text.trim(),parts=whole.split(/[\n.!?؟]+/).map(part=>part.trim()).filter(part=>part.length>=16);
  return [...new Set([...(whole.length>=12?[whole]:[]),...parts])].map(part=>part.slice(0,500)).sort((a,b)=>b.length-a.length).slice(0,10);
}

export const sourceRetirementSchema=`
CREATE TABLE IF NOT EXISTS source_retirements (
 object_id text PRIMARY KEY,retired boolean NOT NULL,revision integer NOT NULL CHECK(revision>0),
 event_id text NOT NULL,decision_authority text NOT NULL DEFAULT 'owner' CHECK(decision_authority='owner'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_retirement_history (
 object_id text NOT NULL,revision integer NOT NULL,retired boolean NOT NULL,
 event_id text NOT NULL,operation_id text NOT NULL UNIQUE,
 decision_authority text NOT NULL DEFAULT 'owner' CHECK(decision_authority='owner'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(object_id,revision)
);
ALTER TABLE source_retirements ADD COLUMN IF NOT EXISTS decision_authority text NOT NULL DEFAULT 'owner' CHECK(decision_authority='owner');
ALTER TABLE source_retirement_history ADD COLUMN IF NOT EXISTS decision_authority text NOT NULL DEFAULT 'owner' CHECK(decision_authority='owner');
`;

/** A retirement is an owner control decision, never an observed Telegram deletion. */
export class SourceRetirementRepository {
  constructor(readonly stores:StorePools,readonly archive:ArchiveRepository){}
  private async identity(eventId:string):Promise<string> {
    const row=(await this.archive.pool.query(`SELECT r.object_id FROM events e
      JOIN source_observations o ON o.event_id=e.id JOIN source_revisions r ON r.id=o.revision_id
      JOIN source_objects s ON s.id=r.object_id WHERE e.id=$1 AND e.channel='telegram' AND s.platform='telegram' AND s.kind='message'`,[eventId])).rows[0];
    if(!row)throw new HttpError(404,'telegram_message_not_found');return row.object_id;
  }
  async events(eventId:string):Promise<string[]> {
    const id=await this.identity(eventId);
    return (await this.archive.pool.query(`SELECT o.event_id FROM source_observations o
      JOIN source_revisions r ON r.id=o.revision_id WHERE r.object_id=$1`,[id])).rows.map(row=>row.event_id as string);
  }
  async retiredEvents(eventIds:string[]):Promise<Set<string>> {
    if(!eventIds.length)return new Set();
    const identities=(await this.archive.pool.query(`SELECT o.event_id,r.object_id FROM source_observations o
      JOIN source_revisions r ON r.id=o.revision_id JOIN source_objects x ON x.id=r.object_id
      WHERE o.event_id=ANY($1::text[]) AND x.platform='telegram' AND x.kind='message'`,[eventIds])).rows;
    if(!identities.length)return new Set();
    const retired=(await this.stores.control.query('SELECT object_id FROM source_retirements WHERE retired=true AND object_id=ANY($1::text[])',
      [identities.map(row=>row.object_id)])).rows;
    const objects=new Set(retired.map(row=>row.object_id));
    return new Set(identities.filter(row=>objects.has(row.object_id)).map(row=>row.event_id));
  }
  async isRetired(reference:SourceReference):Promise<boolean> {
    const rows=(await this.archive.pool.query(`SELECT r.object_id FROM source_observations o
      JOIN source_revisions r ON r.id=o.revision_id WHERE o.event_id=$1
      UNION SELECT target_id AS object_id FROM source_relations WHERE event_id=$1 AND kind='reaction_to'`,[reference.id])).rows;
    if(!rows.length)return false;
    return (await this.stores.control.query('SELECT 1 FROM source_retirements WHERE object_id=ANY($1::text[]) AND retired=true LIMIT 1',
      [rows.map(row=>row.object_id)])).rowCount!==0;
  }
  /**
   * Native Hermes history keeps its own copy of each turn. For the incoming
   * events recorded there, report which are retired (directly or as a reaction
   * to a retired message) and which have a retired delivered reply. The
   * revision changes with every retirement decision, so an unchanged revision
   * means nothing in native history needs rechecking.
   */
  async historyRetirements(eventIds:string[]) {
    const revision=String((await this.stores.control.query(`SELECT count(*)::text||':'||coalesce(max(created_at)::text,'') AS revision
      FROM source_retirement_history`)).rows[0].revision);
    if(!eventIds.length)return {revision,retired:[] as string[],answered:[] as string[]};
    const retired=await this.retiredEvents(eventIds);
    const reactions=(await this.archive.pool.query(`SELECT event_id,target_id FROM source_relations
      WHERE event_id=ANY($1::text[]) AND kind='reaction_to'`,[eventIds])).rows;
    if(reactions.length) {
      const targets=new Set((await this.stores.control.query('SELECT object_id FROM source_retirements WHERE retired=true AND object_id=ANY($1::text[])',
        [reactions.map(row=>row.target_id)])).rows.map(row=>row.object_id));
      for(const row of reactions)if(targets.has(row.target_id))retired.add(row.event_id);
    }
    const records=(await this.archive.pool.query(`SELECT id,kind,scope FROM events WHERE id=ANY($1::text[]) AND kind='telegram_update'`,[eventIds])).rows;
    const replies=await archiveReplyPreviews(this.archive.pool,this.stores.control,records);
    const retiredReplies=await this.retiredEvents([...replies.values()].flat().map(reply=>reply.id));
    const answered=[...replies].filter(([,previews])=>previews.some(reply=>retiredReplies.has(reply.id))).map(([id])=>id);
    return {revision,retired:[...retired].sort(),answered:answered.sort()};
  }
  async get(principal:Reader,eventId:string) {
    admin(principal);const id=await this.identity(eventId);
    const state=(await this.stores.control.query('SELECT retired,revision,event_id,decision_authority,updated_at FROM source_retirements WHERE object_id=$1',[id])).rows[0];
    const history=(await this.stores.control.query('SELECT revision,retired,event_id,decision_authority,created_at FROM source_retirement_history WHERE object_id=$1 ORDER BY revision DESC',[id])).rows;
    return {event_id:eventId,source_object_id:id,retired:state?.retired??false,revision:state?.revision??0,
      authority:state?.decision_authority??'owner',observation:'not_observed',updated_at:state?.updated_at??null,history,
      related_replies:await this.relatedReplies(eventId)};
  }
  /**
   * Delivered assistant replies the owner may also want to retire: the direct
   * reply to any revision of this message, and later replies in the same
   * conversation that repeat a substantial verbatim excerpt of it. Offered
   * only; retiring a message never retires another implicitly.
   */
  async relatedReplies(eventId:string) {
    const events=await this.events(eventId);
    const rows=(await this.archive.pool.query(`SELECT id,kind,scope,received_at,original_text FROM events WHERE id=ANY($1::text[])`,[events])).rows;
    if(!rows.length||rows[0].kind!=='telegram_update')return [];
    const scope=rows[0].scope,since=rows.reduce((first,row)=>row.received_at<first?row.received_at:first,rows[0].received_at);
    const related=new Map<string,'reply'|'quote'>();
    for(const previews of (await archiveReplyPreviews(this.archive.pool,this.stores.control,rows)).values())
      for(const preview of previews)related.set(preview.id,'reply');
    const excerpts=[...new Set(rows.flatMap(row=>quotedExcerpts(row.original_text?.toString()??'')))].slice(0,10);
    if(excerpts.length) {
      const quotes=(await this.archive.pool.query(`SELECT id FROM events WHERE scope=$1 AND kind='telegram_delivered_message' AND received_at>=$2
        AND EXISTS (SELECT 1 FROM unnest($3::text[]) AS excerpt WHERE strpos(search_text,excerpt)>0) ORDER BY received_at DESC LIMIT 50`,
        [scope,since,excerpts])).rows;
      for(const row of quotes)if(!related.has(row.id))related.set(row.id,'quote');
    }
    if(!related.size)return [];
    const replies=(await this.archive.pool.query(`SELECT id,original_text,received_at FROM events WHERE id=ANY($1::text[]) ORDER BY received_at,id`,[[...related.keys()]])).rows;
    const retired=await this.retiredEvents(replies.map(row=>row.id));
    const result=[];
    for(const reply of replies) {
      let revision=0;
      try{revision=(await this.stores.control.query('SELECT revision FROM source_retirements WHERE object_id=$1',[await this.identity(reply.id)])).rows[0]?.revision??0;}
      catch(error){if(error instanceof HttpError&&error.status===404)continue;throw error;}
      result.push({event_id:reply.id,relation:related.get(reply.id),text:reply.original_text?.toString().slice(0,300)??null,
        received_at:reply.received_at.toISOString(),retired:retired.has(reply.id),revision});
    }
    return result;
  }
  async set(principal:Reader,eventId:string,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['retired','expected_revision','operation_id'].includes(key))||typeof body.retired!=='boolean'||
      !Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<0)throw new HttpError(400,'invalid_source_retirement');
    const id=await this.identity(eventId),operationId=string(body.operation_id,200);
    const messageEvents=await this.events(eventId);
    const result=await new OwnerCommands(this.stores.control).run(principal,operationId,
      {kind:'source_retirement',object_id:id,event_id:eventId,retired:body.retired,expected_revision:body.expected_revision},async db=>{
        const state=(await db.query('SELECT revision FROM source_retirements WHERE object_id=$1 FOR UPDATE',[id])).rows[0];
        if((state?.revision??0)!==body.expected_revision)throw new HttpError(409,'source_retirement_conflict');
        const revision=Number(body.expected_revision)+1;
        await db.query(`INSERT INTO source_retirements(object_id,retired,revision,event_id) VALUES($1,$2,$3,$4)
          ON CONFLICT(object_id) DO UPDATE SET retired=$2,revision=$3,event_id=$4,updated_at=now()`,[id,body.retired,revision,eventId]);
        await db.query('INSERT INTO source_retirement_history(object_id,revision,retired,event_id,operation_id) VALUES($1,$2,$3,$4,$5)',
          [id,revision,body.retired,eventId,operationId]);
        if(body.retired)await db.query(`UPDATE dispatches SET state='cancelled',error_code='source_retired',revision=revision+1,updated_at=now()
          WHERE event_id=ANY($1::text[]) AND state IN ('pending','failed') AND attempts=0`,[messageEvents]);
        return {event_id:eventId,source_object_id:id,retired:body.retired,revision,authority:'owner',observation:'not_observed'};
      });
    return result;
  }
}
