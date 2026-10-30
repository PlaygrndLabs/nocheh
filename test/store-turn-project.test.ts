import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage} from 'node:http';
import pg from 'pg';
import {digest} from '../src/archive.js';
import {reader} from '../src/access.js';
import {initializeStoreDatabases,connectStores} from '../src/stores/connections.js';
import {GuardRepository} from '../src/stores/guards.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {AudienceRepository} from '../src/stores/audience.js';
import {ProjectRepository} from '../src/stores/projects.js';

test('a turn in a chat of an active project carries that project, so the turn gets its role and skills',
  {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:120000},async()=>{
  const config={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!},check=new pg.Pool(config);
  try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};
  await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),key='turn-project:'+Date.now(),group='-100'+Date.now(),owner={admin:true,scope:null};
  const audience=new AudienceRepository(new GuardRepository(stores,new ArchiveRepository(stores.archive))),projects=new ProjectRepository(stores.control);
  const claims=async(space:string)=>{
    const token=await audience.turn('synthetic-secret',{scope:space.split('/topic/')[0]!,space},digest(key+space),Date.now()+60000);
    assert.equal(reader({headers:{authorization:'Bearer '+token}} as IncomingMessage,'synthetic-secret').space,space,'the token still reads');
    return JSON.parse(Buffer.from(token.split('.')[1]!,'base64url').toString());
  };
  try{
    assert.equal((await claims(group)).project,undefined,'a chat outside any project carries none');
    const project=await projects.save(owner,{name:key,state:'active',expected_revision:0,operation_id:key+':project'});
    await projects.assign(owner,{space_id:group,mode:'assigned',project_id:project.id,expected_revision:0,operation_id:key+':assign'});
    assert.equal((await claims(group)).project,project.id);
    assert.equal((await claims(group+'/topic/7')).project,project.id,'a topic follows its group');
    await projects.save(owner,{id:project.id,name:key,state:'archived',expected_revision:project.revision,operation_id:key+':archive'});
    assert.equal((await claims(group)).project,undefined,'an archived project no longer applies');
  }finally{await stores.close();}
});
