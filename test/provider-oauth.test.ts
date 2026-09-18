import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {ProviderOAuth} from '../src/provider-oauth.js';
const listen=async(server:Server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');return(server.address() as {port:number}).port;};
const close=(server:Server)=>new Promise<void>(resolve=>server.close(()=>resolve()));

test('host OAuth callback validates pending state, forwards once server-side and removes codes from the return URL',async()=>{
  const state='synthetic-state-1234567890';let callbacks=0,starts=0;
  const monitor=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer synthetic-management-key');
    let body='';for await(const part of req)body+=part;
    res.setHeader('content-type','application/json');
    if(req.url==='/v0/management/codex-auth-url'){
      starts++;res.end(JSON.stringify({state,url:'https://auth.openai.com/authorize?state='+state}));
    }else{
      assert.equal(req.url,'/v0/management/oauth-callback');assert.equal(req.method,'POST');
      assert.deepEqual(JSON.parse(body),{provider:'codex',state,code:'synthetic-one-time-code'});
      callbacks++;res.end('{"status":"ok"}');
    }
  });
  const port=await listen(monitor),probe=createServer(),callback=await listen(probe);await close(probe);
  const oauth=new ProviderOAuth(port,'synthetic-management-key',8783,callback);
  try{
    assert.equal((await oauth.start()).state,state);
    await assert.rejects(oauth.start(),{code:'provider_login_already_pending'});
    const base=`http://127.0.0.1:${callback}/auth/callback`;
    assert.equal((await fetch(base+'?state=wrong&code=secret')).status,400);assert.equal(callbacks,0);
    assert.equal((await fetch(base+'?state='+state+'&code=secret',{method:'POST'})).status,400);
    const response=await fetch(base+'?state='+state+'&code=synthetic-one-time-code',{redirect:'manual'});
    assert.equal(response.status,303);assert.equal(response.headers.get('location'),'http://localhost:8783/providers/management.html#/oauth');
    assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(callbacks,1);assert.equal(starts,1);
    await assert.rejects(fetch(base+'?state='+state+'&code=synthetic-one-time-code'));
  }finally{oauth.close();await close(monitor);}
});

test('occupied callback port fails before starting OAuth and failed upstream releases its listener',async()=>{
  const blocker=createServer(),callback=await listen(blocker);
  const oauth=new ProviderOAuth(1,'fixture',8783,callback);
  try{await assert.rejects(oauth.start(),{code:'oauth_callback_port_busy'});}finally{await close(blocker);}
  await assert.rejects(oauth.start(),{code:'provider_oauth_unavailable'});
  const retry=createServer();retry.listen(callback,'127.0.0.1');await once(retry,'listening');await close(retry);
});

test('maintenance waits for an admitted OAuth callback before declaring provider writes drained',async()=>{
  const state='synthetic-state-1234567890';let release!:()=>void,entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const monitor=createServer(async(req,res)=>{
    req.resume();res.setHeader('content-type','application/json');
    if(req.url?.endsWith('codex-auth-url'))res.end(JSON.stringify({state,url:'https://auth.openai.com/authorize?state='+state}));
    else{entered();await waiting;res.end('{}');}
  });
  const port=await listen(monitor),probe=createServer(),callback=await listen(probe);await close(probe);
  const oauth=new ProviderOAuth(port,'fixture',8783,callback);let drained=false;
  try{
    await oauth.start();const result=fetch(`http://127.0.0.1:${callback}/auth/callback?state=${state}&code=synthetic`,{redirect:'manual'});
    await started;const drain=oauth.quiesce().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
    release();assert.equal((await result).status,303);await drain;assert.equal(drained,true);
    await assert.rejects(fetch(`http://127.0.0.1:${callback}/auth/callback?state=${state}&code=synthetic`));
  }finally{release();oauth.close();await close(monitor);}
});
