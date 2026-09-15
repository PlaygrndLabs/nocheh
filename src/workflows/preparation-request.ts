import type pg from 'pg';
import {HttpError} from '../http.js';
import {requestWorkflow} from './store.js';

/** Ensure admission without executing preparation or reopening a closed identity. */
export async function requestPreparation(pool:pg.Pool,eventId:string):Promise<string> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    if(!(await client.query('SELECT id FROM events WHERE id=$1 FOR KEY SHARE',[eventId])).rowCount)throw new HttpError(404,'source_not_found');
    const latest=(await client.query("SELECT id FROM workflow_registry WHERE family='preparation' AND job_id=$1 ORDER BY generation DESC LIMIT 1",[eventId])).rows[0];
    const id=latest?.id??await requestWorkflow(client,'preparation',eventId);
    await client.query('COMMIT');return id;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
