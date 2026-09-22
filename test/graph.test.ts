import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {settings} from '../src/config.js';
import {initialize} from '../src/database.js';
import {ingest,digest,type Envelope} from '../src/archive.js';
import {evidenceGraph} from '../src/graph.js';

test('real PostgreSQL: graph contains only scoped context entities and recorded message relationships', {skip:!process.env.PGHOST}, async()=>{
  const config=settings(),connection={host:process.env.PGHOST,user:'nocheh',database:'nocheh',password:config.databasePassword};
  const admin=new pg.Pool(connection),namespace='graph_'+Date.now();await admin.query(`CREATE SCHEMA ${namespace}`);
  const pool=new pg.Pool({...connection,options:`-c search_path=${namespace}`});
  const event=(key:string,source:string,scope='-20',reply?:number):Envelope=>({version:1,key,source_id:source,scope,revision:key,bot_id:'fixture',kind:'telegram_update',origin:'import',occurred_at:null,text:'source '+key,
    payload:{message:{message_id:Number(source),chat:scope==='42'?{id:42,type:'private'}:{id:Number(scope),type:'supergroup',title:'Observatory team'},from:{id:42,username:'mira_sky'},...(reply?{reply_to_message:{message_id:reply}}:{})}}});
  try{
    await initialize(pool);
    for(const e of [event('first','1'),event('edit','1'),event('reply','2','-20',1),event('private','1','42'),event('unresolved','3','-20',99)])await ingest(pool,e,false);
    const artifact=digest('file');await pool.query("INSERT INTO artifacts(id,event_id,kind,source_ref) VALUES($1,$2,'voice','fixture')",[artifact,digest('first')]);
    await pool.query("INSERT INTO derived_artifacts(id,event_id,artifact_id,kind,content,provenance) VALUES('transcript',$1,$2,'transcript',$3,$4)",[digest('first'),artifact,Buffer.from('derived'),{model:'fixture',source_sha256:'proof'}]);
    const graph=await evidenceGraph(pool,{scope:'-20',admin:false},'-20');
    const ids=new Set(graph.nodes.map(n=>n.id));
    assert.ok(!JSON.stringify(graph).includes(digest('private')));
    assert.ok(graph.edges.every(e=>ids.has(e.from)&&ids.has(e.to)));
    assert.equal(graph.edges.filter(e=>e.kind==='reply_to_source').length,2);
    assert.equal(graph.edges.filter(e=>e.kind==='same_source_revision').length,1);
    assert.deepEqual([...new Set(graph.nodes.map(n=>n.kind))].sort(),['group','message','user']);
    assert.ok(graph.nodes.some(n=>n.kind==='group'&&n.label==='Observatory team'));
    assert.ok(graph.nodes.some(n=>n.kind==='group'&&n.chat_type==='supergroup'));
    assert.ok(graph.nodes.some(n=>n.kind==='user'&&n.label==='@mira_sky'));
    assert.ok(!JSON.stringify(graph).includes('transcript'));
    assert.equal(graph.unresolved_replies,1);
    await assert.rejects(evidenceGraph(pool,{scope:'-30',admin:false},'-20'),{code:'graph_scope_denied'});
    const first=await evidenceGraph(pool,{scope:null,admin:true},'-20','',2);assert.ok(first.next);
    const second=await evidenceGraph(pool,{scope:null,admin:true},'-20',first.next!,2);
    assert.equal(second.next,null);assert.equal(new Set([...first.nodes,...second.nodes].filter(n=>n.kind==='message').map(n=>n.id)).size,4);
    const desktop=(key:string,chat:number)=>({...event(key,'1'),bot_id:'desktop-export',payload:{chat:{id:chat,type:'private_group'},message:{id:1}}});
    await ingest(pool,desktop('desktop-a',100),false);await ingest(pool,desktop('desktop-b',200),false);
    const mapped=await evidenceGraph(pool,{scope:null,admin:true},'-20');
    assert.equal(mapped.edges.filter(e=>e.kind==='same_source_revision').length,1,'mapped exports from different original chats never share a source identity');
    const focus=await evidenceGraph(pool,{scope:null,admin:true},'-20','',20,digest('private'));assert.equal(focus.nodes.length,1);
    const all=await evidenceGraph(pool,{scope:null,admin:true},'*');
    assert.ok(all.nodes.some(n=>n.id==='message:'+digest('private')));
    assert.ok(all.nodes.some(n=>n.id==='group:42'&&n.chat_type==='private'&&n.label==='Private chat · 42'));
    assert.equal(all.edges.filter(e=>e.kind==='reply_to_source').length,2,'cross-chat source numbers do not create false reply links');
    await assert.rejects(evidenceGraph(pool,{scope:'-20',admin:false},'*'),{code:'graph_scope_denied'});
  }finally{await pool.end();await admin.query(`DROP SCHEMA ${namespace} CASCADE`);await admin.end();}
});
