import pg from 'pg';
import {pathToFileURL} from 'node:url';

/** Separate metadata owner. Never grant the orchestration role archive access. */
export async function bootstrapWorkflowDatabase(client:pg.Client,password:string):Promise<void> {
  if(!/^[a-f0-9]{64}$/.test(password))throw Error('invalid_workflow_database_password');
  await client.query('SELECT pg_advisory_lock(803320)');
  try {
    const role=(await client.query("SELECT oid FROM pg_roles WHERE rolname='nocheh_inngest'")).rowCount;
    await client.query(`${role?'ALTER':'CREATE'} ROLE nocheh_inngest LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${client.escapeLiteral(password)}`);
    if(!(await client.query("SELECT 1 FROM pg_database WHERE datname='nocheh_inngest'")).rowCount)
      await client.query('CREATE DATABASE nocheh_inngest OWNER nocheh_inngest');
    await client.query('REVOKE ALL ON DATABASE nocheh_inngest FROM PUBLIC');
    // Existing explicitly authorized roles retain their grants. PUBLIC CONNECT
    // must be removed because PostgreSQL has no per-role DENY overriding it.
    await client.query('REVOKE CONNECT ON DATABASE nocheh FROM PUBLIC');
    await client.query('GRANT CONNECT ON DATABASE nocheh TO nocheh');
    if((await client.query("SELECT 1 FROM pg_roles WHERE rolname='nocheh_viewer'")).rowCount)
      await client.query('GRANT CONNECT ON DATABASE nocheh TO nocheh_viewer');
  } finally {await client.query('SELECT pg_advisory_unlock(803320)');}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const client=new pg.Client();
  try {
    await client.connect();await bootstrapWorkflowDatabase(client,process.env.INNGEST_POSTGRES_PASSWORD??'');
    console.log(JSON.stringify({event:'workflow_database_ready'}));
  } catch {console.error(JSON.stringify({event:'workflow_database_setup_failed'}));process.exitCode=1;}
  finally {await client.end().catch(()=>{});}
}
