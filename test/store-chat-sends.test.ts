import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {canonical,digest,type Envelope} from '../src/archive.js';
import type {Reader} from '../src/access.js';
import {connectStores,initializeStoreDatabases} from '../src/stores/connections.js';
import {ArchiveRepository} from '../src/stores/archive.js';
import {ChatSendRepository,chatSend,journalRetentionDays,type ChatSend} from '../src/stores/chat-sends.js';

const record=(fields:Partial<ChatSend>={}):ChatSend=>({version:1,key:'send:telegram:4242:'+randomUUID().replace(/-/g,''),channel:'telegram',account:'4242',
  at:new Date().toISOString(),kind:'reply',method:'sendMessage',chat:'-1001234',topic:null,message_id:7,detail:null,state:'sent',status:200,
  error_code:null,reference:'telegram:4242:update:1',ms:120,...fields});

test('a send record has a closed, content-free shape',()=>{
  const valid=record();
  assert.deepEqual(chatSend(valid),valid);
  assert.deepEqual(chatSend(JSON.parse(canonical(valid))),valid,'canonical JSON reads back the same');
  const {account,topic,detail,...required}=valid;void account;void topic;void detail;
  assert.equal(chatSend({...required,account:'4242'})?.topic,null,'an absent nullable field reads as null');
  const reaction=record({kind:'reaction',method:'setMessageReaction',detail:'👀',reference:null});
  assert.equal(chatSend(reaction)?.detail,'👀');assert.equal(chatSend({...reaction,detail:'clear'})?.detail,'clear');
  const failed=record({state:'failed',status:400,error_code:'reaction_not_allowed'});assert.ok(chatSend(failed));
  for(const [why,value] of Object.entries({
    'a text field':{...valid,text:'Synthetic message text'},'an unknown field':{...valid,description:'Bad Request: chat not found'},
    'a missing state':(({state,...rest})=>{void state;return rest;})(valid),'another version':{...valid,version:2},
    'a key of another account':{...valid,key:'send:telegram:999:'+'a'.repeat(32)},'a key with text':{...valid,key:'send:telegram:4242:hello'},
    'a key of another channel':{...valid,key:'send:slack:4242:'+'a'.repeat(32)},'an upper-case channel':{...valid,channel:'Telegram'},
    'a time without milliseconds':{...valid,at:'2026-11-11T18:45:35Z'},'an impossible time':{...valid,at:'2026-02-30T18:45:35.000Z'},
    'a local time':{...valid,at:'2026-11-11T18:45:35.123+01:00'},'an unknown kind':{...valid,kind:'message'},'an unknown state':{...valid,state:'done'},
    'a method with spaces':{...valid,method:'send message'},'a chat name':{...valid,chat:'Team chat'},'a numeric chat':{...valid,chat:-1001234},
    'a fractional message id':{...valid,message_id:1.5},'a string topic':{...valid,topic:'7'},'detail on a reply':{...valid,detail:'👀'},
    'a reaction with words':{...reaction,detail:'looks good'},'a long reaction':{...reaction,detail:'👀'.repeat(17)},
    'a sent record with a code':{...valid,error_code:'rejected'},'an error description':{...failed,error_code:'Bad Request: chat not found'},
    'a status past 999':{...valid,status:1000},'a string status':{...valid,status:'200'},'a reference with text':{...valid,reference:'notice: your task is due'},
    'a long reference':{...valid,reference:'a'.repeat(301)},'a negative duration':{...valid,ms:-1},'an array':[valid],
  }))assert.equal(chatSend(value),null,why);
  assert.equal(journalRetentionDays(''),0);assert.equal(journalRetentionDays(' 30 '),30);assert.equal(journalRetentionDays('3650'),3650);
  for(const value of ['-1','3651','1.5','x'])assert.throws(()=>journalRetentionDays(value),/invalid_journal_retention/);
});

