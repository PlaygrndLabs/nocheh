import {blockingPublications} from './publications.js';
import type pg from 'pg';
import {groupAccess,type AssistantPolicy} from '../assistant-policy.js';
import {canonical,digest} from '../archive.js';
import {HttpError} from '../http.js';
import {requestWorkflow} from '../workflows/store.js';

export const runtimeConfigurationSchema=`
CREATE TABLE IF NOT EXISTS runtime_configuration_versions (
 name text NOT NULL,revision integer NOT NULL,document jsonb NOT NULL,fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(name,revision)
);
CREATE TABLE IF NOT EXISTS runtime_configuration (
 name text PRIMARY KEY,revision integer NOT NULL,
 FOREIGN KEY(name,revision) REFERENCES runtime_configuration_versions(name,revision)
);
`;
function policyDocument(policy:AssistantPolicy):AssistantPolicy {
  if(typeof policy.enabled!=='boolean'||policy.owner_id!==null&&(typeof policy.owner_id!=='string'||!/^[1-9]\d{0,18}$/.test(policy.owner_id))||
    !Array.isArray(policy.group_ids)||policy.group_ids.some(id=>typeof id!=='string'||!/^-[1-9]\d{0,18}$/.test(id))||policy.enabled&&!policy.owner_id)
    throw new HttpError(400,'invalid_assistant_policy');
  const groups=[...new Set(policy.group_ids)].sort();
  return {enabled:policy.enabled,owner_id:policy.owner_id,group_ids:groups,
    group_access:groupAccess(policy.group_access??{},groups,policy.owner_id)};
}

/** Saved installation setup is admitted into control before a runtime can use it. */
export class RuntimeConfigurationRepository {
  constructor(readonly control:pg.Pool){}
  async assert(policy:AssistantPolicy):Promise<void> {
    const expected=digest(canonical(policyDocument(policy)));
    const row=(await this.control.query(`SELECT v.fingerprint FROM runtime_configuration c
      JOIN runtime_configuration_versions v USING(name,revision) WHERE c.name='assistant'`)).rows[0];
    if(row?.fingerprint!==expected)throw new HttpError(503,'assistant_configuration_pending');
  }
  /** One trusted application startup writer. Security and workers only assert. */
  async configure(policy:AssistantPolicy,mode:'on'|'off') {
    const document=policyDocument(policy),fingerprint=digest(canonical(document));
    if(!['on','off'].includes(mode))throw new HttpError(400,'invalid_guard_mode');
    const db=await this.control.connect();
    try {
      await db.query('BEGIN');
      const guard=(await db.query('SELECT mode,epoch FROM guard_state WHERE singleton FOR UPDATE')).rows[0];
      if(!guard||(await db.query(`SELECT 1 FROM guard_publications WHERE ${blockingPublications} LIMIT 1`)).rowCount)throw new HttpError(409,'guard_transition_pending');
      const current=(await db.query(`SELECT v.revision,v.fingerprint FROM runtime_configuration c
        JOIN runtime_configuration_versions v USING(name,revision) WHERE c.name='assistant'`)).rows[0];
      const changed=current?.fingerprint!==fingerprint;let revision=current?.revision??0,epoch=Number(guard.epoch);
      if(changed) {
        revision++;
        await db.query("INSERT INTO runtime_configuration_versions(name,revision,document,fingerprint) VALUES('assistant',$1,$2,$3)",[revision,document,fingerprint]);
        await db.query("INSERT INTO runtime_configuration(name,revision) VALUES('assistant',$1) ON CONFLICT(name) DO UPDATE SET revision=$1",[revision]);
      }
      if(changed||guard.mode!==mode) {
        epoch=Number((await db.query('UPDATE guard_state SET mode=$1,epoch=epoch+1 WHERE singleton RETURNING epoch',[mode])).rows[0].epoch);
        await requestWorkflow(db,'honcho','refresh',epoch);await requestWorkflow(db,'memory_review','refresh',epoch);
      }
      await db.query('COMMIT');return {revision,epoch};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
}
