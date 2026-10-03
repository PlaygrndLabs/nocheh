import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {HttpError} from '../src/http.js';
import {turnToken,type Reader} from '../src/access.js';
import {brokerServer,scopedRoute,type TurnBinding} from '../src/security/broker.js';

test('knowledge broker exposes only typed routes and preserves the scoped credential',async()=>{
  const secret='synthetic-test-secret',source='a'.repeat(64),proposal='b'.repeat(64);
  const calls:{url:string;authorization:string;body:unknown}[]=[];
  let scheduled=false,valid=true;
  const pool={query:async(sql:string)=>({rows:sql.includes('SELECT p.revision')?[{revision:1,document:{version:1,rules:[]}}]:[],rowCount:1})} as unknown as pg.Pool;
  const binding=async(principal:Reader):Promise<TurnBinding>=>{
    if(principal.admin||!principal.turnEvent)throw new HttpError(403,'scoped_turn_required');
    if(!valid)throw new HttpError(409,'audience_context_changed');
    return {event_id:principal.turnEvent,scope:principal.scope??'42',profile:'synthetic',logical_profile:'synthetic',owner:principal.scope===null,
      guard_epoch:1,...(scheduled?{job:'synthetic-job'}:{})};
  };
  const server=brokerServer({pool,token:secret,archive:'http://archive',hermes:'http://hermes',model:'synthetic',prepare:async()=>({}),
    storage:{binding,assertAudience:async()=>{if(!valid)throw new HttpError(409,'audience_context_changed');},turnFile:async()=>{throw Error();}},
    fetch:async(url,init)=>{calls.push({url:String(url),authorization:new Headers(init?.headers).get('authorization')??'',body:init?.body?JSON.parse(String(init.body)):null});return Response.json({id:proposal,state:'review'});}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
    const credential=(scope:string|null,purpose?:Reader['purpose'])=>turnToken(secret,scope,Date.now()+600000,source,{space:scope??'42',revision:1,guard_epoch:1,...(purpose?{purpose}:{})});
    const owner=credential(null,'assistant'),group=credential('-10');
    const request=(path:string,body:unknown|undefined,key=owner)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const input={operation_id:'synthetic-operation',proposal:{kind:'organization',reason:'Fixture',creates:[],assignments:[]}};
    assert.equal((await request('/v1/knowledge/context?space=-10',undefined)).status,200);
    assert.equal((await request('/v1/knowledge/proposals',input)).status,200);
    assert.equal((await request('/v1/knowledge/proposals/'+proposal,undefined)).status,200);
    assert.deepEqual(calls.map(call=>call.authorization),['Bearer '+owner,'Bearer '+owner,'Bearer '+owner]);
    assert.deepEqual(calls[1]!.body,input);
    const before=calls.length;
    for(const route of ['/v1/knowledge/context','/v1/knowledge/proposals/'+proposal])assert.equal((await request(route,undefined,group)).status,403);
    assert.equal((await request('/v1/knowledge/proposals',{...input,owner:true,approved:true},group)).status,403,'model claims cannot turn a group into owner authority');
    assert.equal((await request('/v1/knowledge/proposals',input,secret)).status,403,'service credential is not a runtime turn');
    assert.equal((await request('/v1/knowledge/proposals',input,credential(null,'filter'))).status,403);
    assert.equal((await request('/v1/knowledge/proposals',input,credential(null,'memory-review'))).status,403);
    scheduled=true;assert.equal((await request('/v1/knowledge/proposals',input)).status,403);scheduled=false;
    for(const path of ['/v1/organization/delegations','/v1/knowledge/proposals/'+proposal+'/decide','/v1/knowledge/proposals/'+proposal+'/undo'])
      assert.equal((await request(path,input)).status,403);
    valid=false;assert.equal((await request('/v1/knowledge/context',undefined)).status,409);
    assert.equal(calls.length,before,'denied routes and stale turns never reach storage');
    assert.equal(scopedRoute('POST','/v1/knowledge/proposals'),true);
    assert.equal(scopedRoute('GET','/v1/knowledge/context'),true);
    assert.equal(scopedRoute('GET','/v1/knowledge/proposals/'+proposal),true);
    assert.equal(scopedRoute('POST','/v1/knowledge/proposals/'+proposal+'/decide'),false);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
