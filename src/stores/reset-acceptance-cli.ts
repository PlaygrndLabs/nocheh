import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {connectStores} from './connections.js';
import {storageConfiguration} from './config.js';
import {verifyFreshAcceptance} from './reset-acceptance.js';

export async function main(argv=process.argv.slice(2)) {
  if(argv.length!==1||argv[0]!=='/reset/fresh-acceptance-request.json'||process.env.NOCHEH_RESET_ACCEPTANCE!=='1')
    throw Error('reset_acceptance_invocation_denied');
  const input=JSON.parse(await readFile(argv[0],'utf8')),{connection,passwords}=storageConfiguration(),stores=connectStores(connection,passwords);
  try {console.log(JSON.stringify({event:'reset_fresh_acceptance_verified',...await verifyFreshAcceptance(stores,input)}));}
  finally{await stores.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
  console.error(JSON.stringify({event:'reset_fresh_acceptance_failed'}));process.exitCode=1;
});
