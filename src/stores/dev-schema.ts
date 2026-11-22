import pg from 'pg';
import {readFileSync} from 'node:fs';

// In development the database container sets up the stores again with each finished build (deploy/store-postgres-
// entrypoint.sh). The app and the security service wait for that setup before they start, so no reader of theirs meets a
// table the new code needs before it exists, or holds a table that setup is changing (a deadlock). Outside development
// there is no build marker and nothing waits: the database is set up before any service starts.

/** The control table that names the development build whose store setup last finished. */
export const schemaBuildSchema=`
CREATE TABLE IF NOT EXISTS schema_builds (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),build text NOT NULL CHECK(length(build) BETWEEN 1 AND 64),
 applied_at timestamptz NOT NULL DEFAULT now()
);`;

/** The development build this code came from (dist/.dev-ready), or null outside a development build. */
export function devBuild(marker:URL=new URL('../../.dev-ready',import.meta.url)):string|null {
  try {const build=readFileSync(marker,'utf8').trim();return /^[0-9]{1,64}$/.test(build)?build:null;}
  catch {return null;}
}

/** Setup names its build once every store and the workflow database are set up. */
export async function recordSchemaBuild(admin:pg.ClientConfig,build:string|null):Promise<void> {
  if(build===null)return;
  const client=new pg.Client({...admin,database:'nocheh_control'});await client.connect();
  try {await client.query(`INSERT INTO schema_builds(singleton,build) VALUES(true,$1)
    ON CONFLICT(singleton) DO UPDATE SET build=EXCLUDED.build,applied_at=now()`,[build]);}
  finally {await client.end();}
}

type Queryable={query(text:string):Promise<{rows:{build?:unknown}[]}>};
type Wait={deadline?:number;every?:number;log?:(line:string)=>void};

/** Waits until setup has finished for this build. After `deadline` it goes on anyway, as it did before it waited: setup
 * that keeps failing (a backup holding the maintenance lock) must not keep the app down. */
export async function schemaReady(control:Queryable,build:string|null=devBuild(),
  {deadline=120000,every=500,log=line=>console.log(line)}:Wait={}):Promise<'none'|'ready'|'timeout'> {
  if(build===null)return 'none';
  const started=Date.now();let waited=false;
  for(;;) {
    // Before this build's setup the table may not exist yet (42P01); that is waiting too.
    const applied=await control.query('SELECT build FROM schema_builds WHERE singleton').then(result=>result.rows[0]?.build,()=>undefined);
    if(applied===build) {
      if(waited)log(JSON.stringify({event:'development_schema_ready',waited_ms:Date.now()-started}));
      return 'ready';
    }
    if(Date.now()-started>=deadline) {
      log(JSON.stringify({event:'development_schema_wait_timeout',waited_ms:Date.now()-started}));
      return 'timeout';
    }
    waited=true;
    await new Promise(resolve=>setTimeout(resolve,every));
  }
}
