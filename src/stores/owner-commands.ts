import type pg from 'pg';
import {admin,type Reader} from '../access.js';
import {canonical,digest} from '../archive.js';
import {HttpError,string} from '../http.js';
import {requestWorkflow} from '../workflows/store.js';

/** Atomic control-only changes publish policy and revoke contexts in one commit. */
export class OwnerCommands {
  constructor(readonly control:pg.Pool){}
  async run<T>(principal:Reader,operationId:string,request:unknown,change:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
    admin(principal);string(operationId,200);if(!operationId.trim())throw new HttpError(400,'operation_id_required');
    const hash=digest(canonical(request)),client=await this.control.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT epoch FROM guard_state WHERE singleton FOR UPDATE');
      const prior=(await client.query('SELECT request_hash,result FROM owner_commands WHERE id=$1',[operationId])).rows[0];
      if(prior) {
        if(prior.request_hash!==hash)throw new HttpError(409,'owner_command_conflict');
        await client.query('COMMIT');return prior.result;
      }
      const result=await change(client);
      const epoch=Number((await client.query('UPDATE guard_state SET epoch=epoch+1 WHERE singleton RETURNING epoch')).rows[0].epoch);
      await requestWorkflow(client,'honcho','refresh',epoch);await requestWorkflow(client,'memory_review','refresh',epoch);
      await client.query('INSERT INTO owner_commands(id,request_hash,result,epoch) VALUES($1,$2,$3,$4)',[operationId,hash,JSON.stringify(result),epoch]);
      await client.query('COMMIT');return result;
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }
}
