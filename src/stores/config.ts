import {readFileSync} from 'node:fs';
import type pg from 'pg';
import type {StorePasswords} from './connections.js';

export function storageLayout(env:NodeJS.ProcessEnv=process.env):'legacy'|'original-only-v1' {
  const value=env.NOCHEH_STORAGE_LAYOUT??'legacy';
  if(value!=='legacy'&&value!=='original-only-v1')throw Error('invalid_storage_layout');
  return value;
}
export function storageConfiguration(env:NodeJS.ProcessEnv=process.env):{connection:pg.PoolConfig;passwords:StorePasswords} {
  if(storageLayout(env)!=='original-only-v1')throw Error('original_storage_layout_required');
  const port=Number(env.PGPORT??5432);if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid_store_port');
  const password=(store:string)=>{
    const name='NOCHEH_'+store.toUpperCase()+'_PASSWORD',path=env[name+'_FILE'];
    const value=env[name]?.trim()??(path?readFileSync(path,'utf8').trim():'');
    if(!/^[a-f0-9]{64}$/.test(value))throw Error('invalid_'+store+'_credential');return value;
  };
  const passwords:StorePasswords={archive:password('archive'),derived:password('derived'),control:password('control')};
  if(new Set(Object.values(passwords)).size!==3)throw Error('store_credentials_must_differ');
  return {connection:{host:env.PGHOST??'nocheh-db',port},passwords};
}
