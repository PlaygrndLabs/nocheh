import type {Reader} from '../access.js';
import {admin} from '../access.js';
import {HttpError,object,string} from '../http.js';
import type {StorePools} from './connections.js';
import type {ArchiveRepository,SourceReference} from './archive.js';
import {OwnerCommands} from './owner-commands.js';

export const sourceRetirementSchema=`
CREATE TABLE IF NOT EXISTS source_retirements (
 object_id text PRIMARY KEY,retired boolean NOT NULL,revision integer NOT NULL CHECK(revision>0),
 event_id text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_retirement_history (
 object_id text NOT NULL,revision integer NOT NULL,retired boolean NOT NULL,
 event_id text NOT NULL,operation_id text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(object_id,revision)
);
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
  async get(principal:Reader,eventId:string) {
    admin(principal);const id=await this.identity(eventId);
    const state=(await this.stores.control.query('SELECT retired,revision,event_id,updated_at FROM source_retirements WHERE object_id=$1',[id])).rows[0];
    const history=(await this.stores.control.query('SELECT revision,retired,event_id,created_at FROM source_retirement_history WHERE object_id=$1 ORDER BY revision DESC',[id])).rows;
    return {event_id:eventId,source_object_id:id,retired:state?.retired??false,revision:state?.revision??0,
      authority:'owner',observation:'not_observed',updated_at:state?.updated_at??null,history};
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
