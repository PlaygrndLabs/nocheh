import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {storageServices} from '../src/stores/services.js';
import type {SourceReference} from '../src/stores/archive.js';
import {claimHostWorkflow} from '../src/workflows/host-coordinator.js';
import {storageWorkflowOperations} from '../src/stores/workflow-operations.js';
import {policySnapshot,savePolicy} from '../src/security/store.js';
import {honchoEngine} from '../src/memory/honcho.js';

test('a card\'s Allow here and Always allow let the same site or command run in that chat without asking',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-rules-')),key='rules:'+Date.now(),group='-100'+Date.now(),token=digest(key);
  const owner:Reader={admin:true,scope:null},cards:any[]=[],answers:string[]=[];
  const policy=()=>({enabled:true,owner_id:'123',group_ids:[group],group_access:{[group]:{granted:['9'],denied:[]}}});
  const s=storageServices(stores,{dataDir:root,detectorVersion:'fixture',serviceToken:token,policy,
    runtime:async(operation,input)=>{
      if(operation==='guard.detect')return {literals:[]};
      if(operation==='telegram.approval'){
        if(input.kind==='card')cards.push(input);
        if(input.kind==='answer')answers.push(String(input.text));
        return input.kind==='card'?{state:'done',chat_id:input.chat_id,message_id:String(cards.length)}:{state:'done'};
      }
      return {state:'done'};
    },memoryEngine:honchoEngine(async()=>{throw Error('no memory provider');})});
  const bot=String(Date.now()).slice(-8)+'3';let updates=0;
  const capture=async(label:string,payload:Record<string,unknown>,scope=group)=>{
    const event:Envelope={version:1,key:`telegram:${bot}:update:${payload.update_id}`,origin:'live',kind:'telegram_update',bot_id:bot,scope,source_id:String(payload.update_id),revision:'1',occurred_at:null,text:label,payload};
    const source=(await s.capture.capture(event)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
  };
  // A member's request in a topic of a forum group.
  const message=(label:string,topic=17)=>capture(label,{update_id:++updates,message:{message_id:100+updates,date:1700000000,
    chat:{id:Number(group),type:'supergroup',is_forum:true},from:{id:9,first_name:'Member'},text:'Please check '+label,message_thread_id:topic,is_topic_message:true}});
  const press=(label:string,data:string,from=123)=>capture(label,{update_id:++updates,callback_query:{id:'query-'+label,from:{id:from},chat_instance:'1',data,
    message:{message_id:5,date:1700000000,chat:{id:123,type:'private'}}}},'123');
  const actor=async(source:SourceReference):Promise<Reader>=>{
    const binding=await s.guards.state(),space=(await s.access.space(source))!;
    return {admin:false,scope:group,space,turnEvent:source.id,generation:binding.generation,guard_epoch:binding.epoch,revision:binding.epoch};
  };
  const ask=async(source:SourceReference,kind:'browser'|'shell'|'mcp',args:Record<string,unknown>,summary?:string)=>{
    const before=cards.length,result=await s.actionCommands.offer('controlled',await s.controlledActions.propose(await actor(source),{kind,arguments:args,...(summary?{summary}:{})}));
    return {...result,card:cards.length>before?cards.at(-1):null};
  };
  const choices=(card:any)=>card.buttons.map(([,data]:[string,string])=>data.slice(0,2));
  const tap=async(asked:{id:string;fingerprint:string},choice:string,from=123)=>{
    assert.equal(await s.actionCommands.callback(await press(choice+'-'+asked.id.slice(0,12)+'-'+updates,choice+asked.id.slice(0,40)+asked.fingerprint.slice(0,16),from)),true);
    return answers.at(-1)!;
  };
  const run=async(id:string)=>{
    const row=(await stores.control.query("SELECT * FROM workflow_registry WHERE family='tools' AND job_id=$1",[id])).rows[0];
    const lease=await claimHostWorkflow(stores.control,{workflow_id:row.id,dispatch:row.dispatch,family:'tools',run_id:'fixture-'+row.id+'-'+updates++});
    const b={id,actor:'wf-'+row.id,workflow_id:row.id,workflow_token:lease.token},claim=await s.controlledExecution.claim(b);
    if(!claim.claimed)return {claim,state:(await s.controlledActions.row(id)).state};
    const start=await s.controlledExecution.start(b);
    if(start.started)await s.controlledExecution.finish({...b,state:'done',result:{exit_code:0}});
    return {claim,start,state:(await s.controlledActions.row(id)).state};
  };
  const rules=async()=>(await stores.control.query("SELECT * FROM action_permissions WHERE grain='chat' AND space_id LIKE $1 ORDER BY created_at,id",[group+'%'])).rows;
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    await stores.control.query(`UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton`);
    // A web read's card offers Allow once, Allow here, Always allow and Reject; an exact command, Allow once, Always and Reject;
    // a connected tool, Approve and Reject only.
    const first=await ask(await message('weather'),'browser',{url:'https://weather.example.com/today'});
    assert.deepEqual(choices(first.card),['na','nc','nw','nd']);
    assert.match(first.card.buttons[1][0],/Allow where asked, 12 hours/);
    // The card names the topic the rule would cover and says, last, right above the buttons, that it covers everyone there.
    const ruleNote='\n\n👥 “Where asked” covers everyone you allowed in that chat or topic, not only the person who asked.';
    assert.match(first.card.text,/💬 Asked in a Telegram group › a topic\n/);assert.ok(first.card.text.endsWith(ruleNote),first.card.text);
    const command=await ask(await message('command'),'shell',{command:'printf made-up-rule'});
    assert.deepEqual(choices(command.card),['na','nw','nd']);assert.match(command.card.text,/covers everyone you allowed/);
    const tool=await ask(await message('tool'),'mcp',{url:'https://tools.example.com/mcp',operation:'list'});
    assert.deepEqual(choices(tool.card),['na','nd']);assert.doesNotMatch(tool.card.text,/Where asked/,'no rule, no note');
    // Only the owner sets a rule; a member's press decides nothing.
    assert.match(await tap(first,'nc',9),/Only the owner/);assert.equal((await rules()).length,0);
    // A second read of the same site, still waiting, runs too once the owner allows the first here.
    const waiting=await ask(await message('waiting'),'browser',{url:'https://weather.example.com/tomorrow'});
    assert.ok(waiting.card,'without a rule it asks');
    assert.match(await tap(first,'nc'),/allowed for 12 hours for everyone in the chat or topic that asked/);
    const [rule]=await rules();
    assert.deepEqual([rule.match_key,rule.kind,rule.space_id,rule.job_id,rule.remaining],['nocheh_browser:weather.example.com','browser',group+'/topic/17',null,1000]);
    const hours=(new Date(rule.expires_at).getTime()-Date.now())/3600000;assert.ok(hours>11.9&&hours<=12,'a session is 12 hours');
    assert.equal((await s.controlledActions.row(first.id)).state,'approved');
    assert.equal((await run(first.id)).state,'done');
    const queued=await run(waiting.id);assert.equal(queued.state,'done','the waiting read ran under the rule');assert.equal(queued.claim.claimed,true);
    // After a change that starts a new epoch, the rule still covers a new read of that site in that topic: no card.
    const note=await message('note',17),plain=await s.guards.read('events:'+note.id,await s.guards.state());
    const epoch=(await s.guards.state()).epoch;
    await s.guards.edit('events:'+note.id,plain.revision,{...plain.value as any,text:'An edited made-up note'},key+':edit');
    assert.ok((await s.guards.state()).epoch>epoch);
    const later=await ask(await message('later'),'browser',{url:'https://weather.example.com/week'});
    assert.equal(later.card,null,'no card');assert.match(later.message,/Allowed by a rule the owner set for this chat; it runs now\. Its answer will follow here/);
    const covered=await run(later.id);assert.equal(covered.state,'done');
    assert.equal((await s.controlledActions.row(later.id)).permission_id,rule.id);
    // Two reads of one message that the rule lets run are answered together: the first one's follow-up waits for the second.
    const pair=await message('pair'),one=await ask(pair,'browser',{url:'https://weather.example.com/one'}),two=await ask(pair,'browser',{url:'https://weather.example.com/two'});
    assert.deepEqual([one.card,two.card],[null,null]);
    await stores.control.query(`INSERT INTO dispatches(event_id,source_reference,state,attempts) VALUES($1,$2,'done',1)`,[pair.id,pair]);
    assert.equal((await run(one.id)).state,'done');
    const operations=storageWorkflowOperations(s,async()=>({}));
    const owned=Number((await stores.control.query("SELECT epoch FROM workflow_owners WHERE family='telegram'")).rows[0].epoch);
    assert.equal((await operations.telegram!('continue:'+one.id,{owner:'inngest',epoch:owned})).state,'waiting','the second has not run yet');
    assert.equal((await run(two.id)).state,'done');
    await stores.control.query("UPDATE action_continuations SET state='cancelled' WHERE event_id=$1",[pair.id]);
    // Another topic, another site or another kind is not covered.
    for(const [source,kind,args] of [[await message('elsewhere',18),'browser',{url:'https://weather.example.com/today'}],
      [await message('other site'),'browser',{url:'https://news.example.com/'}],[await message('a command'),'shell',{command:'printf weather.example.com'}]] as const) {
      const other=await ask(source,kind,args);assert.ok(other.card,kind+' '+JSON.stringify(args)+' still asks');
      assert.equal((await run(other.id)).claim.claimed,false);
    }
    // A deny rule wins over the rule.
    const blocked=await ask(await message('blocked'),'browser',{url:'https://weather.example.com/blocked'});assert.equal(blocked.card,null);
    const original=await policySnapshot(stores.control);
    await savePolicy(stores.control,owner,{expected_revision:original.revision,policy:{version:1,rules:[...original.policy.rules,{id:key,kind:'browser',fingerprint:blocked.fingerprint,outcome:'deny'}]}});
    try{assert.equal((await run(blocked.id)).state,'rejected');}
    finally{await savePolicy(stores.control,owner,{expected_revision:(await policySnapshot(stores.control)).revision,policy:original.policy});}
    // An address another parser reads as a different host is refused, so no rule can cover it.
    for(const url of ['https://weather.example.com\\c2vjcmv0.attacker.example/today','https://stra\u00dfe.example/','https://%77eather.example.com/'])
      await assert.rejects(ask(await message('odd host'),'browser',{url}),{code:'plain_host_required'});
    // Revoking the rule ends it: one it let in without a card but not yet run is closed, and the next read asks again.
    // Its uses since it was shown do not change the revision a Revoke is sent with.
    const pending=await ask(await message('pending'),'browser',{url:'https://weather.example.com/pending'});assert.equal(pending.card,null);
    await s.controlledActions.revoke(owner,{id:rule.id,expected_revision:rule.revision,operation_id:key+':revoke'});
    assert.deepEqual(await run(pending.id).then(async()=>{const row=await s.controlledActions.row(pending.id);return [row.state,row.error_code];}),['rejected','permission_no_longer_valid']);
    const revoked=await ask(await message('revoked'),'browser',{url:'https://weather.example.com/today'});assert.ok(revoked.card);
    // Always allow an exact command: the same command runs here without a card for 30 days; another command still asks.
    // The first card's request is from before the edit, so it is asked again.
    assert.match(await tap(command,'nw'),/It did not run: something it used changed/);assert.equal((await rules()).filter(row=>row.kind==='shell').length,0);
    const exactly=await ask(await message('command again'),'shell',{command:'printf made-up-rule'});
    assert.match(await tap(exactly,'nw'),/allowed for 30 days for everyone in the chat or topic that asked/);
    const always=(await rules()).find(row=>row.kind==='shell')!;
    assert.equal(always.match_key,'nocheh_shell:'+digest('printf made-up-rule'));
    const days=(new Date(always.expires_at).getTime()-Date.now())/86400000;assert.ok(days>29.9&&days<=30);
    const again=await ask(await message('again'),'shell',{command:'printf made-up-rule'});assert.equal(again.card,null);
    assert.equal((await ask(await message('different'),'shell',{command:'printf made-up-other'})).card?.kind,'card');
    // A follow-up turn is started by Nocheh after a result, not asked by anyone: no rule covers what it asks for,
    // and its card offers no rule.
    const followed=await message('followed'),before=await ask(followed,'shell',{command:'printf made-up-before'});
    await tap(before,'na');assert.equal((await run(before.id)).state,'done');
    await stores.control.query("UPDATE action_continuations SET state='running' WHERE action_id=$1",[before.id]);
    const steered=await ask(followed,'shell',{command:'printf made-up-rule'});
    assert.deepEqual(choices(steered.card),['na','nd']);assert.equal((await s.controlledActions.row(steered.id)).match_key,null);
    assert.doesNotMatch(steered.card.text,/Where asked/);
    await stores.control.query("UPDATE action_continuations SET state='cancelled' WHERE action_id=$1",[before.id]);
    // A connected tool has no rule: its Approve stays one decision, and an Allow press on it decides nothing.
    assert.match(await tap(tool,'nc'),/already decided/);assert.equal((await s.controlledActions.row(tool.id)).state,'proposed');
    assert.equal((await rules()).filter(row=>row.kind==='mcp').length,0);
    // In the owner's private chat only the owner asks: the card offers the rule without the note.
    const mine=await capture('private',{update_id:++updates,message:{message_id:100+updates,date:1700000000,chat:{id:123,type:'private'},from:{id:123},text:'Please check private'}},'123');
    const own=await s.actionCommands.offer('controlled',await s.controlledActions.propose({...await actor(mine),scope:null},{kind:'browser',arguments:{url:'https://weather.example.com/private'}}));
    const ownCard=cards.at(-1);assert.equal(ownCard.id,own.id);
    assert.deepEqual(choices(ownCard),['na','nc','nw','nd']);assert.doesNotMatch(ownCard.text,/Where asked/);
    // The note is the owner's text. A card it does not fit offers no rule, so a rule never comes without saying whom it covers.
    await stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',[JSON.stringify({'telegram.approval_texts':'rule_note: 👥 '+'made-up note '.repeat(300)})]);
    const crowded=await ask(await message('crowded'),'browser',{url:'https://weather.example.com/crowded'});
    assert.deepEqual(choices(crowded.card),['na','nd']);assert.doesNotMatch(crowded.card.text,/made-up note/);
    await stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',[JSON.stringify({'telegram.approval_texts':'rule_note: 👥 Made-up note: this rule covers everyone there.'})]);
    const edited=await ask(await message('edited'),'browser',{url:'https://weather.example.com/edited'});
    assert.ok(edited.card.text.endsWith('\n\n👥 Made-up note: this rule covers everyone there.'));assert.deepEqual(choices(edited.card),['na','nc','nw','nd']);
    // The asker's summary is left out before the note is: a card that fits with its summary, but not with the note too, drops it.
    await stores.control.query(`UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton`);
    const said='Read the made-up weather page for the coming week. '.repeat(9).trim();
    const summed=await ask(await message('summed'),'browser',{url:'https://weather.example.com/summed'},said);
    assert.match(summed.card.text,/📝 Read the made-up weather/);assert.ok(summed.card.text.endsWith(ruleNote));
    const longNote='made-up note '.repeat(400).slice(0,4096-300-(summed.card.text.length-ruleNote.length)+40);
    await stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',[JSON.stringify({'telegram.approval_texts':'rule_note: 👥 '+longNote})]);
    const dropped=await ask(await message('dropped'),'browser',{url:'https://weather.example.com/droppd'},said);
    assert.doesNotMatch(dropped.card.text,/📝/);assert.ok(dropped.card.text.endsWith(longNote.trim()));assert.deepEqual(choices(dropped.card),['na','nc','nw','nd']);
    // A note that would not fit even without the summary takes nothing from the card: it keeps its summary and offers no rule.
    await stores.control.query('UPDATE owner_prompts SET texts=$1::jsonb WHERE singleton',[JSON.stringify({'telegram.approval_texts':'rule_note: 👥 '+'made-up note '.repeat(300)})]);
    const kept=await ask(await message('kept'),'browser',{url:'https://weather.example.com/kept'},said);
    assert.match(kept.card.text,/📝 Read the made-up weather/);assert.doesNotMatch(kept.card.text,/made-up note/);assert.deepEqual(choices(kept.card),['na','nd']);
    await stores.control.query(`UPDATE owner_prompts SET texts='{}'::jsonb WHERE singleton`);
    // A dashboard run for the group has no Telegram message to point to; its card still names the chat a rule would cover.
    const dashboardRun=(await s.capture.capture({version:1,key:JSON.stringify(['browser',group,'made-up-profile','made-up-run',key]),channel:'browser',origin:'live',
      kind:'browser_input',bot_id:'',scope:group,source_id:'made-up-run',revision:'0',occurred_at:null,text:'Please check dashboard',
      payload:{profile:'made-up-profile',space:group,revision:0,conversation_id:'made-up-run',attachments:[],submission:'composer',display:'Please check dashboard'},
      source:{version:1,adapter:'nocheh.browser',adapter_version:'2',object:{platform:'browser',namespace:JSON.stringify([group,'made-up-profile','made-up-run']),
        kind:'message',external_id:'made-up-run'},operation:'create',completeness:'full',
        relations:[{kind:'contained_in',target:{platform:'browser',namespace:JSON.stringify([group,'made-up-profile']),kind:'conversation',external_id:'made-up-run'}}],
        metadata:{audience:{chat_id:group,topic_state:'none'}},provenance:{capture:'owner_browser_submission'}}})).source.reference;
    await s.guards.prepare(dashboardRun,'fixture',s.detect);
    const dashboard=await ask(dashboardRun,'browser',{url:'https://weather.example.com/dashboard'});
    assert.match(dashboard.card.text,/💬 Asked in a Telegram group › General\n/);assert.ok(dashboard.card.text.endsWith(ruleNote));
    assert.deepEqual(choices(dashboard.card),['na','nc','nw','nd']);
  }finally{await stores.close();await rm(root,{recursive:true,force:true});}
});
