import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {HttpError} from '../http.js';
import type {StorePools} from './connections.js';
import type {GuardRepository} from './guards.js';

export function restoredInactive(root:string):boolean {return existsSync(join(root,'spool/.restore-inactive'));}
export function assertStorageActive(root:string):void {if(restoredInactive(root))throw new HttpError(503,'restored_installation_inactive');}
export async function assertGuardConfiguration(guards:GuardRepository,expected:'on'|'off'):Promise<void> {
  if((await guards.state()).mode!==expected)throw new HttpError(503,'guard_configuration_pending');
}
export async function storageHealth(stores:StorePools) {
  // A healthy control database must never conceal an unavailable archive or derivatives.
  const results=await Promise.allSettled((['archive','derived','control'] as const).map(async name=>{
    const row=(await stores[name].query('SELECT current_database() AS database,current_user AS role')).rows[0];
    if(row.database!=='nocheh_'+name||row.role!=='nocheh_'+name)throw Error('runtime_database_boundary_mismatch');
  }));
  if(results.some(result=>result.status==='rejected'))throw new HttpError(503,'storage_unavailable');
  return {archive:'ready',derived:'ready',control:'ready'};
}
export async function storageHeartbeat(stores:StorePools,service:string) {
  await stores.control.query(`INSERT INTO service_heartbeats(service) VALUES($1)
    ON CONFLICT(service) DO UPDATE SET seen_at=now()`,[service]);
}
