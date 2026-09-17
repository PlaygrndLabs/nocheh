import type pg from 'pg';
import {HttpError} from '../http.js';
import {requestWorkflow} from '../workflows/store.js';
import {canonical} from '../archive.js';
import type {GuardBinding} from './guards.js';

export interface RepresentationChange {
  kind:'guard'|'selection'|'memory';source_id:string;revision:number;expected_revision:number|null;operation_id:string;
  input_binding?:GuardBinding;
}

/** Call only after the owning derived repository validates its durable draft. */
export async function revokeBeforePublication(control:pg.Pool,change:RepresentationChange):Promise<void> {
  const client=await control.connect();
  try {
    await client.query('BEGIN');
    const state=(await client.query('SELECT g.epoch,g.mode,i.generation FROM guard_state g CROSS JOIN installation i WHERE g.singleton AND i.singleton FOR UPDATE OF g')).rows[0];
    const previous=(await client.query('SELECT * FROM guard_publications WHERE id=$1',[change.operation_id])).rows[0];
    if(previous) {
      if(previous.operation_kind!==change.kind||previous.source_id!==change.source_id||previous.revision!==change.revision||previous.expected_revision!==change.expected_revision)
        throw new HttpError(409,'representation_operation_conflict');
    } else {
      if(change.input_binding&&canonical(change.input_binding)!==canonical({generation:state.generation,epoch:Number(state.epoch),mode:state.mode}))
        throw new HttpError(409,'guard_context_changed');
      // A first representation has no previously authorized content to revoke.
      // Changing existing content (and every selected engine) revokes before visibility.
      const changed=change.expected_revision!==null||change.kind==='selection';
      const epoch=changed?Number((await client.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton RETURNING epoch')).rows[0].epoch):Number(state.epoch);
      await client.query(`INSERT INTO guard_publications(id,operation_kind,source_id,revision,expected_revision,epoch) VALUES($1,$2,$3,$4,$5,$6)`,
        [change.operation_id,change.kind,change.source_id,change.revision,change.expected_revision,epoch]);
      if(changed) {
        await client.query('INSERT INTO guard_invalidations(source_id,epoch) VALUES($1,$2)',[change.source_id,epoch]);
        await requestWorkflow(client,'honcho','refresh',epoch);await requestWorkflow(client,'memory_review','refresh',epoch);
      }
      if(change.kind==='memory')await requestWorkflow(client,'honcho','projection:'+change.source_id,change.revision);
    }
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
