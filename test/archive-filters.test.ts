import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveFilters,matchesArchiveFilters} from '../src/archive-filters.js';

test('archive filters are explicit, bounded and distinguish retry from uncertain delivery',()=>{
 const filters=archiveFilters(new URLSearchParams({kind:'incoming',scope:'owner',reply:'failed'}));
 assert.deepEqual(filters,{kind:'incoming',scope:'owner',reply:'failed'});
 assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:'owner'},'failed',filters),true);
 assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:'owner'},'ambiguous',filters),false);
 assert.equal(matchesArchiveFilters({kind:'telegram_delivered_message',scope:'owner'},undefined,filters),false);
 assert.equal(matchesArchiveFilters({kind:'browser_input',scope:'owner'},'failed',filters),false,'Telegram reply state does not classify browser work');
 assert.throws(()=>archiveFilters(new URLSearchParams({reply:'review'})),{code:'invalid_archive_filter'});
});

test('not-started matches only incoming source messages without a dispatch state',()=>{
 const filters=archiveFilters(new URLSearchParams({reply:'not_started'}));
 assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:'owner'},undefined,filters),true);
 assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:'owner'},'pending',filters),false);
 assert.equal(matchesArchiveFilters({kind:'telegram_delivered_message',scope:'owner'},undefined,filters),false);
});

test('approval pending is based on a proposed action, even after a conversation reply was sent',()=>{
 const filters=archiveFilters(new URLSearchParams({reply:'approval_pending'}));
 assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:'owner'},'done',filters,'proposed'),true);
 assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:'owner'},'done',filters,'approved'),false);
 assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:'owner'},'done',filters),false);
 assert.equal(matchesArchiveFilters({kind:'telegram_delivered_message',scope:'owner'},'done',filters,'proposed'),false);
});

test('assistant direction includes confirmed replies from every supported source channel',()=>{
 const filters=archiveFilters(new URLSearchParams({kind:'assistant'}));
 assert.equal(matchesArchiveFilters({kind:'telegram_delivered_message',scope:'owner'},undefined,filters),true);
 assert.equal(matchesArchiveFilters({kind:'browser_delivered_message',scope:'owner'},undefined,filters),true);
 assert.equal(matchesArchiveFilters({kind:'browser_input',scope:'owner'},undefined,filters),false);
});

/*
 * Step 4: the dashboard's Messages list leaves out the private chats of people other than the owner (members' chats, and
 * strangers') unless it asks for them under "Members' chats". Both fixture families: an old-shaped chat keeps its stored
 * value as its id; a new one is named by its Telegram id through chat_ids.
 */
test('private_chats splits other people\'s private chats from the owner\'s chat and the groups',async()=>{
 const {installChatsForTest}=await import('../src/chats.js');
 const {fixtureDirectory,GP1,NG1_TG,NG_GROUP_IDS,OWNER,BOB,MEMBER_GP,MEMBER_NG,MEMBER_GP_OFF}=await import('./fixture-groups.js');
 for(const [family,groupScope] of [['GP',GP1],['NG',NG1_TG]] as const) {
  const restore=installChatsForTest(fixtureDirectory(family==='GP'?undefined:NG_GROUP_IDS));
  try {
   const others=[MEMBER_GP,MEMBER_NG,MEMBER_GP_OFF,BOB];
   const hide=archiveFilters(new URLSearchParams({private_chats:'hide'})),only=archiveFilters(new URLSearchParams({private_chats:'only'}));
   for(const scope of others) {
    assert.equal(matchesArchiveFilters({kind:'telegram_update',scope},undefined,hide),false,family+' hides '+scope);
    assert.equal(matchesArchiveFilters({kind:'telegram_delivered_message',scope},undefined,only),true,family+' keeps '+scope);
   }
   for(const scope of [OWNER,groupScope]) {
    assert.equal(matchesArchiveFilters({kind:'telegram_update',scope},undefined,hide),true,family+' keeps '+scope);
    assert.equal(matchesArchiveFilters({kind:'telegram_update',scope},undefined,only),false,family+' leaves out '+scope);
   }
   // Without the filter nothing changes, and an unknown value is refused.
   assert.deepEqual(archiveFilters(new URLSearchParams({})),{kind:'',scope:'',reply:''});
   assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:MEMBER_GP},undefined,archiveFilters(new URLSearchParams({}))),true);
   assert.throws(()=>archiveFilters(new URLSearchParams({private_chats:'members'})),{code:'invalid_archive_filter'});
  } finally {restore();}
 }
});

test('with no chat directory loaded, "only" shows nothing',()=>{
 const only=archiveFilters(new URLSearchParams({private_chats:'only'}));
 assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:'701'},undefined,only),false);
});
