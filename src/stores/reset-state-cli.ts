import {pathToFileURL} from 'node:url';
import {connectStores} from './connections.js';
import {storageConfiguration} from './config.js';
import {resetStoreState} from './reset-baseline.js';

export async function main(argv=process.argv.slice(2)) {
  if(argv.length!==0||process.env.NOCHEH_RESET_STATE!=='1')throw Error('reset_state_invocation_denied');
  const {connection,passwords}=storageConfiguration(),stores=connectStores(connection,passwords);
  try {console.log(JSON.stringify({event:'reset_state_observed',...await resetStoreState(stores)}));}
  finally{await stores.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
  console.error(JSON.stringify({event:'reset_state_observation_failed'}));process.exitCode=1;
});