test('send records drain once from the spool, list newest first with chat names, sum problems for Health and expire',
 {skip:process.env.NOCHEH_STORES_FIXTURE!=='1',timeout:180000},async()=>{
  const config:pg.PoolConfig={host:process.env.PGHOST!,user:'nocheh',database:'nocheh',password:process.env.PGPASSWORD!};
  const check=new pg.Client(config);await check.connect();try{assert.equal((await check.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,'nocheh-stores-fixture');}finally{await check.end();}
  const passwords={archive:digest('archive-fixture'),derived:digest('derived-fixture'),control:digest('control-fixture')};await initializeStoreDatabases(config,passwords);
  const stores=connectStores(config,passwords),root=await mkdtemp(join(tmpdir(),'nocheh-chat-sends-')),spool=join(root,'spool','sends');
  const sends=new ChatSendRepository(stores.control,stores.archive),owner:Reader={admin:true,scope:null};
  const write=async(value:unknown,name=digest((value as ChatSend).key)+'.json')=>{await mkdir(spool,{recursive:true});await writeFile(join(spool,name),canonical(value));return name;};
  const count=async()=>(await stores.control.query('SELECT count(*)::int AS count FROM chat_sends')).rows[0].count as number;
  try {
    assert.deepEqual(await sends.drain(root),{recorded:0,rejected:0},'no spool directory is nothing to do');
    assert.deepEqual(await sends.summary(),{window_hours:24,sent:0,failed:0,uncertain:0,not_sent:0,problems:0,problem_kinds:{},last_problem_at:null,latest_problems:[]});

    // Drain: valid records enter once; anything that can never become valid is removed without a row.
    const first=record(),second=record({kind:'reaction',method:'setMessageReaction',detail:'👍',reference:null,message_id:9});
    const firstName=await write(first);await write(second);
    await write({...record(),text:'Synthetic message text'});await write(record(),'0'.repeat(64)+'.json');
    await writeFile(join(spool,'f'.repeat(64)+'.json'),'{not json');await writeFile(join(spool,'.pending.tmp'),'{}');
    assert.deepEqual(await sends.drain(root),{recorded:2,rejected:3});
    assert.deepEqual((await readdir(spool)).sort(),['.pending.tmp'],'inserted and invalid files are removed; other names are left alone');
    assert.equal(await count(),2);
    const saved=(await stores.control.query('SELECT * FROM chat_sends WHERE record_key=$1',[second.key])).rows[0];
    assert.equal(saved.detail,'👍');assert.equal(saved.account,'4242');assert.equal(saved.at.toISOString(),second.at);
    // A repeat of the same file, as after a crash between insert and unlink, adds nothing.
    assert.equal(await write(first),firstName);
    assert.deepEqual(await sends.drain(root),{recorded:0,rejected:0});assert.equal(await count(),2);assert.deepEqual(await readdir(spool),['.pending.tmp']);
    // A database outage keeps valid records for the next pass and still drops invalid ones.
    const down=new Proxy(stores.control,{get(target,key){
      const value=Reflect.get(target,key);return key==='query'?async()=>{throw Error('fixture database outage');}:typeof value==='function'?value.bind(target):value;
    }});
    const waiting=record({state:'uncertain',status:0,error_code:'timed_out'}),waitingName=await write(waiting);await write({...record(),version:2});
    await assert.rejects(new ChatSendRepository(down).drain(root),/fixture database outage/);
    assert.deepEqual((await readdir(spool)).sort(),['.pending.tmp',waitingName]);
    assert.deepEqual(await sends.drain(root),{recorded:1,rejected:0});assert.equal(await count(),3);
    await stores.control.query('DELETE FROM chat_sends');

    // Health: the last day's counts; harmless codes are listed but never problems.
    const now=Date.now(),ago=(minutes:number)=>new Date(now-minutes*60000).toISOString(),group='-100'+(now%1000000000),other='-100'+(now%1000000000+1);
    const rows=[
      record({at:ago(60*24*30),state:'failed',status:403,error_code:'bot_blocked',chat:'123'}),
      record({at:ago(50),chat:group}),record({at:ago(40),chat:group,topic:7}),
      record({at:ago(30),kind:'reaction',method:'setMessageReaction',detail:'👀',state:'failed',status:400,error_code:'reaction_not_allowed',chat:group,reference:null}),
      record({at:ago(25),kind:'card_update',method:'editMessageText',state:'failed',status:400,error_code:'message_not_modified',chat:other}),
      record({at:ago(20),kind:'button_answer',method:'answerCallbackQuery',state:'failed',status:400,error_code:'button_answer_expired',chat:null,message_id:null}),
      record({at:ago(15),state:'not_sent',status:0,error_code:'rate_limited',chat:other}),
      record({at:ago(10),state:'uncertain',status:0,error_code:'timed_out',chat:other,message_id:null}),
      record({at:ago(5),kind:'typing',method:'sendChatAction',state:'uncertain',status:502,error_code:'server_error',chat:'123',message_id:null,reference:null}),
    ];
    for(const value of rows)await write(value);
    assert.deepEqual(await sends.drain(root,4),{recorded:4,rejected:0},'one pass takes at most its limit');
    assert.deepEqual(await sends.drain(root),{recorded:rows.length-4,rejected:0});
    // Names: a refreshed title, and a captured message's title wins over it; a chat Nocheh never saw stays unnamed.
    await stores.control.query(`INSERT INTO telegram_chat_observations(chat_id,state,chat_type,title) VALUES($1,'available','supergroup','Refreshed name'),
      ($2,'available','supergroup','Other group')`,[group,other]);
    const event:Envelope={version:1,key:'chat-sends:'+now,origin:'live',kind:'telegram_update',bot_id:'4242',scope:group,source_id:'1',revision:'1',occurred_at:null,
      text:'Synthetic',payload:{update_id:1,message:{message_id:1,date:1,chat:{id:Number(group),type:'supergroup',title:'Captured name'},from:{id:123},text:'Synthetic'}}};
    await new ArchiveRepository(stores.archive).capture(event);
    const summary=await sends.summary(new Date(now));
    assert.deepEqual({...summary,latest_problems:undefined},{window_hours:24,sent:2,failed:3,uncertain:2,not_sent:1,problems:3,
      problem_kinds:{reaction:1,reply:1,typing:1},last_problem_at:ago(5),latest_problems:undefined});
    assert.deepEqual(summary.latest_problems.map(row=>[row.kind,row.error_code,row.chat_title]),
      [['typing','server_error',null],['reply','timed_out','Other group'],['reaction','reaction_not_allowed','Captured name']]);
    const reaction=summary.latest_problems[2]!;
    assert.deepEqual(Object.keys(reaction),['id','at','channel','kind','method','chat','chat_title','topic','message_id','detail','state','status','error_code','reference','ms']);
    assert.equal(typeof reaction.id,'string');assert.equal(reaction.detail,'👀');assert.equal(reaction.message_id,7);assert.equal(reaction.at,ago(30));
    assert.equal(JSON.stringify(summary).includes('Synthetic'),false,'no message content reaches Health');
    // The newest problem of any age, even with none in the last day.
    const later=await sends.summary(new Date(now+86400000*2));
    assert.equal(later.problems,0);assert.deepEqual(later.latest_problems,[]);assert.equal(later.last_problem_at,ago(5));

    // The owner's list: newest first, paged by id, filtered to problems or one kind.
    const all:any[]=[];let before='';
    for(;;){const page=await sends.list(owner,{limit:4,before});all.push(...page.records);if(!page.next)break;assert.equal(page.records.length,4);before=page.next;}
    assert.deepEqual(all.map(row=>row.at),[...rows].map(row=>row.at).sort().reverse());
    assert.equal(new Set(all.map(row=>row.id)).size,rows.length);
    assert.equal(all.find(row=>row.topic===7)?.chat_title,'Captured name');
    const problems=await sends.list(owner,{filter:'problems'});
    assert.deepEqual(problems.records.map(row=>row.error_code),['server_error','timed_out','reaction_not_allowed','bot_blocked']);assert.equal(problems.next,null);
    const firstProblem=await sends.list(owner,{filter:'problems',limit:1}),nextProblem=await sends.list(owner,{filter:'problems',limit:1,before:firstProblem.next!});
    assert.deepEqual([firstProblem.records[0]!.error_code,nextProblem.records[0]!.error_code],['server_error','timed_out']);
    assert.deepEqual((await sends.list(owner,{kind:'card_update'})).records.map(row=>row.error_code),['message_not_modified']);
    assert.deepEqual((await sends.list(owner,{filter:'problems',kind:'card_update'})).records,[]);
    for(const query of [{filter:'failed'},{kind:'message'},{before:'abc'},{before:'0'},{limit:0},{limit:101}])
      await assert.rejects(sends.list(owner,query),{status:400,code:'invalid_chat_send_query'},JSON.stringify(query));
    await assert.rejects(sends.list({admin:false,scope:'123'}),{status:403});

    // Retention: only rows sent before the cutoff go; zero days keeps everything.
    assert.equal(await sends.expire(now,0),0);assert.equal(await count(),rows.length);
    assert.equal(await sends.expire(now,14),1);
    assert.deepEqual((await sends.list(owner,{filter:'problems'})).records.map(row=>row.error_code),['server_error','timed_out','reaction_not_allowed']);
    assert.equal(await sends.prune(new Date(Date.parse(ago(22)))),4);assert.equal(await sends.prune(new Date(Date.parse(ago(22)))),0,'a repeated pass is a no-op');
    assert.deepEqual((await sends.list(owner)).records.map(row=>row.at),[ago(5),ago(10),ago(15),ago(20)]);
    assert.equal(await sends.prune(new Date(now),2),2,'one batch is bounded');
  } finally {await stores.close();await rm(root,{recursive:true,force:true});}
});
