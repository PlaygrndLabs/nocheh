import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {connectStores} from './connections.js';
import {storageConfiguration} from './config.js';
import {verifyResetBaseline} from './reset-baseline.js';

const LIMIT=1024*1024;
async function request(path:string) {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>LIMIT)throw Error('reset_baseline_request_invalid');
    const raw=await file.readFile();if(raw.length>LIMIT)throw Error('reset_baseline_request_invalid');return JSON.parse(raw.toString());}
  finally{await file.close();}
}
export async function main(argv=process.argv.slice(2)) {
  if(argv.length!==1||argv[0]!=='/reset/setup.json'||process.env.NOCHEH_RESET_BASELINE!=='1')throw Error('reset_baseline_invocation_denied');
  const {connection,passwords}=storageConfiguration(),stores=connectStores(connection,passwords);
  try {const result=await verifyResetBaseline(stores,await request(argv[0]!));console.log(JSON.stringify({event:'reset_baseline_verified',...result}));}
  finally{await stores.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
  console.error(JSON.stringify({event:'reset_baseline_verification_failed'}));process.exitCode=1;
});
