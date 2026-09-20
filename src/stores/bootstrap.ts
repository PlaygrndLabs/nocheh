import pg from 'pg';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {secret} from '../config.js';
import {initializeStoreDatabases} from './connections.js';
import {storageConfiguration} from './config.js';
import {bootstrapWorkflowDatabase} from '../workflows/bootstrap.js';

/** PostgreSQL startup and explicit reset setup own this administrator operation. */
function inactive(root:string,resetId?:string) {
  const path=join(root,'spool/.restore-inactive'),present=existsSync(path);
  if(resetId===undefined) {if(present)throw Error('inactive_installation_requires_explicit_activation');return;}
  if(process.env.NOCHEH_RESET_SETUP!=='1'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(resetId)||
    !present||readFileSync(path,'utf8')!==`nocheh-reset:${resetId}\n`)throw Error('reset_inactive_fence_required');
}

export async function bootstrapStores(resetId?:string) {
  const root=process.env.NOCHEH_DATA_DIR??'/data';
  inactive(root,resetId);
  const {connection,passwords}=storageConfiguration(),password=secret('PGPASSWORD'),workflowPassword=secret('INNGEST_POSTGRES_PASSWORD');
  if(!/^[a-f0-9]{64}$/.test(workflowPassword))throw Error('invalid_workflow_database_password');
  if(new Set([...Object.values(passwords),password,workflowPassword]).size!==5)throw Error('bootstrap_and_store_credentials_must_differ');
  const admin={...connection,user:'nocheh',database:'nocheh',password};
  const client=new pg.Client(admin);await client.connect();
  try {
    if(!(await client.query('SELECT pg_try_advisory_lock(803361) AS acquired')).rows[0].acquired)throw Error('store_maintenance_busy');
    inactive(root,resetId);
    await initializeStoreDatabases(admin,passwords);
    await bootstrapWorkflowDatabase(client,workflowPassword);
  }
  finally{await client.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {await bootstrapStores();console.log(JSON.stringify({event:'store_databases_ready',layout:'original-only-v1'}));}
  catch {console.error(JSON.stringify({event:'store_database_setup_failed'}));process.exitCode=1;}
}
