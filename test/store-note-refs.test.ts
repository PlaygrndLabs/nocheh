import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import type {AssistantPolicy} from '../src/assistant-policy.js';
import {honchoEngine} from '../src/memory/honcho.js';
import type {SourceReference} from '../src/stores/archive.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {noteRef} from '../src/stores/note-sources.js';
import {readSet} from '../src/spaces.js';
import {fixtureServices} from './fixture-agent.js';

/**
 * A note's day and ref (ADR-0261 B3.3, B3.6): its label names the day in the reader's zone, and in the turn whose lookup
 * showed it, its ref opens the messages it was written from, each through canRead, for seven days.
 */
test('a note names its day in the reader\'s zone and its ref opens only what this reader may read, in its turn, for seven days',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:300000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-note-refs-'));
  // Synthetic groups GP1 (A) and GP2 (B). The owner is account 123.
  const run=Date.now(),A='-100'+run,B='-100'+(run+1),key='note-refs:'+run;
  const policy:AssistantPolicy={enabled:true,owner_id:'123',owner_chat:'123',group_ids:[A,B],topic_memory:'group'};
  const s=fixtureServices(stores,{dataDir:root,detectorVersion:'fixture',policy:()=>policy,
    runtime:async()=>({literals:[]}),memoryEngine:honchoEngine(async()=>{throw Error('no provider');})});
  const zone=(await stores.control.query('SELECT settings FROM owner_task_settings WHERE singleton')).rows[0]?.settings??{};
  try {
    await s.guards.reconcile();await s.guards.setMode('on');
    let serial=0;
    const capture=async(scope:string,message:Record<string,any>):Promise<SourceReference>=>{
      const update=++serial;
      const value={version:1,key:`${key}:${update}`,origin:'live',kind:'telegram_update',bot_id:'123456',scope,source_id:String(message.message_id),
        revision:String(update),occurred_at:String(message.date),text:message.text??null,payload:{update_id:update,message}} as Envelope;
      const source=(await s.capture.capture(value)).source.reference;await s.guards.prepare(source,'fixture',s.detect);return source;
    };
    // 2025-11-03 14:12 UTC; late is 23:30 UTC, already 4 November in Berlin.
    const T=1762179120,late=Date.UTC(2025,10,3,23,30)/1000;
    const bob={id:456,is_bot:false,first_name:'Bob'},sam={id:123,is_bot:false,first_name:'Sam'};
    const GP1={id:Number(A),type:'supergroup',title:'GP1'},GP2={id:Number(B),type:'supergroup',title:'GP2'};
    const bob1=await capture(A,{message_id:1,date:T,chat:GP1,from:bob,text:'Bob plan in GP1'});
    const bob2=await capture(A,{message_id:2,date:T+60,chat:GP1,from:bob,text:'Bob detail in GP1'});
    const bobB=await capture(B,{message_id:1,date:T,chat:GP2,from:bob,text:'Bob in GP2'});
    const ownerPrivate=await capture('123',{message_id:1,date:T,chat:{id:123,type:'private',first_name:'Sam'},from:sam,text:'Owner private words'});
    await stores.control.query(`UPDATE owner_task_settings SET settings=jsonb_set(settings,'{time_zone}','"Europe/Berlin"') WHERE singleton`);

    // A review whose batch holds a GP2 message, the owner's private one and two of GP1's: GP1 opens only its own.
    const review=digest(key+':review');
    await stores.control.query(`INSERT INTO native_review_jobs(id,source_reference,input_reference,binding,provenance) VALUES($1,$2,$2,'{}'::jsonb,$3)`,
      [review,JSON.stringify(bob1),JSON.stringify({version:1,source:bobB.id,events:[bobB,ownerPrivate,bob1,bob2].map(item=>({id:item.id,class:'person_message'})),
        owner_account_only:false,rules:'none',rule_buckets:[],left_out:{sender_not_allowed:0,rule_sender_not_allowed:0,rules_left_out_for_owner_label:0,quote_not_traced:0}})]);
    const turn=(event:string,timed:boolean)=>({by:'turn',event,channel:'telegram',at:'2025-11-03',...timed?{at_time:late}:{},reads:[],complete:true});
    const notes={review:{key:digest(key+':n1'),origins:[{by:'review',review}],more:0,cites:[]},
      timed:{key:digest(key+':n2'),origins:[turn(bob1.id,true)],more:0,cites:[]},old:{key:digest(key+':n3'),origins:[turn(bob1.id,false)],more:0,cites:[]}};
    const body=(space:string,turnEvent?:string)=>({notes:Object.values(notes),space,...turnEvent?{turn_event:turnEvent}:{}});

    // GP1's turn: days in UTC, the old note's marked so; each note gets its ref.
    const group=(await s.noteSources.lookup(body(A,bob1.id))).labels;
    const answered=', after reading the message it answered (another person\'s)';
    assert.equal(group[notes.timed.key]!.label,'Nocheh\'s note from group “GP1” on 2025-11-03'+answered);
    assert.equal(group[notes.old.key]!.label,'Nocheh\'s note from group “GP1” on 2025-11-03 UTC'+answered);
    assert.match(group[notes.review.key]!.label,/^Nocheh's notes review on 2025-11-03 of another person's message /);
    for(const note of Object.values(notes))assert.equal(group[note.key]!.ref,noteRef(note.key));
    assert.equal(noteRef(notes.review.key),notes.review.key.slice(0,12));
    // Without a turn there are no refs, and none is kept.
    assert.ok(Object.values((await s.noteSources.lookup(body(A))).labels).every(label=>!('ref' in label)));
    // Refs that can't be kept leave the labels without them, counted as `note_refs`, never as a note labels failure.
    const kinds=async()=>Object.fromEntries((await stores.control.query(`SELECT kind,failed FROM memory_problem_days
      WHERE kind IN ('notes','note_refs') AND day=(now() AT TIME ZONE 'UTC')::date`)).rows.map(row=>[row.kind,row.failed]));
    const counted=await kinds();
    const control=s.noteSources.stores.control as any,query=control.query;
    control.query=(text:unknown,...rest:unknown[])=>String(text).includes('INSERT INTO note_lookups')?Promise.reject(Error('disk full')):query.call(control,text,...rest);
    let unkept;
    try{unkept=(await s.noteSources.lookup(body(A,bob2.id))).labels;}finally{delete control.query;if(control.query!==query)control.query=query;}
    assert.equal(unkept[notes.timed.key]!.label,group[notes.timed.key]!.label);
    assert.ok(Object.values(unkept).every(label=>!('ref' in label)));
    assert.deepEqual(await kinds(),{...counted,note_refs:(counted.note_refs??0)+1});
    // The owner's turn: the owner's Tasks zone.
    const owned=(await s.noteSources.lookup(body('123',ownerPrivate.id))).labels;
    assert.equal(owned[notes.timed.key]!.label,'Nocheh\'s note from the owner\'s private chat on 2025-11-04'+answered);
    assert.equal(owned[notes.old.key]!.label,'Nocheh\'s note from the owner\'s private chat on 2025-11-03 UTC'+answered,'an old note keeps its UTC day');

    let binding=await s.guards.state();
    const reader=(scope:string|null,space:string,turnEvent:string,extra:Partial<Reader>={}):Reader=>
      ({admin:false,scope,space,turnEvent,generation:binding.generation,guard_epoch:binding.epoch,...extra});
    const general=reader(A,A,bob1.id),owner=reader(null,'123',ownerPrivate.id);
    // GP1 opens its own two messages only: never GP2's, never the owner's private chat, and no count of them.
    const opened=await s.sources.noteEntry(general,noteRef(notes.review.key)) as any;
    assert.deepEqual(opened.sources.map((item:any)=>item.source),[bob1,bob2].map(item=>'nocheh:event:'+item.id));
    assert.deepEqual([opened.sources[0].tag,opened.sources[0].by,opened.more],['“Bob” · this chat · 2025-11-03 14:12 UTC','person',undefined]);
    assert.ok(!JSON.stringify(opened).includes(bobB.id)&&!JSON.stringify(opened).includes(ownerPrivate.id)&&!JSON.stringify(opened).includes('GP2'));
    assert.deepEqual((await s.sources.noteEntry(general,noteRef(notes.timed.key)) as any).sources.map((item:any)=>item.source),['nocheh:event:'+bob1.id],
      'a turn\'s note opens the message the turn answered');
    // The owner's own turn opens all four, in the Tasks zone.
    const all=await s.sources.noteEntry(owner,noteRef(notes.review.key)) as any;
    assert.equal(all.sources.length,4);assert.equal(all.sources[2].tag,'“Bob” · group “GP1” · 2025-11-03 15:12 Europe/Berlin');
    // A failed access check opens none of them, never a placeholder for a message nobody checked, and is counted.
    const access=s.tags.access as any,readable=access.readable,count=async()=>(await stores.control.query(
      "SELECT coalesce(sum(failed),0)::int AS failed FROM memory_problem_days WHERE kind='source_tags' AND day=(now() AT TIME ZONE 'UTC')::date")).rows[0].failed;
    const before=await count();
    access.readable=async()=>{throw new Error('connection reset');};
    try {
      const failed=await s.sources.noteEntry(general,noteRef(notes.review.key)) as any;
      assert.deepEqual([failed.sources,failed.more],[[],undefined]);
      assert.ok(!JSON.stringify(failed).includes(ownerPrivate.id)&&!JSON.stringify(failed).includes(bobB.id));
    } finally {access.readable=readable;}
    assert.equal(await count(),before+1);
    // A ref opens only in the turn whose lookup showed it, never for a private answer, and an unknown ref opens nothing.
    await assert.rejects(s.sources.noteEntry(reader(B,B,bobB.id),noteRef(notes.review.key)),{code:'note_not_found'});
    await assert.rejects(s.sources.noteEntry(reader(A,A,bob2.id),noteRef(notes.review.key)),{code:'note_not_found'});
    await assert.rejects(s.sources.noteEntry(general,'0'.repeat(12)),{code:'note_not_found'});
    await assert.rejects(s.sources.noteEntry(reader(A,A,bob1.id,{answer:digest('answer')}),noteRef(notes.review.key)),{code:'scoped_turn_required'});
    // Nor for a member's private chat or the owner's ask about a member (ADR-0262): neither keeps notes, and the ask shares
    // its turn's message with the owner's asking turn, whose refs open the owner's private words.
    await assert.rejects(s.sources.noteEntry(reader('123','123',ownerPrivate.id,{memberRead:'c'.repeat(32),reads:readSet({home:'123'}),memberChat:'4567'}),
      noteRef(notes.review.key)),{code:'scoped_turn_required'});
    await assert.rejects(s.sources.noteEntry(reader('4567','4567',bob1.id,{member:'d'.repeat(64),reads:readSet({home:'4567',whole:[A]}),memberChat:'4567'}),
      noteRef(notes.review.key)),{code:'scoped_turn_required'});
    // A retired message is no longer opened.
    await s.retirements.set({admin:true,scope:null},bob2.id,{retired:true,expected_revision:0,operation_id:key+':retire'});
    binding=await s.guards.state();
    assert.deepEqual((await s.sources.noteEntry(reader(A,A,bob1.id),noteRef(notes.review.key)) as any).sources.map((item:any)=>item.source),['nocheh:event:'+bob1.id]);

    // Refs expire after seven days, and the next lookup drops what expired.
    await stores.control.query(`UPDATE note_lookups SET created_at=now()-interval '8 days' WHERE turn_event=$1`,[bob1.id]);
    await assert.rejects(s.sources.noteEntry(reader(A,A,bob1.id),noteRef(notes.review.key)),{code:'note_not_found'});
    await s.noteSources.lookup(body('123',ownerPrivate.id));
    assert.equal((await stores.control.query('SELECT count(*)::int AS count FROM note_lookups WHERE turn_event=$1',[bob1.id])).rows[0].count,0);

    // The owner's recall: each note hit names its day in the Tasks zone and up to three of its sources, tagged; the
    // retired one is gone.
    binding=await s.guards.state();
    const recaller=reader(null,'123',ownerPrivate.id);
    const tag=async(ids:string[])=>s.tags.checked(recaller,binding,[...(await s.access.archive.capturedMany(ids)).values()].map(item=>item.reference));
    const recalled=await s.noteSources.withRecallSources({hits:[{kind:'native_note',space:A,text:'plan',note:notes.review},
      {kind:'native_note',space:A,text:'plan',note:notes.timed}]},tag) as any;
    assert.deepEqual(recalled.hits.map((hit:any)=>hit.day),['2025-11-03','2025-11-04']);
    assert.deepEqual(recalled.hits[0].sources.map((item:any)=>item.source),[bobB,ownerPrivate,bob1].map(item=>'nocheh:event:'+item.id));
    assert.deepEqual(recalled.hits[1].sources,[{source:'nocheh:event:'+bob1.id,tag:'“Bob” · group “GP1” · 2025-11-03 15:12 Europe/Berlin',by:'person'}]);
    // A failed check names none of them, the retired one included.
    access.readable=async()=>{throw new Error('connection reset');};
    try {
      const failed=await s.noteSources.withRecallSources({hits:[{kind:'native_note',space:A,text:'plan',note:notes.review}]},tag) as any;
      assert.deepEqual(failed.hits[0].sources,[]);
    } finally {access.readable=readable;}
    // A tagger that throws leaves the hits without sources and is counted.
    const thrown=await count();
    assert.deepEqual((await s.noteSources.withRecallSources({hits:[{kind:'native_note',space:A,text:'plan',note:notes.review}]},
      async()=>{throw new Error('captured');}) as any).hits[0].sources,[]);
    assert.equal(await count(),thrown+1);
  } finally {
    await stores.control.query('UPDATE owner_task_settings SET settings=$1 WHERE singleton',[JSON.stringify(zone)]).catch(()=>{});
    await Promise.all([stores.archive.end(),stores.derived.end(),stores.control.end()]);await rm(root,{recursive:true,force:true});
  }
});
