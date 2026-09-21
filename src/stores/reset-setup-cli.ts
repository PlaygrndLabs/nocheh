import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {connectStores} from './connections.js';
import {storageConfiguration} from './config.js';
import {restoreResetSetup} from './reset-setup.js';
import {bootstrapStores} from './bootstrap.js';

const LIMIT=1024*1024;

async function request(path:string):Promise<any> {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>LIMIT)throw Error('reset_setup_request_invalid');
    const raw=await file.readFile();if(raw.length>LIMIT)throw Error('reset_setup_request_invalid');return JSON.parse(raw.toString());
  } finally {await file.close();}
}

export async function main(argv=process.argv.slice(2)) {
  if(argv.length!==1||argv[0]!=='/reset/setup.json'||process.env.NOCHEH_RESET_SETUP!=='1')throw Error('reset_setup_invocation_denied');
  const value=await request(argv[0]!),resetId=value?.reset_id;
  if(typeof resetId!=='string')throw Error('reset_setup_request_invalid');
  await bootstrapStores(resetId);
  const {connection,passwords}=storageConfiguration(),stores=connectStores(connection,passwords);
  try {
    const result=await restoreResetSetup(stores,value);
    console.log(JSON.stringify({event:'reset_setup_restored',generation:result.generation,binding:result.binding,
      configuration_records:result.configuration_records,projects:result.projects,assignments:result.assignments,
      sharing_rules:result.sharing_rules,memory_access_settings:result.memory_access_settings,profiles:result.profiles.length,source_content_copied:false,history_copied:false}));
  } finally {await stores.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{
  console.error(JSON.stringify({event:'reset_setup_restore_failed'}));process.exitCode=1;
});
