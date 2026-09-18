import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';

test('controlled proposals and bounded permissions preserve guarded content outside control and archive',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-controlled-')),key='controlled:'+Date.now(),group='-'+Date.now();
  const owner={admin:true,scope:null},s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>({enabled:true,owner_id:'123',group_ids:[group]}),
    runtime:async(operation,input)=>{assert.equal(operation,'guard.detect');return {literals:String(input.text).includes('fixture-secret')?['fixture-secret']:[]};},honcho:async()=>{throw Error('no provider');}});
  const a=s.controlledActions,event:Envelope={version:1,key,origin:'live',kind:'telegram_update',bot_id:key,scope:group,source_id:'1',revision:'1',occurred_at:null,text:'Propose a tool',
    payload:{message:{message_id:1,date:1700000000,chat:{id:Number(group),type:'supergroup',is_forum:false},from:{id:9},text:'Propose a tool'}}};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);
    const binding=await s.guards.state(),actor={admin:false,scope:group,space:group,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
    const before=Number((await stores.archive.query('SELECT count(*) AS n FROM events')).rows[0].n);
    const body={kind:'shell',arguments:{command:'printf "fixture-secret"'}},proposal=await a.propose(actor,body);
    assert.equal((await a.propose(actor,body)).id,proposal.id);assert.equal(proposal.state,'proposed');
    let row=await a.inspect(owner,proposal.id);assert.ok(!row.arguments.command.includes('fixture-secret'));assert.equal(row.logical_profile,(await s.turns.binding(actor)).logical_profile);
    assert.equal((await a.preview(owner,{action_id:proposal.id})).decision.outcome,'ask');
    await assert.rejects(a.propose({...actor,purpose:'memory-review'},body),{code:'external_effect_scope_denied'});
    await assert.rejects(a.propose(actor,{...body,profile:'owner'}),{code:'unknown_action_field'});
    await assert.rejects(a.decide(actor,{id:proposal.id,fingerprint:proposal.fingerprint,decision:'approve'}),{status:403});
    await assert.rejects(a.decide(owner,{id:proposal.id,fingerprint:digest('wrong'),decision:'approve'}),{code:'action_changed'});
    const grantBody={action_id:proposal.id,fingerprint:proposal.fingerprint,uses:2,minutes:5};
    const grant=await a.grant(owner,grantBody);assert.deepEqual(await a.grant(owner,grantBody),grant);
    let preview=await a.preview(owner,{action_id:proposal.id});assert.equal(preview.decision.outcome,'allow');assert.equal(preview.grants[0].remaining,2);
    preview=await a.preview(owner,{action_id:proposal.id,policy:{version:1,rules:[{id:'deny-shell',kind:'shell',outcome:'deny'}]}});
    assert.equal(preview.decision.outcome,'deny');assert.equal(preview.grants[0].remaining,2,'preview never consumes a bounded grant');
    const revoked=await a.revoke(owner,{id:grant.id,expected_revision:1});assert.deepEqual(await a.revoke(owner,{id:grant.id,expected_revision:1}),revoked);
    assert.equal((await a.preview(owner,{action_id:proposal.id})).decision.outcome,'ask');
    await assert.rejects(a.grant(owner,{...grantBody,uses:0}),{code:'invalid_permission_bounds'});
    const decision={id:proposal.id,fingerprint:proposal.fingerprint,decision:'approve',expected_revision:1};
    const approved=await a.decide(owner,decision);assert.equal(approved.state,'approved');assert.deepEqual(await a.decide(owner,decision),approved);
    assert.equal((await a.preview(owner,{action_id:proposal.id})).decision.outcome,'allow');
    await a.decide(owner,{id:proposal.id,fingerprint:proposal.fingerprint,decision:'deny',expected_revision:approved.revision});
    assert.equal((await a.inspect(owner,proposal.id)).state,'rejected');
    const permittedKinds=[{kind:'browser',arguments:{url:'https://example.com/'}},{kind:'mcp',arguments:{url:'https://example.com/mcp',operation:'list'}}];
    for(const item of permittedKinds)assert.equal((await a.propose(actor,item)).state,'proposed');
    await assert.rejects(a.propose(actor,{kind:'browser',arguments:{url:'http://127.0.0.1/private'}}),{code:'public_https_required'});
    const commandAction=await a.propose(actor,{kind:'shell',arguments:{command:'printf owner-command'}});
    const command=async(label:string,text:string,scope='123',sender=123)=>{
      const original:Envelope={...event,key:key+':'+label,scope,source_id:label,text,payload:{message:{message_id:Date.now(),chat:{id:Number(scope),type:scope==='123'?'private':'supergroup',is_forum:false},from:{id:sender},text}}};
      return (await s.capture.capture(original)).source.reference;
    };
    const ownerApprove=await command('owner-approve','/approve '+commandAction.id);
    assert.match((await s.actionCommands.controlReply(await command('group-approve','/approve '+commandAction.id,group)))!,/Only the owner/);
    assert.match((await s.actionCommands.controlReply(await command('other-approve','/approve '+commandAction.id,'456',456)))!,/Only the owner/);
    assert.equal((await a.row(commandAction.id)).state,'proposed');
    assert.match((await s.actionCommands.controlReply(await command('review','/action '+commandAction.id)))!,/Exact arguments:\n.*owner-command/);
    assert.match((await s.actionCommands.controlReply(ownerApprove))!,/approved/);
    assert.match((await s.actionCommands.controlReply(ownerApprove))!,/approved/);
    assert.ok((await s.actionCommands.controlReply(await command('list','/actions')))!.includes(commandAction.id));
    assert.equal((await a.row(commandAction.id)).decision_reference.id,ownerApprove.id);
    assert.equal((await stores.control.query('SELECT source_reference FROM action_owner_commands WHERE id=$1',['telegram-command:'+ownerApprove.id])).rows[0].source_reference.id,ownerApprove.id);
    const commandGrant=await a.grant(owner,{action_id:commandAction.id,fingerprint:commandAction.fingerprint,uses:1,minutes:5});
    assert.match((await s.actionCommands.controlReply(await command('permissions','/permissions')))!,/Remaining:/);
    const revokeCommand=await command('revoke','/revoke '+commandGrant.id);
    assert.match((await s.actionCommands.controlReply(revokeCommand))!,/Permission revoked/);assert.match((await s.actionCommands.controlReply(revokeCommand))!,/Permission revoked/);
    assert.ok((await stores.control.query('SELECT revoked_at FROM action_permissions WHERE id=$1',[commandGrant.id])).rows[0].revoked_at);
    const long=await a.propose(actor,{kind:'shell',arguments:{command:'printf '+ 'x'.repeat(2300)}});
    assert.match((await s.actionCommands.controlReply(await command('long-review','/action '+long.id)))!,/too long to review/);
    assert.match((await s.actionCommands.controlReply(await command('long-approve','/approve '+long.id)))!,/too long to review/);
    assert.equal((await a.row(long.id)).state,'proposed');
    const imported=await command('imported-command','/deny '+commandAction.id);
    await stores.control.query("UPDATE source_intakes SET transport='import' WHERE event_id=$1",[imported.id]);
    assert.equal(await s.actionCommands.controlReply(imported),null);assert.equal((await a.row(commandAction.id)).state,'approved');
    const edited=await s.capture.capture({...event,key:key+':edited',scope:'123',payload:{edited_message:{message_id:5,chat:{id:123,type:'private'},from:{id:123},text:'/deny '+commandAction.id}}});
    assert.equal(await s.actionCommands.controlReply(edited.source.reference),null);
    const guardedCommand=await command('guarded-injection','Plain original message');await s.guards.prepare(guardedCommand,'fixture',s.detect);
    const afterCommands=Number((await stores.archive.query('SELECT count(*) AS n FROM events')).rows[0].n);
    assert.equal(afterCommands-before,12,'only observed command messages add originals');
    const stale=await a.propose(actor,{kind:'shell',arguments:{command:'pwd'}}),staleGrant=await a.grant(owner,{action_id:stale.id,fingerprint:stale.fingerprint,uses:1,minutes:5});
    const stored=await a.row(stale.id),guard=await s.guards.read('derived_artifacts:'+stored.proposal_reference.id,binding);
    await s.guards.edit('derived_artifacts:'+stored.proposal_reference.id,guard.revision,{...guard.value as any,text:JSON.stringify({command:'different command'})},key+':edited-proposal');
    assert.equal((await a.preview(owner,{action_id:stale.id})).decision.outcome,'deny');
    await assert.rejects(a.decide(owner,{id:stale.id,fingerprint:stale.fingerprint,decision:'approve'}),{code:'guard_context_changed'});
    assert.equal((await a.list(owner)).permissions.find((p:any)=>p.id===staleGrant.id).arguments.command,'pwd','permission keeps the exact historic reviewed arguments');
    await assert.rejects(a.inspect(actor,proposal.id),{code:'audience_context_changed'});
    const plain=await s.guards.read('events:'+guardedCommand.id,await s.guards.state());
    await s.guards.edit('events:'+guardedCommand.id,plain.revision,{...plain.value as any,text:'/deny '+commandAction.id},key+':guarded-command');
    assert.equal(await s.actionCommands.controlReply(guardedCommand),null,'editable guarded content cannot become an administrative command');
    assert.equal((await a.row(commandAction.id)).state,'approved');
    assert.equal(Number((await stores.archive.query('SELECT count(*) AS n FROM events')).rows[0].n),afterCommands,'decisions and guarded revisions add no originals');
    for(const table of ['controlled_actions','action_permissions']) {
      const columns=(await stores.control.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows.map(r=>r.column_name);
      assert.ok(!columns.some(n=>['arguments','content','text','result','payload'].includes(n)));
    }
    await assert.rejects(s.archive.capture({...event,key:key+':generated',kind:'controlled_action_request'}),{code:'original_source_required'});
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
