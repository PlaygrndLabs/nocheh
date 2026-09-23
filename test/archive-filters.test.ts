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
