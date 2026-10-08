import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {HttpError,object,string} from '../http.js';

export const ownerAutonomySchema=`
CREATE TABLE IF NOT EXISTS owner_autonomy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 mode text NOT NULL DEFAULT 'approval_required' CHECK(mode IN ('approval_required','owner_requests_execute')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO owner_autonomy(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS owner_autonomy_history (
 operation_id text PRIMARY KEY,revision integer NOT NULL UNIQUE,mode text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
`;
export type OwnerAutonomyMode='approval_required'|'owner_requests_execute';

/**
 * The owner's freedom level. By default every external effect waits for exact
 * owner approval. When enabled, a request the owner makes in their own live
 * private conversation is approved by that request; deny rules still apply.
 * Changing this setting changes no content, so it does not revoke contexts.
 */
export class OwnerAutonomyRepository {
  constructor(readonly control:pg.Pool){}
  async get(principal:Reader) {
    admin(principal);
    const row=(await this.control.query('SELECT mode,revision,updated_at FROM owner_autonomy WHERE singleton')).rows[0];
    const history=(await this.control.query('SELECT revision,mode,created_at FROM owner_autonomy_history ORDER BY revision DESC LIMIT 20')).rows;
    return {mode:row?.mode??'approval_required',revision:Number(row?.revision??0),updated_at:row?.updated_at??null,history};
  }
  async save(principal:Reader,input:unknown) {
    admin(principal);const body=object(input);
    if(Object.keys(body).some(key=>!['mode','expected_revision','operation_id'].includes(key))||!['approval_required','owner_requests_execute'].includes(String(body.mode))||
      !Number.isSafeInteger(body.expected_revision)||Number(body.expected_revision)<0)throw new HttpError(400,'invalid_owner_autonomy');
    const operation=string(body.operation_id,200),db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const prior=(await db.query('SELECT revision,mode FROM owner_autonomy_history WHERE operation_id=$1',[operation])).rows[0];
      if(prior){
        if(prior.mode!==body.mode||Number(prior.revision)!==Number(body.expected_revision)+1)throw new HttpError(409,'owner_autonomy_conflict');
        await db.query('COMMIT');return {mode:prior.mode,revision:Number(prior.revision)};
      }
      const row=(await db.query('SELECT revision FROM owner_autonomy WHERE singleton FOR UPDATE')).rows[0];
      if(Number(row.revision)!==Number(body.expected_revision))throw new HttpError(409,'owner_autonomy_conflict');
      const revision=Number(row.revision)+1;
      await db.query('UPDATE owner_autonomy SET mode=$1,revision=$2,updated_at=now() WHERE singleton',[body.mode,revision]);
      await db.query('INSERT INTO owner_autonomy_history(operation_id,revision,mode) VALUES($1,$2,$3)',[operation,revision,body.mode]);
      await db.query('COMMIT');return {mode:body.mode as OwnerAutonomyMode,revision};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
}

/** The authority string for an owner-private request, or null when approval is required. */
export async function ownerAutonomyGrant(db:pg.PoolClient,principal:Reader,turn:{owner?:boolean;job?:string|null}):Promise<string|null> {
  if(principal.admin||principal.scope!==null||(principal.purpose??'assistant')!=='assistant'||!turn.owner||turn.job)return null;
  const row=(await db.query('SELECT mode,revision FROM owner_autonomy WHERE singleton FOR SHARE')).rows[0];
  return row?.mode==='owner_requests_execute'?'owner_autonomy:'+row.revision:null;
}
