import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {storeSchemas} from './schema.js';

export const storeNames=['archive','derived','control'] as const;
export type StoreName=typeof storeNames[number];
export type StorePasswords=Readonly<Record<StoreName,string>>;
export interface StorePools {archive:pg.Pool;derived:pg.Pool;control:pg.Pool;close():Promise<void>}
const databaseName=(name:StoreName)=>`nocheh_${name}`;
const ownerName=(name:StoreName)=>`nocheh_${name}_owner`;

function validatePasswords(passwords:StorePasswords):void {
  if(storeNames.some(name=>!/^[a-f0-9]{64}$/.test(passwords[name])))throw Error('invalid_store_credentials');
  if(new Set(Object.values(passwords)).size!==storeNames.length)throw Error('store_credentials_must_differ');
}

/** Runtime roles cannot create schema, become owners, or connect across domains. */
export function connectStores(connection:pg.PoolConfig,passwords:StorePasswords):StorePools {
  validatePasswords(passwords);
  const connect=(name:StoreName)=>{
    const pool=new pg.Pool({...connection,user:databaseName(name),database:databaseName(name),password:passwords[name],
      max:8,connectionTimeoutMillis:5000,statement_timeout:15000,idleTimeoutMillis:30000});
    const lost=()=>console.error(JSON.stringify({event:'database_connection_lost',store:name}));
    pool.on('connect',client=>client.on('error',lost));pool.on('error',lost);return pool;
  };
  const archive=connect('archive'),derived=connect('derived'),control=connect('control');
  return {archive,derived,control,async close(){await Promise.all([archive.end(),derived.end(),control.end()]);}};
}

/** Run only under installation bootstrap authority, never an agent capability. */
export async function initializeStoreDatabases(connection:pg.PoolConfig,passwords:StorePasswords):Promise<void> {
  validatePasswords(passwords);
  const admin=new pg.Client(connection);await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock(803353)');
    for(const name of storeNames) {
      const db=databaseName(name),owner=ownerName(name);
      if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[owner])).rowCount)
        await admin.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      const exists=(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[db])).rowCount;
      await admin.query(`${exists?'ALTER':'CREATE'} ROLE ${db} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${admin.escapeLiteral(passwords[name])}`);
      const saved=(await admin.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',[db])).rows[0];
      if(saved&&saved.owner!==owner)throw Error('store_database_owner_mismatch');
      if(!saved)await admin.query(`CREATE DATABASE ${db} OWNER ${owner}`);
      await admin.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
      for(const other of storeNames)if(other!==name)await admin.query(`REVOKE ALL ON DATABASE ${db} FROM ${databaseName(other)}`).catch(error=>{
        // On the first bootstrap later roles do not exist yet. All databases
        // revoke PUBLIC before any runtime connection is admitted.
        if(error.code!=='42704')throw error;
      });
      await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${db}`);
      const client=new pg.Client({...connection,database:db});await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
        await client.query(`SET LOCAL ROLE ${owner}`);
        await client.query(storeSchemas[name]);
        if(name==='control')await client.query('INSERT INTO installation(singleton,generation) VALUES(true,$1) ON CONFLICT DO NOTHING',[randomUUID()]);
        await client.query(`GRANT USAGE ON SCHEMA public TO ${db}`);
        await client.query(`GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA public TO ${db}`);
        await client.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${db}`);
        if(name==='archive')await client.query(`GRANT UPDATE(file_hash,byte_size) ON artifacts TO ${db}`);
        else if(name==='control')await client.query(`GRANT UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${db}`);
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;}
      finally {await client.end();}
    }
  } catch {throw Error('store_database_setup_failed');}
  finally {await admin.end();} // Closing releases the session advisory lock even on error.
}
