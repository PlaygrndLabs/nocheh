import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveFilters,matchesArchiveFilters,privateChatsParams} from '../src/archive-filters.js';

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
 * strangers') unless it asks for them under "Members' chats". Storage resolves which scopes those are from its chat rows
 * (otherPrivateScopes, store-member-messages); here the split itself, and that it shows nothing until they are resolved.
 */
test('private_chats splits other people\'s private chats from the owner\'s chat and the groups',async()=>{
 const {GP1,NG1_TG,OWNER,BOB,MEMBER_GP,MEMBER_NG,MEMBER_GP_OFF}=await import('./fixture-groups.js');
 const others=[MEMBER_GP,MEMBER_NG,MEMBER_GP_OFF,BOB];
 const hide={...archiveFilters(new URLSearchParams({private_chats:'hide'})),private_scopes:others};
 const only={...archiveFilters(new URLSearchParams({private_chats:'only'})),private_scopes:others};
 for(const scope of others) {
  assert.equal(matchesArchiveFilters({kind:'telegram_update',scope},undefined,hide),false,'hides '+scope);
  assert.equal(matchesArchiveFilters({kind:'telegram_delivered_message',scope},undefined,only),true,'keeps '+scope);
 }
 for(const scope of [OWNER,GP1,NG1_TG]) {
  assert.equal(matchesArchiveFilters({kind:'telegram_update',scope},undefined,hide),true,'keeps '+scope);
  assert.equal(matchesArchiveFilters({kind:'telegram_update',scope},undefined,only),false,'leaves out '+scope);
 }
 assert.deepEqual(privateChatsParams(hide),[others,false]);assert.deepEqual(privateChatsParams(only),[others,true]);
 // Without the filter nothing changes, and an unknown value is refused.
 assert.deepEqual(archiveFilters(new URLSearchParams({})),{kind:'',scope:'',reply:''});
 assert.deepEqual(privateChatsParams(archiveFilters(new URLSearchParams({}))),[null,false]);
 assert.equal(matchesArchiveFilters({kind:'telegram_update',scope:MEMBER_GP},undefined,archiveFilters(new URLSearchParams({}))),true);
 assert.throws(()=>archiveFilters(new URLSearchParams({private_chats:'members'})),{code:'invalid_archive_filter'});
});

test('until its chats are resolved, the split shows nothing either way',()=>{
 for(const split of ['hide','only']) {
  const filters=archiveFilters(new URLSearchParams({private_chats:split}));
  assert.equal(filters.private_scopes,undefined,'never read from this process\'s chat directory');
  for(const scope of ['701','123','-1001000000001'])assert.equal(matchesArchiveFilters({kind:'telegram_update',scope},undefined,filters),false,split+' '+scope);
  assert.deepEqual(privateChatsParams(filters),[[],true],'in SQL: matches no scope');
 }
});
